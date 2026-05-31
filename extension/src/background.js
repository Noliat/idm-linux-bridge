// background.js — Service Worker MV3 v2.2
// Melhorias v2.1:
//   [1] downloads.onDeterminingFilename — intercepta antes do download começar no Chrome,
//       permite corrigir nome do arquivo antes que o navegador crie o item.
//   [2] webRequest blocking para Firefox — em MV2/Firefox o webRequest ainda suporta
//       blocking síncrono, que cancela a requisição antes de ela sair e redireciona
//       para o IDM. Detectado em runtime via IS_FIREFOX.
//   [3] Refatoração do fluxo de interceptação — onDeterminingFilename tem prioridade
//       sobre onCreated para evitar janela "Salvar como" piscando no Chrome.

const BRIDGE_URL  = "http://127.0.0.1:6969";
const CAPTURE_URL = `${BRIDGE_URL}/capture`;
const STATUS_URL  = `${BRIDGE_URL}/status`;
const COOKIES_URL = `${BRIDGE_URL}/cookies`;

// Detecta Firefox em runtime (MV3 no Firefox ainda expõe browser.runtime.getBrowserInfo)
// Usado para habilitar o caminho de webRequest blocking exclusivo do Firefox.
const IS_FIREFOX = typeof browser !== "undefined" &&
  typeof browser.runtime?.getBrowserInfo === "function";

// Lista única e completa — sincronizada com content.js
const VIDEO_SITES = new Set([
  "youtube.com","youtu.be","drive.google.com","hotmart.com",
  "udemy.com","coursera.org","dropbox.com","mega.nz",
  "twitch.tv","vimeo.com","dailymotion.com","facebook.com",
  "instagram.com","twitter.com","x.com","reddit.com","tiktok.com"
]);

const DL_EXTENSIONS = new Set([
  "mp4","mkv","avi","mov","wmv","flv","webm","m4v","3gp",
  "mp3","flac","wav","aac","ogg","m4a","opus","wma",
  "zip","rar","7z","gz","bz2","xz","zst","tar","iso","img",
  "pdf","doc","docx","xls","xlsx","ppt","pptx","epub","mobi",
  "exe","msi","deb","rpm","apk","dmg","pkg","torrent"
]);

const DL_MIME_EXACT = new Set([
  "application/octet-stream","application/zip",
  "application/x-rar-compressed","application/x-rar",
  "application/x-7z-compressed","application/pdf",
  "application/x-bittorrent","application/x-iso9660-image",
  "application/vnd.android.package-archive","application/x-msdownload",
  "application/x-msi","application/vnd.debian.binary-package",
  "application/x-rpm","application/gzip","application/x-tar",
  "application/x-xz","application/x-bzip2",
]);

const RESTRICTED_SCHEMES = [
  "chrome://","chrome-extension://","about:","data:","blob:","file://","devtools://"
];

// ─────────────────────────────────────────────────────────────
// Estado global
// ─────────────────────────────────────────────────────────────

let bridgeAvailable  = false;
let interceptEnabled = true;
let silentMode       = false;

// ─────────────────────────────────────────────────────────────
// Deduplicadores — dois contextos separados
//
// PROBLEMA ANTERIOR: um único isDuplicate() era usado tanto para
// deduplicar interceptação automática (onDeterminingFilename +
// onCreated) quanto para o clique manual do usuário no dropdown.
// Resultado: quando o player da página fazia fetch de um .mp4 ou
// .m3u8, onHeadersReceived registrava a URL no mapa. Quando o
// usuário clicava no item dentro dos 10s de TTL, isDuplicate()
// retornava true → clique silenciosamente descartado → sem ação.
//
// CORREÇÃO: dois mapas com responsabilidades distintas:
//   autoDedup  — deduplicar disparos automáticos (onDeterminingFilename
//                vs onCreated para o mesmo download do navegador).
//                TTL curto: 3s é suficiente para os dois eventos
//                chegarem com diferença de ~100ms.
//
//   userDedup  — deduplicar cliques duplos do usuário (debounce).
//                TTL muito curto: 1.5s. Só aplicado quando
//                msg.fromUser === true (clique explícito).
//                NÃO usado para interceptação automática.
// ─────────────────────────────────────────────────────────────

const autoDedup = new Map();
const userDedup = new Map();
const AUTO_TTL  = 3_000;   // 3s — janela entre onDeterminingFilename e onCreated
const USER_TTL  = 1_500;   // 1.5s — debounce de clique duplo do usuário

function isAutoDuplicate(url) {
  const now = Date.now();
  for (const [u, ts] of autoDedup)
    if (now - ts > AUTO_TTL) autoDedup.delete(u);
  if (autoDedup.has(url)) return true;
  autoDedup.set(url, now);
  return false;
}

function isUserDuplicate(url) {
  const now = Date.now();
  for (const [u, ts] of userDedup)
    if (now - ts > USER_TTL) userDedup.delete(u);
  if (userDedup.has(url)) return true;
  userDedup.set(url, now);
  return false;
}

// ─────────────────────────────────────────────────────────────
// safeSendMessage — evita "Receiving end does not exist"
// ─────────────────────────────────────────────────────────────

async function safeSendMessage(tabId, message) {
  if (!tabId || tabId < 0) return null;
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────
// ensureContentScript — injeta ambos os scripts se necessário
// ─────────────────────────────────────────────────────────────

async function ensureContentScript(tabId) {
  if (!tabId || tabId < 0) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || RESTRICTED_SCHEMES.some(s => tab.url.startsWith(s))) return false;

    // Ping para verificar se content.js já está ativo
    try { await chrome.tabs.sendMessage(tabId, { action: "ping" }); return true; } catch (_) {}

    // Injetar parser_m3u8.js antes do interceptor — expõe window.__idmM3u8Parser
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["src/parser_m3u8.js"], world: "MAIN"
    });
    // Depois injetar interceptor no mundo MAIN
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["src/interceptor.js"], world: "MAIN"
    });
    // Depois injetar content.js no mundo ISOLATED
    await chrome.scripting.executeScript({
      target: { tabId }, files: ["src/content.js"], world: "ISOLATED"
    });
    await new Promise(r => setTimeout(r, 200));
    return true;
  } catch (err) {
    console.log("[IDM Bridge] ensureContentScript falhou:", err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Inicialização
// ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  setupContextMenu();
  checkBridgeStatus();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  checkBridgeStatus();
});

// Alarm para checar o bridge a cada 30s (alarms funcionam mesmo com SW dormindo)
chrome.alarms.create("bridgeCheck", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "bridgeCheck") checkBridgeStatus();
});

// ─────────────────────────────────────────────────────────────
// MELHORIA 1 — downloads.onDeterminingFilename (Chrome)
//
// Este evento é disparado pelo Chrome *antes* de exibir a caixa
// "Salvar como" e *antes* de onCreated criar o item de download.
// É o ponto ideal de interceptação no Chrome porque:
//   - O nome do arquivo ainda pode ser sugerido pelo servidor via
//     Content-Disposition — mais confiável que extrair da URL.
//   - Cancelar aqui evita que a janela "Salvar como" apareça para
//     o usuário antes do IDM assumir o download.
//   - Retornar { cancel: true } do listener interrompe o download
//     completamente, deixando o IDM tratar.
//
// NOTA: Este evento NÃO existe no Firefox — a verificação
// "chrome.downloads.onDeterminingFilename" evita erros em FF.
// ─────────────────────────────────────────────────────────────

if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // Guard: extensão desabilitada ou bridge offline
    if (!interceptEnabled || !bridgeAvailable) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    // Ignorar URLs internas e esquemas não-HTTP
    if (!item.url ||
        item.url.startsWith("http://127.0.0.1") ||
        item.url.startsWith("https://127.0.0.1") ||
        item.url.startsWith("blob:")  ||
        item.url.startsWith("data:")) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    // Verificar se é um download que deve ser interceptado
    if (!shouldIntercept(item.url, item.mime || "")) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    // Deduplicar com autoDedup — evita que onCreated trate o mesmo
    // download que onDeterminingFilename já está processando.
    if (isAutoDuplicate(item.url)) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    // Cancelar o download do navegador e enviar ao IDM.
    // suggest() DEVE ser chamado para o Chrome não travar.
    // Retornar true sinaliza que a resposta será assíncrona.
    suggest({ cancel: true });

    // Determinar o melhor nome disponível:
    // o Content-Disposition já foi resolvido pelo Chrome neste ponto,
    // então item.filename é mais confiável que extrair da URL.
    let filename = item.filename
      ? item.filename.split("/").pop().split("\\").pop()
      : "";
    if (!filename || isPageFilename(filename))
      filename = extractFilenameFromUrl(item.url);
    if (filename && !hasDownloadExt(filename) && item.mime) {
      const ext = extByMime(item.mime);
      if (ext) filename += ext;
    }

    getCookiesForUrl(item.url).then(cookies =>
      captureDownload({
        url: item.url,
        filename,
        cookies,
        referrer: item.referrer || "",
        tabId: item.tabId ?? -1
      })
    );
  });
}

// ─────────────────────────────────────────────────────────────
// Interceptação complementar — downloads.onCreated
//
// Atua como fallback nos casos em que onDeterminingFilename
// não disparou (ex: download iniciado via fetch/XHR sem
// Content-Disposition, ou no Firefox onde o evento não existe).
// O deduplicador garante que downloads já tratados pelo
// onDeterminingFilename não sejam reenviados ao IDM.
// ─────────────────────────────────────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  if (!interceptEnabled || !bridgeAvailable) return;
  if (!item.url) return;
  if (item.url.startsWith("http://127.0.0.1") ||
      item.url.startsWith("https://127.0.0.1") ||
      item.url.startsWith("blob:") ||
      item.url.startsWith("data:")) return;

  // Se onDeterminingFilename já tratou este URL, isAutoDuplicate retorna true
  if (isAutoDuplicate(item.url)) return;
  if (!shouldIntercept(item.url, item.mime || "")) return;

  // Cancelar e apagar o item criado pelo navegador.
  // Verificar state antes de cancelar: quando onDeterminingFilename já
  // chamou suggest({cancel:true}), o item chega aqui com state "interrupted"
  // — tentar cancelar um item já interrompido gera o erro
  // "Download must be in progress". Nesse caso só apagar.
  if (item.state === "in_progress") {
    chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
  } else {
    chrome.downloads.erase({ id: item.id });
  }

  const cookies  = await getCookiesForUrl(item.url);
  const referrer = item.referrer || "";
  let filename   = item.filename ? item.filename.split("/").pop().split("\\").pop() : "";
  if (!filename || isPageFilename(filename)) filename = extractFilenameFromUrl(item.url);
  if (filename && !hasDownloadExt(filename) && item.mime) {
    const ext = extByMime(item.mime);
    if (ext) filename += ext;
  }

  await captureDownload({ url: item.url, filename, cookies, referrer });
});

// ─────────────────────────────────────────────────────────────
// MELHORIA 2 — webRequest blocking para Firefox
//
// No Firefox com MV3 (e MV2), webRequest ainda suporta
// blocking síncrono via "blocking" + "requestHeaders" no
// listener de onBeforeSendHeaders. Isso permite:
//   - Cancelar a requisição HTTP *antes* de ela sair,
//     eliminando qualquer round-trip desnecessário.
//   - Capturar os cabeçalhos de requisição originais
//     (User-Agent, Referer, Accept-Language) para repassar
//     ao IDM, melhorando a compatibilidade com CDNs.
//
// No Chrome MV3 o blocking foi removido — este bloco só é
// registrado quando IS_FIREFOX === true, detectado em runtime.
//
// Fluxo Firefox com blocking:
//   1. Usuário clica em link de download
//   2. onBeforeSendHeaders dispara de forma SÍNCRONA
//   3. Retornamos { cancel: true } — requisição bloqueada
//   4. captureDownload() envia ao IDM de forma assíncrona
//   5. IDM faz a requisição completa com todos os headers
// ─────────────────────────────────────────────────────────────

// Conjunto de URLs em processamento pelo Firefox blocking.
// Declarado no escopo do módulo para ser acessível tanto no listener
// onBeforeSendHeaders quanto no onHeadersReceived abaixo —
// evita que o mesmo URL seja tratado duas vezes no Firefox.
const blockingInProgress = new Set();

if (IS_FIREFOX) {

  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      // Guard: extensão desabilitada ou bridge offline
      if (!interceptEnabled || !bridgeAvailable) return {};

      // Ignorar requisições internas
      if (details.url.startsWith("http://127.0.0.1") ||
          details.url.startsWith("https://127.0.0.1")) return {};

      // Só interceptar main_frame e sub_frame (downloads diretos)
      // xmlhttprequest e outros tipos são tratados pelo interceptor.js
      if (!["main_frame", "sub_frame"].includes(details.type)) return {};

      // Verificar extensão/MIME a partir da URL
      if (!shouldIntercept(details.url, "")) return {};
      if (isAutoDuplicate(details.url)) return {};

      // Marcar como "sendo processado" para evitar duplicação
      // com o listener onHeadersReceived abaixo
      blockingInProgress.add(details.url);
      // Usar AUTO_TTL (3s) — tempo suficiente para onHeadersReceived
      // processar o mesmo URL sem re-interceptar.
      setTimeout(() => blockingInProgress.delete(details.url), AUTO_TTL);

      // Extrair cabeçalhos de requisição originais para repassar ao IDM.
      // Isso é o diferencial do Firefox blocking: temos os headers reais.
      const reqHeaders = {};
      if (details.requestHeaders) {
        for (const h of details.requestHeaders) {
          const name = h.name.toLowerCase();
          // Repassar apenas cabeçalhos relevantes para o IDM
          if (["referer","user-agent","accept-language",
               "accept","origin","range"].includes(name)) {
            reqHeaders[h.name] = h.value;
          }
        }
      }

      const filename = extractFilenameFromUrl(details.url);

      // Captura assíncrona — o { cancel: true } já bloqueia a requisição
      getCookiesForUrl(details.url).then(cookies =>
        captureDownload({
          url: details.url,
          filename,
          cookies,
          referrer: reqHeaders["Referer"] || reqHeaders["referer"] || "",
          tabId: details.tabId ?? -1,
          extraHeaders: reqHeaders
        })
      );

      // Cancelar a requisição original — IDM vai fazer a sua própria
      return { cancel: true };
    },
    { urls: ["<all_urls>"] },
    // "blocking" + "requestHeaders" são exclusivos do Firefox
    ["blocking", "requestHeaders"]
  );
}

// ─────────────────────────────────────────────────────────────
// Detecção complementar — webRequest.onHeadersReceived (leitura)
//
// Captura downloads iniciados por Content-Disposition:attachment
// que não foram detectados pelos listeners acima.
// Não-blocking em ambos Chrome e Firefox — usado como safety net.
// No Firefox, o blockingInProgress garante que URLs já tratados
// pelo blocking não entrem aqui novamente.
// ─────────────────────────────────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!interceptEnabled || !bridgeAvailable) return;
    if (details.type !== "main_frame") return;
    if (details.url.startsWith("http://127.0.0.1")) return;
    // No Firefox, ignorar URLs já tratadas pelo onBeforeSendHeaders blocking
    if (blockingInProgress.has(details.url)) return;

    const disp = getHeader(details.responseHeaders, "content-disposition") || "";
    const ct   = getHeader(details.responseHeaders, "content-type") || "";
    if (!disp.toLowerCase().includes("attachment")) return;
    if (!isDownloadableMime(ct)) return;
    if (isAutoDuplicate(details.url)) return;

    const filename = extractFilenameFromDisposition(disp) || extractFilenameFromUrl(details.url);

    getCookiesForUrl(details.url).then(cookies =>
      captureDownload({ url: details.url, filename, cookies, referrer: "", tabId: details.tabId })
    );
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ─────────────────────────────────────────────────────────────
// Menu de contexto
// ─────────────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "idm-link",  title: "Baixar com IDM", contexts: ["link","video","audio","image"] });
    chrome.contextMenus.create({ id: "idm-video", title: "Capturar mídia desta página", contexts: ["page"] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!bridgeAvailable) { notify("IDM Bridge offline", "Inicie: systemctl --user start idm-bridge"); return; }

  if (info.menuItemId === "idm-link" && info.linkUrl) {
    if (isAutoDuplicate(info.linkUrl)) return;
    const cookies = await getCookiesForUrl(info.linkUrl);
    await captureDownload({ url: info.linkUrl, cookies, referrer: tab?.url || "" });

  } else if (info.menuItemId === "idm-video" && tab?.id) {
    const ready = await ensureContentScript(tab.id);
    if (ready) await safeSendMessage(tab.id, { action: "findVideos" });
    else notify("IDM Bridge", "Não foi possível acessar esta página.");
  }
});

// ─────────────────────────────────────────────────────────────
// captureDownload — envia o download ao proxy bridge
//
// extraHeaders (opcional): cabeçalhos originais da requisição,
// disponíveis apenas no caminho Firefox blocking. São incluídos
// no payload para que o proxy os repasse ao IDM via /capture.
// ─────────────────────────────────────────────────────────────

async function captureDownload({
  url, filename = "", cookies = "", referrer = "", tabId = -1, extraHeaders = {},
  mediaOrigin = "", mediaDomain = "", requestType = "download", site = "",
  hlsKeys = undefined
}) {
  if (!url) return false;

  // Tentar obter o referrer pela aba se não foi fornecido
  if (!referrer && tabId > 0) {
    try { const tab = await chrome.tabs.get(tabId); referrer = tab.url || ""; } catch (_) {}
  }

  // ── Coleta de cookies para mídias ──────────────────────────────────────────
  // document.cookie (enviado pelo content.js) não inclui cookies HttpOnly —
  // que é exatamente onde ficam os tokens de sessão do Hotmart, Vimeo, etc.
  // chrome.cookies.getAll() acessa TODOS os cookies do domínio, incluindo
  // HttpOnly, e é a única forma de obtê-los via extensão.
  //
  // Estratégia de coleta em camadas:
  //   1. Cookies da URL de mídia (domínio do CDN — ex: cf-media.hotmart.com)
  //   2. Cookies do domínio da plataforma (ex: hotmart.com, vimeo.com)
  //      — onde ficam os tokens de autenticação
  //   3. Cookies da URL da página (referrer) — contexto da sessão
  // Todos mesclados sem duplicação via mergeCookies().

  // Camada 1: cookies do CDN (URL de mídia)
  const mediaCookies = await getCookiesForUrl(url);
  cookies = mergeCookies(cookies, mediaCookies);

  // Camada 2: cookies do domínio da plataforma (se diferente do CDN)
  if (mediaDomain) {
    // Subir para o domínio pai se for subdomínio (cf-media.hotmart.com → hotmart.com)
    const parts = mediaDomain.split(".");
    if (parts.length > 2) {
      const parentDomain = parts.slice(-2).join(".");
      const parentCookies = await getCookiesForUrl(`https://${parentDomain}`);
      cookies = mergeCookies(cookies, parentCookies);
    }
    // Também tentar o subdomínio exato
    const subCookies = await getCookiesForUrl(`https://${mediaDomain}`);
    cookies = mergeCookies(cookies, subCookies);
  }

  // Camada 3: cookies da página de origem (referrer)
  if (referrer && referrer !== url) {
    try { cookies = mergeCookies(cookies, await getCookiesForUrl(referrer)); } catch (_) {}
  }

  // ── Headers base ────────────────────────────────────────────────────────────
  // extraHeaders: headers reais capturados pelo Firefox blocking (mais precisos)
  // Para Chrome, construir headers semanticamente corretos por tipo de requisição.
  const headers = Object.keys(extraHeaders).length > 0
    ? extraHeaders
    : {};

  // Adicionar Origin quando disponível — CDNs de vídeo (Hotmart, Vimeo, Twitch)
  // validam o Origin contra a lista de domínios permitidos da plataforma.
  // Sem Origin correto → 403 imediato no WAF do CDN.
  if (mediaOrigin && !headers["Origin"]) {
    headers["Origin"] = mediaOrigin;
  }

  // requestType é enviado como campo dedicado no JSON (abaixo).
  // NÃO colocar em headers{} — o proxy teria que deletá-lo antes de enviar ao CDN.

  try {
    const resp = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        filename,
        cookies,
        referrer,
        userAgent: navigator.userAgent,
        site: site || detectSite(url),
        silent: silentMode,
        headers,
        requestType,    // "stream" | "download" — proxy usa para Sec-Fetch-*
        mediaOrigin,    // domínio do CDN para header Origin
        hlsKeys,        // chaves AES-128 para streams HLS criptografados
        sessionData: {}
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      notify("Download enviado ao IDM", filename || extractFilenameFromUrl(url) || url);
      console.log("[IDM Bridge] Enviado:", url, "| job:", data.jobId);
      return true;
    }
  } catch (err) { console.error("[IDM Bridge] Erro ao enviar:", err); }

  return false;
}

// ─────────────────────────────────────────────────────────────
// Mensagens dos content scripts e popup
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "ping") { sendResponse({ ok: true }); return false; }

  (async () => {
    switch (msg.action) {

      case "captureDownload": {
        if (!msg.url) { sendResponse({ success: false }); break; }
        // Clique explícito do usuário (fromUser:true) usa debounce leve —
        // nunca bloqueado pelo autoDedup que rastreia interceptação automática.
        // Clique sem fromUser (compatibilidade) usa isUserDuplicate igualmente.
        if (isUserDuplicate(msg.url)) { sendResponse({ success: false }); break; }
        const ok = await captureDownload({
          url:         msg.url,
          filename:    msg.filename    || "",
          cookies:     msg.cookies     || "",
          referrer:    msg.referrer    || sender.tab?.url || "",
          tabId:       sender.tab?.id  || -1,
          mediaOrigin: msg.mediaOrigin || "",
          mediaDomain: msg.mediaDomain || "",
          requestType: msg.requestType || "download",
          site:        msg.site        || "",
          hlsKeys:     msg.hlsKeys     || undefined
        });
        sendResponse({ success: ok });
        break;
      }

      case "getBridgeStatus":
        sendResponse({ available: bridgeAvailable });
        break;

      case "getSettings":
        sendResponse(await getSettings());
        break;

      case "updateSettings":
        await saveSettings(msg.settings);
        if (msg.settings.interceptEnabled !== undefined) interceptEnabled = msg.settings.interceptEnabled;
        if (msg.settings.silentMode       !== undefined) silentMode       = msg.settings.silentMode;
        // floatBtnEnabled é gerenciado pelo popup diretamente via storage.sync.set
        // + mensagem setFloatBtn para os content scripts. Não há estado em memória
        // no background para ele — só no content script e no storage.
        sendResponse({ ok: true });
        break;

      case "sendCookies":
        try {
          await fetch(COOKIES_URL, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domain: msg.domain, cookies: msg.cookies })
          });
        } catch (_) {}
        sendResponse({ ok: true });
        break;

      case "videosFound":
        sendResponse({ ok: true, count: msg.videos?.length || 0 });
        break;

      default:
        sendResponse({ ok: false, reason: "unknown action" });
    }
  })();
  return true;
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function shouldIntercept(url, mime) {
  if (isDownloadableMime(mime)) return true;
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return false;
    const parts = u.pathname.split(".");
    if (parts.length > 1) {
      const ext = parts.pop().toLowerCase().split("?")[0];
      if (DL_EXTENSIONS.has(ext)) return true;
    }
  } catch (_) {}
  return false;
}

function isDownloadableMime(mime) {
  if (!mime) return false;
  return DL_MIME_EXACT.has(mime.toLowerCase().split(";")[0].trim());
}

function isPageFilename(name) {
  return !name || /\.(html?|php|asp|aspx|jsp|cfm|cgi|pl|py|rb)$/i.test(name) ||
    name === "index" || name === "download";
}

function hasDownloadExt(name) {
  return !!name && DL_EXTENSIONS.has(name.split(".").pop().toLowerCase());
}

function extByMime(mime) {
  const map = {
    "video/mp4":".mp4","video/x-matroska":".mkv","video/webm":".webm",
    "video/x-msvideo":".avi","video/quicktime":".mov","video/mp2t":".ts",
    "audio/mpeg":".mp3","audio/flac":".flac","audio/wav":".wav",
    "audio/aac":".aac","audio/ogg":".ogg","audio/mp4":".m4a",
    "application/zip":".zip","application/x-rar-compressed":".rar",
    "application/x-7z-compressed":".7z","application/gzip":".gz",
    "application/pdf":".pdf","application/x-msdownload":".exe",
    "application/vnd.android.package-archive":".apk",
    "application/x-iso9660-image":".iso","application/x-bittorrent":".torrent",
  };
  return map[mime.toLowerCase().split(";")[0].trim()] || "";
}

function detectSite(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const s of VIDEO_SITES) if (host === s || host.endsWith("." + s)) return s;
    return host;
  } catch (_) { return ""; }
}

function extractFilenameFromUrl(url) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop()) || ""; }
  catch (_) { return ""; }
}

function extractFilenameFromDisposition(disp) {
  if (!disp) return "";
  const m = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
  return m ? decodeURIComponent(m[1].trim()) : "";
}

function getHeader(headers = [], name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || null;
}

async function getCookiesForUrl(url) {
  try { return (await chrome.cookies.getAll({ url })).map(c => `${c.name}=${c.value}`).join("; "); }
  catch (_) { return ""; }
}

function mergeCookies(a, b) {
  if (!a) return b; if (!b) return a;
  const seen = new Set();
  return [...a.split(";"), ...b.split(";")]
    .map(s => s.trim()).filter(s => s.includes("="))
    .filter(s => { const k = s.split("=")[0].trim(); return seen.has(k) ? false : !!seen.add(k); })
    .join("; ");
}

async function checkBridgeStatus() {
  try {
    const resp = await fetch(STATUS_URL, { signal: AbortSignal.timeout(3000) });
    bridgeAvailable = (await resp.json()).status === "running";
  } catch (_) { bridgeAvailable = false; }
  chrome.action.setBadgeText({ text: bridgeAvailable ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: bridgeAvailable ? "#22c55e" : "#ef4444" });
}

async function getSettings() {
  return chrome.storage.sync.get({
    interceptEnabled: true, notificationsEnabled: true, silentMode: false
  });
}

async function loadSettings() {
  const s = await getSettings();
  interceptEnabled = s.interceptEnabled;
  silentMode       = s.silentMode ?? false;
}

async function saveSettings(s) { await chrome.storage.sync.set(s); }

function notify(title, message) {
  chrome.storage.sync.get({ notificationsEnabled: true }, ({ notificationsEnabled }) => {
    if (!notificationsEnabled) return;
    chrome.notifications.create({
      type: "basic", iconUrl: chrome.runtime.getURL("icons/icon48.png"), title,
      message: String(message).slice(0, 100), priority: 0
    });
  });
}
