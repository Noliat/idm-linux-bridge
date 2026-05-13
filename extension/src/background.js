// background.js — Service Worker da extensão IDM Linux Bridge
// Intercepta downloads e os redireciona ao proxy local (Go)

const BRIDGE_URL = "http://127.0.0.1:6969";
const BRIDGE_STATUS_URL = `${BRIDGE_URL}/status`;
const BRIDGE_CAPTURE_URL = `${BRIDGE_URL}/capture`;
const BRIDGE_COOKIES_URL = `${BRIDGE_URL}/cookies`;

// Tipos de arquivo que o IDM deve interceptar
const DOWNLOADABLE_EXTENSIONS = new Set([
  // Vídeo
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "m3u8",
  // Áudio
  "mp3", "flac", "wav", "aac", "ogg", "m4a", "opus",
  // Compactados
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst",
  // Documentos
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // Instaladores
  "exe", "msi", "deb", "rpm", "AppImage", "iso", "dmg",
  // Outros
  "apk", "torrent"
]);

// Content-types que indicam um download
const DOWNLOADABLE_CONTENT_TYPES = [
  "application/octet-stream",
  "application/zip",
  "application/x-rar",
  "application/x-7z-compressed",
  "application/pdf",
  "video/",
  "audio/",
  "application/x-iso9660-image",
  "application/vnd.android.package-archive"
];

// Sites que sempre devem ser interceptados (independente de extensão)
const ALWAYS_INTERCEPT_SITES = [
  "youtube.com", "youtu.be",
  "drive.google.com",
  "hotmart.com",
  "udemy.com",
  "coursera.org",
  "dropbox.com",
  "mega.nz",
  "twitch.tv",
  "vimeo.com",
  "dailymotion.com",
  "facebook.com"
];

// Estado do bridge
let bridgeAvailable = false;
let interceptEnabled = true;

// ─────────────────────────────────────────────
// Inicialização
// ─────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[IDM Bridge] Extensão instalada.");
  setupContextMenu();
  await loadSettings();
  checkBridgeStatus();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  checkBridgeStatus();
});

// Verificar status do bridge a cada 30 segundos
setInterval(checkBridgeStatus, 30000);

// ─────────────────────────────────────────────
// Menu de contexto (botão direito)
// ─────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "idm-download-link",
      title: "Baixar com IDM",
      contexts: ["link", "video", "audio", "image"]
    });
    chrome.contextMenus.create({
      id: "idm-download-page-video",
      title: "Baixar vídeo desta página com IDM",
      contexts: ["page"]
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!bridgeAvailable) {
    notify("IDM Bridge não está rodando", "Inicie o bridge com: idm-bridge");
    return;
  }

  if (info.menuItemId === "idm-download-link" && info.linkUrl) {
    await captureDownload({
      url: info.linkUrl,
      tabId: tab.id,
      pageUrl: tab.url
    });
  } else if (info.menuItemId === "idm-download-page-video") {
    // Injetar script para encontrar vídeos na página
    chrome.tabs.sendMessage(tab.id, { action: "findVideos" });
  }
});

// ─────────────────────────────────────────────
// Interceptação de downloads via webRequest
// ─────────────────────────────────────────────

// Interceptar respostas HTTP para detectar downloads por Content-Type
chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (!interceptEnabled || !bridgeAvailable) return;
    if (details.type === "main_frame" || details.type === "sub_frame") return;

    const contentType = getHeader(details.responseHeaders, "content-type") || "";
    const contentDisp = getHeader(details.responseHeaders, "content-disposition") || "";

    const isDownload =
      isDownloadableContentType(contentType) ||
      contentDisp.toLowerCase().includes("attachment");

    if (!isDownload) return;

    // Extrair nome do arquivo do Content-Disposition ou URL
    const filename = extractFilename(contentDisp, details.url);

    // Cancelar o download nativo e enviar ao IDM
    const cookies = await getCookiesForUrl(details.url);
    const referer = getHeader(details.requestHeaders || [], "referer") || "";

    await captureDownload({
      url: details.url,
      filename,
      cookies,
      referrer: referer,
      tabId: details.tabId
    });

    // Bloquear o download nativo do navegador
    return { cancel: true };
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders", "blocking"]
);

// Interceptar requisições de arquivos com extensões conhecidas
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (!interceptEnabled || !bridgeAvailable) return;
    if (details.type !== "main_frame") return;

    const url = details.url;
    if (!isDownloadableURL(url)) return;

    const cookies = await getCookiesForUrl(url);

    await captureDownload({
      url,
      cookies,
      tabId: details.tabId
    });

    return { cancel: true };
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// ─────────────────────────────────────────────
// Captura de download
// ─────────────────────────────────────────────

async function captureDownload({ url, filename = "", cookies = "", referrer = "", tabId = -1, pageUrl = "" }) {
  if (!bridgeAvailable) {
    console.warn("[IDM Bridge] Bridge indisponível, download não capturado:", url);
    return false;
  }

  try {
    // Obter tab info para referrer
    if (tabId > 0 && !referrer) {
      try {
        const tab = await chrome.tabs.get(tabId);
        referrer = tab.url || "";
        pageUrl = pageUrl || tab.url || "";
      } catch (_) {}
    }

    // Detectar site para tratamento especial
    const site = detectSite(url);

    // Coletar cookies se não foram fornecidos
    if (!cookies) {
      cookies = await getCookiesForUrl(url);
      // Coletar também cookies do referrer (para autenticação)
      if (referrer) {
        const refCookies = await getCookiesForUrl(referrer);
        cookies = mergeCookieStrings(cookies, refCookies);
      }
    }

    const payload = {
      url,
      filename,
      cookies,
      referrer,
      userAgent: navigator.userAgent,
      site,
      headers: {},
      sessionData: {}
    };

    const resp = await fetch(BRIDGE_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (resp.ok) {
      const data = await resp.json();
      console.log("[IDM Bridge] Download capturado:", url, "| Job:", data.jobId);
      notify("Download enviado ao IDM", `Arquivo: ${filename || url.split("/").pop()}`);
      return true;
    }
  } catch (err) {
    console.error("[IDM Bridge] Erro ao capturar download:", err);
  }
  return false;
}

// ─────────────────────────────────────────────
// Comunicação com content scripts
// ─────────────────────────────────────────────

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  switch (message.action) {

    case "captureDownload":
      const success = await captureDownload({
        url: message.url,
        filename: message.filename || "",
        cookies: message.cookies || "",
        referrer: message.referrer || sender.tab?.url || "",
        tabId: sender.tab?.id || -1
      });
      sendResponse({ success });
      break;

    case "getBridgeStatus":
      sendResponse({ available: bridgeAvailable });
      break;

    case "getSettings":
      const settings = await getSettings();
      sendResponse(settings);
      break;

    case "updateSettings":
      await saveSettings(message.settings);
      sendResponse({ ok: true });
      break;

    case "sendCookies":
      await sendCookiesToBridge(message.domain, message.cookies);
      sendResponse({ ok: true });
      break;

    case "videosFound":
      // Content script encontrou vídeos na página
      if (message.videos && message.videos.length > 0) {
        // Capturar o vídeo de maior qualidade
        const best = message.videos[0];
        await captureDownload({
          url: best.url,
          filename: best.title || "",
          referrer: sender.tab?.url || "",
          tabId: sender.tab?.id || -1
        });
      }
      sendResponse({ ok: true });
      break;
  }
  return true; // manter canal aberto para resposta assíncrona
});

// ─────────────────────────────────────────────
// Helpers de cookies
// ─────────────────────────────────────────────

async function getCookiesForUrl(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch (_) {
    return "";
  }
}

async function sendCookiesToBridge(domain, cookies) {
  try {
    await fetch(BRIDGE_COOKIES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, cookies })
    });
  } catch (_) {}
}

function mergeCookieStrings(a, b) {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set();
  const all = [...a.split(";"), ...b.split(";")]
    .map(s => s.trim())
    .filter(s => s.includes("="))
    .filter(s => {
      const key = s.split("=")[0].trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return all.join("; ");
}

// ─────────────────────────────────────────────
// Helpers de detecção
// ─────────────────────────────────────────────

function isDownloadableURL(url) {
  try {
    const u = new URL(url);
    const ext = u.pathname.split(".").pop().toLowerCase();
    return DOWNLOADABLE_EXTENSIONS.has(ext);
  } catch (_) {
    return false;
  }
}

function isDownloadableContentType(contentType) {
  return DOWNLOADABLE_CONTENT_TYPES.some(t => contentType.toLowerCase().includes(t));
}

function detectSite(url) {
  try {
    const host = new URL(url).hostname.replace("www.", "");
    for (const site of ALWAYS_INTERCEPT_SITES) {
      if (host === site || host.endsWith("." + site)) {
        return site;
      }
    }
    return host;
  } catch (_) {
    return "";
  }
}

function extractFilename(contentDisp, url) {
  // Tentar extrair do Content-Disposition
  const match = contentDisp.match(/filename\*?=['"]?([^'";]+)['"]?/i);
  if (match) return decodeURIComponent(match[1].trim());

  // Tentar extrair da URL
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/");
    return decodeURIComponent(parts[parts.length - 1]) || "";
  } catch (_) {
    return "";
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

// ─────────────────────────────────────────────
// Status do bridge
// ─────────────────────────────────────────────

async function checkBridgeStatus() {
  try {
    const resp = await fetch(BRIDGE_STATUS_URL, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    bridgeAvailable = data.status === "running";

    // Atualizar ícone baseado no status
    chrome.action.setBadgeText({ text: bridgeAvailable ? "" : "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: bridgeAvailable ? "#22c55e" : "#ef4444" });
  } catch (_) {
    bridgeAvailable = false;
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  }
}

// ─────────────────────────────────────────────
// Configurações
// ─────────────────────────────────────────────

async function getSettings() {
  const result = await chrome.storage.sync.get({
    interceptEnabled: true,
    notificationsEnabled: true,
    alwaysInterceptSites: ALWAYS_INTERCEPT_SITES,
    downloadableExtensions: [...DOWNLOADABLE_EXTENSIONS],
    bridgePort: 6969
  });
  return result;
}

async function loadSettings() {
  const settings = await getSettings();
  interceptEnabled = settings.interceptEnabled;
}

async function saveSettings(settings) {
  await chrome.storage.sync.set(settings);
  await loadSettings();
}

// ─────────────────────────────────────────────
// Notificações
// ─────────────────────────────────────────────

function notify(title, message) {
  chrome.storage.sync.get({ notificationsEnabled: true }, ({ notificationsEnabled }) => {
    if (!notificationsEnabled) return;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title,
      message,
      priority: 0
    });
  });
}
