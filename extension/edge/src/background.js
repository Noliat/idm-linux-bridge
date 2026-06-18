// background.js — Service Worker MV3 v3.0
// ─────────────────────────────────────────────────────────────────────
// Correções v2.4:
//   [1] Toggle OFF: onDeterminingFilename retorna suggest normal (não cancel)
//       e onCreated não cancela — navegador baixa normalmente. ✓
//   [2] URL colada na barra: onHeadersReceived main_frame captura downloads
//       iniciados por URL digitada/colada diretamente. ✓
//   [3] Botão "Transferir para IDM": notificação com botão ao iniciar
//       download no Chrome quando bridge está disponível. ✓
//   [4] GitHub dupla invocação: dedup robusto — onDeterminingFilename
//       registra no navDedup; onCreated checa navDedup antes de processar. ✓
//   [5] Injeção em iframes de players externos (JW, Brightcove, Kaltura)
//       via webNavigation.onCommitted com frame targeting. ✓

const BRIDGE_URL  = "http://127.0.0.1:6969";
const CAPTURE_URL = `${BRIDGE_URL}/capture`;
const STATUS_URL  = `${BRIDGE_URL}/status`;
const COOKIES_URL = `${BRIDGE_URL}/cookies`;

const IS_FIREFOX = typeof browser !== "undefined" &&
  typeof browser.runtime?.getBrowserInfo === "function";

const VIDEO_SITES = new Set([
  "youtube.com","youtu.be","drive.google.com","hotmart.com",
  "udemy.com","coursera.org","dropbox.com","mega.nz",
  "twitch.tv","vimeo.com","dailymotion.com","facebook.com",
  "instagram.com","twitter.com","x.com","reddit.com","tiktok.com"
]);

const DL_EXTENSIONS = new Set([
  "mp4","mkv","avi","mov","wmv","flv","webm","m4v","3gp","ts","mts","m2ts",
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
  // Mídias de vídeo/áudio — players externos servem TS/MKV/MP4 diretamente
  "video/mp4","video/webm","video/x-matroska","video/ogg","video/mpeg",
  "video/mp2t","video/quicktime","video/x-msvideo","video/3gpp","video/x-flv",
  "audio/mpeg","audio/mp4","audio/ogg","audio/wav","audio/flac",
  "audio/aac","audio/webm","audio/x-matroska",
]);

// MIMEs que indicam página normal — nunca interceptar como download
const PAGE_MIMES = new Set([
  "text/html","text/xml","application/xhtml+xml",
  "application/xml","text/plain","application/json",
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
// Deduplicadores
//
// autoDedup  — deduplicar disparos automáticos (onDeterminingFilename
//              vs onCreated para o mesmo download).  TTL 3s.
//
// userDedup  — debounce de clique duplo do usuário. TTL 1.5s.
//
// navDedup   — URLs capturadas via navegação de barra / onHeadersReceived.
//              TTL 5s. Evita que o mesmo URL seja tratado por onDeterminingFilename
//              E por onHeadersReceived main_frame simultaneamente.
// ─────────────────────────────────────────────────────────────

const autoDedup    = new Map();
const userDedup    = new Map();
const navDedup     = new Map();
const requestIdSeen = new Map();
const AUTO_TTL     = 3_000;
const USER_TTL     = 1_500;
const NAV_TTL      = 5_000;
const REQUEST_TTL  = 10_000;

function _dedupCheck(map, url, ttl) {
  const now = Date.now();
  for (const [u, ts] of map) if (now - ts > ttl) map.delete(u);
  if (map.has(url)) return true;
  map.set(url, now);
  return false;
}

const isAutoDuplicate = url => _dedupCheck(autoDedup, url, AUTO_TTL);
const isUserDuplicate = url => _dedupCheck(userDedup, url, USER_TTL);
const isNavDuplicate  = url => _dedupCheck(navDedup,  url, NAV_TTL);

// isRequestDuplicate — deduplica pelo requestId do webRequest.
//
// PROBLEMA: sites com cadeia de redirecionamento (GitHub releases,
// GnomeLook, opendesktop.net, etc.) fazem:
//   github.com/.../download/x  --302-->  objects.githubusercontent.com/...?sig=...
//
// onHeadersReceived dispara UMA VEZ POR HOP, cada um com details.url
// DIFERENTE. O dedup por URL (navDedup/autoDedup) não pega isso, pois
// são URLs distintas — resultando em captura duplicada e múltiplas
// chamadas simultâneas ao bridge (que ficam na fila e bloqueiam o
// download por alguns instantes).
//
// SOLUÇÃO: o requestId do webRequest é ESTÁVEL através de toda a cadeia
// de redirecionamentos de uma mesma requisição. Deduplica por requestId
// ANTES do dedup por URL — garante no máximo 1 captura por requisição
// real, independente de quantos hops de redirect ela tiver.
const isRequestDuplicate = requestId => _dedupCheck(requestIdSeen, requestId, REQUEST_TTL);

// Verificar SEM registrar (apenas leitura)
const navDedupHas = url => navDedup.has(url);

// ─────────────────────────────────────────────────────────────
// safeSendMessage
// ─────────────────────────────────────────────────────────────

async function safeSendMessage(tabId, message) {
  if (!tabId || tabId < 0) return null;
  try { return await chrome.tabs.sendMessage(tabId, message); }
  catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────
// ensureContentScript
// ─────────────────────────────────────────────────────────────

async function ensureContentScript(tabId, frameId) {
  if (!tabId || tabId < 0) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || RESTRICTED_SCHEMES.some(s => tab.url.startsWith(s))) return false;

    const target = frameId != null
      ? { tabId, frameIds: [frameId] }
      : { tabId };

    if (frameId != null) {
      // ── Iframe (cross-origin ou same-origin) ──────────────────────────────
      // Chrome MV3 bloqueia injeção de world:MAIN em iframes cross-origin
      // via executeScript. Mas world:ISOLATED funciona.
      // Injetamos page_inject.js (ISOLATED) que por sua vez injeta o
      // interceptor inline no MAIN de dentro do próprio iframe — isso funciona
      // porque o ISOLATED tem acesso ao document do iframe.
      await chrome.scripting.executeScript({
        target,
        files: ["src/page_inject.js"],
        world: "ISOLATED"
      });
      return true;
    }

    // ── Frame principal ────────────────────────────────────────────────────
    // Ping para verificar se content.js já está ativo
    try { await chrome.tabs.sendMessage(tabId, { action: "ping" }); return true; } catch (_) {}

    await chrome.scripting.executeScript({ target, files: ["src/parser_m3u8.js"], world: "MAIN" });
    await chrome.scripting.executeScript({ target, files: ["src/interceptor.js"],  world: "MAIN" });
    await chrome.scripting.executeScript({ target, files: ["src/content.js"], world: "ISOLATED" });
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

chrome.alarms.create("bridgeCheck", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "bridgeCheck") checkBridgeStatus();
});

// ─────────────────────────────────────────────────────────────
// [FIX 2] Interceptar URL colada diretamente na barra de endereço
//
// Quando o usuário cola "https://example.com/video.mp4" na barra
// e pressiona Enter, o Chrome gera uma navegação main_frame — NÃO
// um evento downloads.onCreated. O interceptor.js não pode capturar
// isso porque a página ainda não existe.
//
// Solução: webRequest.onHeadersReceived em main_frame. Quando o
// servidor responde com Content-Disposition:attachment OU com um
// MIME de download (não text/html), interceptar e enviar ao IDM.
//
// [FIX 4] GitHub dupla invocação:
// O navDedup garante que quando onDeterminingFilename também dispara
// para o mesmo download (ex: GitHub), apenas um dos dois o processa.
// ─────────────────────────────────────────────────────────────

// Set para rastrear downloads bloqueados via Firefox webRequest
const blockingInProgress = new Set();

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // ── Pular hops de redirecionamento (3xx) ────────────────────────────
    // O hop final (200) é o que contém o arquivo real. Hops intermediários
    // (302, 301, 307, etc.) às vezes também trazem content-disposition ou
    // content-type de download (ex: GitHub releases), o que disparava
    // captura duplicada — uma para o hop de redirect, outra para o destino.
    if (details.statusCode >= 300 && details.statusCode < 400) return;

    // ── Ignorar page mimes — nunca são downloads ───────────────────────
    const ct = getHeader(details.responseHeaders, "content-type") || "";
    const ctBase = ct.toLowerCase().split(";")[0].trim();
    if (PAGE_MIMES.has(ctBase)) return;

    if (!interceptEnabled || !bridgeAvailable) return;
    if (details.url.startsWith("http://127.0.0.1")) return;
    if (blockingInProgress.has(details.url)) return;

    const disp = getHeader(details.responseHeaders, "content-disposition") || "";
    const hasAttachment  = disp.toLowerCase().includes("attachment");
    const hasDownloadMime = isDownloadableMime(ctBase);

    // Só interceptar main_frame com attachment OU mime de download
    if (details.type !== "main_frame") return;
    if (!hasAttachment && !hasDownloadMime) return;

    // ── Dedup por requestId ──────────────────────────────────────────────
    // Garante no máximo 1 captura por requisição real, mesmo que o
    // listener seja re-acionado para o mesmo hop (alguns navegadores
    // disparam onHeadersReceived mais de uma vez em certas condições
    // de cache/preflight).
    if (isRequestDuplicate(details.requestId)) return;

    // [FIX 4] dedup: se onDeterminingFilename já processou → ignorar aqui
    if (navDedupHas(details.url)) return;
    // Registrar para evitar que onDeterminingFilename processe depois
    isNavDuplicate(details.url);
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
// Injetar interceptor em iframes de players externos
// JW Player, Brightcove, Kaltura, Vimeo embed, etc.
// quando um frame filho é criado — captura mídias do player interno
// ─────────────────────────────────────────────────────────────

if (chrome.webNavigation) {
  chrome.webNavigation.onCommitted.addListener(async details => {
    if (details.frameId === 0) return; // frame principal já tem content_scripts
    if (!details.url || !details.url.startsWith("http")) return;

    // Injetar interceptor.js no mundo MAIN do iframe
    // Isso permite capturar fetch/XHR/MediaSource do player no iframe
    try {
      await ensureContentScript(details.tabId, details.frameId);
    } catch (_) {}
  });
}

// ─────────────────────────────────────────────────────────────
// downloads.onDeterminingFilename (Chrome)
//
// [FIX 1] Toggle OFF: quando interceptEnabled === false, chamar
//   suggest() normalmente → navegador termina o download.
//   NÃO chamar suggest({ cancel: true }).
//
// [FIX 4] GitHub dupla invocação: registrar no navDedup para
//   que onHeadersReceived main_frame não trate o mesmo arquivo.
// ─────────────────────────────────────────────────────────────

if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    // [FIX 1] Toggle OFF — deixar o navegador baixar normalmente
    if (!interceptEnabled || !bridgeAvailable) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    if (!item.url ||
        item.url.startsWith("http://127.0.0.1") ||
        item.url.startsWith("https://127.0.0.1") ||
        item.url.startsWith("blob:")  ||
        item.url.startsWith("data:")) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    if (!shouldIntercept(item.url, item.mime || "")) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    // [FIX 4] dedup: se onHeadersReceived já processou → passar para o navegador
    if (navDedupHas(item.url)) {
      suggest({ cancel: true });
      return;
    }

    if (isAutoDuplicate(item.url)) {
      suggest({ filename: item.filename, conflict_action: "uniquify" });
      return;
    }

    // Registrar no navDedup — evita que onHeadersReceived main_frame trate também
    isNavDuplicate(item.url);

    suggest({ cancel: true });

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
// downloads.onCreated — fallback para quando onDeterminingFilename
// não dispara (Firefox, alguns tipos de download específicos).
//
// [FIX 1] Toggle OFF: NÃO cancelar o download — retornar sem ação.
// [FIX 4] Verificar navDedup antes de processar.
// ─────────────────────────────────────────────────────────────

chrome.downloads.onCreated.addListener(async (item) => {
  // [FIX 1] Toggle OFF — navegador baixa normalmente
  if (!interceptEnabled || !bridgeAvailable) return;

  if (!item.url) return;
  if (item.url.startsWith("http://127.0.0.1") ||
      item.url.startsWith("https://127.0.0.1") ||
      item.url.startsWith("blob:") ||
      item.url.startsWith("data:")) return;

  // [FIX 4] Se onDeterminingFilename já processou → não duplicar
  if (navDedupHas(item.url)) return;
  if (isAutoDuplicate(item.url)) return;
  if (!shouldIntercept(item.url, item.mime || "")) return;

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
// [FIX 3] Botão "Transferir para IDM"
//
// Quando o usuário inicia um download normalmente no Chrome
// (interceptEnabled OFF ou download não interceptável), exibir
// uma notificação com botão "Transferir para IDM".
//
// Também registrar o download em pendingTransfers para que o
// content script possa mostrar o botão na barra de downloads
// via chrome.downloads API se disponível.
// ─────────────────────────────────────────────────────────────

// Mapa notificationId → downloadItem
const pendingTransfers = new Map();

chrome.downloads.onCreated.addListener(async (item) => {
  // Só mostrar botão quando NÃO interceptamos automaticamente
  if (interceptEnabled && bridgeAvailable && shouldIntercept(item.url, item.mime || "")) return;
  if (!bridgeAvailable) return;
  if (!item.url || item.url.startsWith("blob:") || item.url.startsWith("data:")) return;
  if (item.url.startsWith("http://127.0.0.1")) return;

  // Só para downloads de arquivo reais
  const filename = item.filename
    ? item.filename.split("/").pop().split("\\").pop()
    : extractFilenameFromUrl(item.url);
  if (!filename) return;

  // Verificar se é realmente um arquivo baixável
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const looksDownloadable = DL_EXTENSIONS.has(ext) || isDownloadableMime(item.mime || "");
  if (!looksDownloadable) return;

  const notifId = "idm-transfer-" + item.id;
  pendingTransfers.set(notifId, item);
  setTimeout(() => pendingTransfers.delete(notifId), 120_000);

  chrome.storage.sync.get({ notificationsEnabled: true }, ({ notificationsEnabled }) => {
    if (!notificationsEnabled) return;
    chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon48.png"),
      title: "Download iniciado no Chrome",
      message: filename.slice(0, 80),
      buttons: [{ title: "⬇ Transferir para IDM" }],
      requireInteraction: false,
      priority: 1
    });
  });
});

chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
  if (btnIdx !== 0) return;
  const item = pendingTransfers.get(notifId);
  if (!item) return;

  pendingTransfers.delete(notifId);
  chrome.notifications.clear(notifId);

  try {
    if (item.state === "in_progress") await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (_) {}

  const filename = item.filename
    ? item.filename.split("/").pop().split("\\").pop()
    : extractFilenameFromUrl(item.url);

  const cookies = await getCookiesForUrl(item.url);
  await captureDownload({
    url: item.url,
    filename,
    cookies,
    referrer: item.referrer || "",
    tabId: item.tabId ?? -1
  });
});

// ─────────────────────────────────────────────────────────────
// Firefox: webRequest blocking
// ─────────────────────────────────────────────────────────────

if (IS_FIREFOX) {
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!interceptEnabled || !bridgeAvailable) return {};
      if (details.url.startsWith("http://127.0.0.1") ||
          details.url.startsWith("https://127.0.0.1")) return {};
      if (!["main_frame", "sub_frame"].includes(details.type)) return {};
      if (!shouldIntercept(details.url, "")) return {};
      if (isAutoDuplicate(details.url)) return {};
      // Dedup por requestId: mesma proteção contra re-disparo do mesmo
      // hop de redirecionamento usada no listener do Chrome.
      if (isRequestDuplicate(details.requestId)) return { cancel: true };

      blockingInProgress.add(details.url);
      setTimeout(() => blockingInProgress.delete(details.url), AUTO_TTL);

      const reqHeaders = {};
      if (details.requestHeaders) {
        for (const h of details.requestHeaders) {
          const name = h.name.toLowerCase();
          if (["referer","user-agent","accept-language",
               "accept","origin","range"].includes(name)) {
            reqHeaders[h.name] = h.value;
          }
        }
      }

      const filename = extractFilenameFromUrl(details.url);
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

      return { cancel: true };
    },
    { urls: ["<all_urls>"] },
    ["blocking", "requestHeaders"]
  );
}

// ─────────────────────────────────────────────────────────────
// Menu de contexto
// ─────────────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    // "Baixar com IDM" — aparece em links, vídeos, áudios e imagens
    // Excluir a própria página de downloads (chrome_url_overrides) para não confundir
    chrome.contextMenus.create({
      id: "idm-link",
      title: "Baixar com IDM",
      contexts: ["link", "video", "audio", "image"],
      documentUrlPatterns: ["http://*/*", "https://*/*", "ftp://*/*"]
    });

    // "Capturar mídia desta página" — excluir a página de downloads da extensão
    // (a página de downloads tem seus próprios botões de transferência por item)
    chrome.contextMenus.create({
      id: "idm-video",
      title: "Capturar mídia desta página",
      contexts: ["page"],
      documentUrlPatterns: ["http://*/*", "https://*/*"]
    });
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
// captureDownload
// ─────────────────────────────────────────────────────────────

async function captureDownload({
  url, filename = "", cookies = "", referrer = "", tabId = -1, extraHeaders = {},
  mediaOrigin = "", mediaDomain = "", requestType = "download", site = "",
  hlsKeys = undefined,
  // Campos de qualidade YouTube para merge via yt-dlp
  itag = undefined, audioItag = undefined, audioUrl = undefined,
  height = undefined, needsMerge = false, videoId = undefined
}) {
  if (!url) return false;

  if (!referrer && tabId > 0) {
    try { const tab = await chrome.tabs.get(tabId); referrer = tab.url || ""; } catch (_) {}
  }

  const mediaCookies = await getCookiesForUrl(url);
  cookies = mergeCookies(cookies, mediaCookies);

  if (mediaDomain) {
    const parts = mediaDomain.split(".");
    if (parts.length > 2) {
      const parentCookies = await getCookiesForUrl(`https://${parts.slice(-2).join(".")}`);
      cookies = mergeCookies(cookies, parentCookies);
    }
    cookies = mergeCookies(cookies, await getCookiesForUrl(`https://${mediaDomain}`));
  }

  if (referrer && referrer !== url) {
    try { cookies = mergeCookies(cookies, await getCookiesForUrl(referrer)); } catch (_) {}
  }

  const headers = Object.keys(extraHeaders).length > 0 ? extraHeaders : {};
  if (mediaOrigin && !headers["Origin"]) headers["Origin"] = mediaOrigin;

  try {
    const resp = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url, filename, cookies, referrer,
        userAgent: navigator.userAgent,
        site: site || detectSite(url),
        silent: silentMode,
        headers,
        requestType,
        mediaOrigin,
        hlsKeys,
        sessionData: {},
        // Qualidade YouTube: itag vídeo, itag áudio, altura, merge flag
        itag:       itag       || undefined,
        audioItag:  audioItag  || undefined,
        audioUrl:   audioUrl   || undefined,
        height:     height     || undefined,
        needsMerge: needsMerge || false,
        videoId:    videoId    || undefined,
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
          hlsKeys:     msg.hlsKeys     || undefined,
          itag:        msg.itag        || undefined,
          audioItag:   msg.audioItag   || undefined,
          audioUrl:    msg.audioUrl    || null,
          height:      msg.height      || undefined,
          needsMerge:  msg.needsMerge  || false,
          videoId:     msg.videoId     || undefined,
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
  chrome.action.setBadgeText({ text: bridgeAvailable ? "" : "X" });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
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
