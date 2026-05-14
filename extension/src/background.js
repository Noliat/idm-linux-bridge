// background.js — Service Worker MV3 (Chrome/Firefox compatível)
// Usa chrome.downloads API em vez de webRequest blocking (removido no MV3)

const BRIDGE_URL   = "http://127.0.0.1:6969";
const CAPTURE_URL  = `${BRIDGE_URL}/capture`;
const STATUS_URL   = `${BRIDGE_URL}/status`;
const COOKIES_URL  = `${BRIDGE_URL}/cookies`;

// Extensões interceptadas pelo IDM
const DL_EXTENSIONS = new Set([
  "mp4","mkv","avi","mov","wmv","flv","webm","m4v","ts",
  "mp3","flac","wav","aac","ogg","m4a","opus",
  "zip","rar","7z","gz","bz2","xz","zst","tar",
  "pdf","doc","docx","xls","xlsx","ppt","pptx",
  "exe","msi","deb","rpm","iso","dmg","apk","torrent"
]);

// Content-Types que indicam download
const DL_MIME_PREFIXES = [
  "application/octet-stream",
  "application/zip","application/x-rar","application/x-7z-compressed",
  "application/pdf","application/x-bittorrent",
  "video/","audio/",
  "application/x-iso9660-image",
  "application/vnd.android.package-archive",
  "application/x-msdownload"
];

// Sites de vídeo: interceptar sempre independente de extensão
const VIDEO_SITES = [
  "youtube.com","youtu.be","drive.google.com","hotmart.com",
  "udemy.com","coursera.org","dropbox.com","mega.nz",
  "twitch.tv","vimeo.com","dailymotion.com","facebook.com"
];

let bridgeAvailable = false;
let interceptEnabled = true;

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

// Checar bridge a cada 30s
setInterval(checkBridgeStatus, 30_000);

// ─────────────────────────────────────────────────────────────
// INTERCEPTAÇÃO PRINCIPAL — chrome.downloads.onCreated (MV3 ✓)
// ─────────────────────────────────────────────────────────────
// Abordagem correta no MV3: o browser inicia o download,
// capturamos o evento, cancelamos e repassamos ao IDM.

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  if (!interceptEnabled || !bridgeAvailable) return;
  if (!shouldIntercept(downloadItem.url, downloadItem.mime || "")) return;

  // Cancelar o download nativo imediatamente
  chrome.downloads.cancel(downloadItem.id, async () => {
    // Remover da lista de downloads do browser (limpeza visual)
    chrome.downloads.erase({ id: downloadItem.id });

    const cookies  = await getCookiesForUrl(downloadItem.url);
    const referrer = downloadItem.referrer || "";

    // Extrair filename com prioridade: header > URL > mime
    let filename = "";
    if (downloadItem.filename) {
      // Chrome já decodificou o Content-Disposition
      filename = downloadItem.filename.split("/").pop().split("\\").pop();
    }
    if (!filename || isPageFilename(filename)) {
      filename = extractFilenameFromUrl(downloadItem.url);
    }
    // Se ainda sem extensão, inferir pelo MIME type
    if (filename && !hasDownloadExtension(filename) && downloadItem.mime) {
      const ext = extByMime(downloadItem.mime);
      if (ext) filename += ext;
    }

    await captureDownload({
      url: downloadItem.url,
      filename,
      cookies,
      referrer,
      mime: downloadItem.mime || ""
    });
  });
});

// ─────────────────────────────────────────────────────────────
// DETECÇÃO COMPLEMENTAR — webRequest somente leitura (sem blocking)
// Captura streams de vídeo e respostas com Content-Disposition
// que o browser não classifica como "download" automaticamente.
// ─────────────────────────────────────────────────────────────

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!interceptEnabled || !bridgeAvailable) return;

    const ct   = getHeader(details.responseHeaders, "content-type") || "";
    const disp = getHeader(details.responseHeaders, "content-disposition") || "";

    const isDownloadResponse =
      disp.toLowerCase().includes("attachment") ||
      isDownloadableMime(ct);

    if (!isDownloadResponse) return;

    const filename = extractFilenameFromDisposition(disp) || extractFilenameFromUrl(details.url);

    // Assíncrono — não bloqueia a requisição
    getCookiesForUrl(details.url).then(cookies => {
      captureDownload({
        url: details.url,
        filename,
        cookies,
        referrer: getHeader(details.requestHeaders || [], "referer") || "",
        tabId: details.tabId
      });
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]   // ← SEM "blocking" — compatível com MV3
);

// ─────────────────────────────────────────────────────────────
// Menu de contexto
// ─────────────────────────────────────────────────────────────

function setupContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "idm-download-link",
      title: "⬇ Baixar com IDM",
      contexts: ["link", "video", "audio", "image"]
    });
    chrome.contextMenus.create({
      id: "idm-download-video",
      title: "⬇ Baixar vídeo desta página com IDM",
      contexts: ["page"]
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!bridgeAvailable) {
    notify("IDM Bridge offline", "Inicie: systemctl --user start idm-bridge");
    return;
  }
  if (info.menuItemId === "idm-download-link" && info.linkUrl) {
    const cookies = await getCookiesForUrl(info.linkUrl);
    await captureDownload({ url: info.linkUrl, cookies, referrer: tab.url });
  } else if (info.menuItemId === "idm-download-video") {
    chrome.tabs.sendMessage(tab.id, { action: "findVideos" });
  }
});

// ─────────────────────────────────────────────────────────────
// Captura e envio ao bridge
// ─────────────────────────────────────────────────────────────

async function captureDownload({ url, filename = "", cookies = "", referrer = "", tabId = -1 }) {
  if (!url) return false;

  if (!referrer && tabId > 0) {
    try { const tab = await chrome.tabs.get(tabId); referrer = tab.url || ""; } catch (_) {}
  }

  // Enriquecer com cookies do referrer (para sites autenticados)
  if (referrer && referrer !== url) {
    try {
      const refCookies = await getCookiesForUrl(referrer);
      cookies = mergeCookies(cookies, refCookies);
    } catch (_) {}
  }

  try {
    const resp = await fetch(CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url, filename, cookies, referrer,
        userAgent: navigator.userAgent,
        site: detectSite(url),
        headers: {}, sessionData: {}
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      notify("⬇ Download enviado ao IDM", filename || extractFilenameFromUrl(url) || url);
      console.log("[IDM Bridge] Capturado:", url, "| job:", data.jobId);
      return true;
    }
  } catch (err) {
    console.error("[IDM Bridge] Erro ao enviar ao bridge:", err);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Mensagens dos content scripts e popup
// ─────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {

      case "captureDownload": {
        const ok = await captureDownload({
          url: msg.url,
          filename: msg.filename || "",
          cookies: msg.cookies || "",
          referrer: msg.referrer || sender.tab?.url || "",
          tabId: sender.tab?.id || -1
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
        if (msg.settings.interceptEnabled !== undefined)
          interceptEnabled = msg.settings.interceptEnabled;
        sendResponse({ ok: true });
        break;

      case "sendCookies":
        try {
          await fetch(COOKIES_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domain: msg.domain, cookies: msg.cookies })
          });
        } catch (_) {}
        sendResponse({ ok: true });
        break;

      case "videosFound":
        if (msg.videos?.length > 0) {
          const best = msg.videos[0];
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
  })();
  return true;
});

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function shouldIntercept(url, mime) {
  if (isDownloadableMime(mime)) return true;
  try {
    const ext  = new URL(url).pathname.split(".").pop().toLowerCase().split("?")[0];
    if (DL_EXTENSIONS.has(ext)) return true;
    const host = new URL(url).hostname.replace("www.", "");
    return VIDEO_SITES.some(s => host === s || host.endsWith("." + s));
  } catch (_) { return false; }
}

function isDownloadableMime(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(";")[0].trim();
  return DL_MIME_PREFIXES.some(p => m.startsWith(p));
}

// Retorna true se o filename parece uma página web (index.html, etc.)
function isPageFilename(name) {
  if (!name) return true;
  const pagePat = /\.(html?|php|asp|aspx|jsp|cfm|cgi|pl|py|rb)$/i;
  return pagePat.test(name) || name === "index" || name === "download";
}

// Retorna true se o filename já tem uma extensão de arquivo baixável
function hasDownloadExtension(name) {
  if (!name) return false;
  const ext = name.split(".").pop().toLowerCase();
  return DL_EXTENSIONS.has(ext);
}

// Retorna extensão de arquivo a partir do MIME type
function extByMime(mime) {
  const m = mime.toLowerCase().split(";")[0].trim();
  const map = {
    "video/mp4": ".mp4", "video/x-matroska": ".mkv", "video/webm": ".webm",
    "video/x-msvideo": ".avi", "video/quicktime": ".mov", "video/mp2t": ".ts",
    "audio/mpeg": ".mp3", "audio/flac": ".flac", "audio/wav": ".wav",
    "audio/aac": ".aac", "audio/ogg": ".ogg", "audio/mp4": ".m4a",
    "application/zip": ".zip", "application/x-rar-compressed": ".rar",
    "application/x-7z-compressed": ".7z", "application/gzip": ".gz",
    "application/pdf": ".pdf", "application/x-msdownload": ".exe",
    "application/vnd.android.package-archive": ".apk",
    "application/x-iso9660-image": ".iso", "application/x-bittorrent": ".torrent",
  };
  return map[m] || "";
}

function detectSite(url) {
  try {
    const host = new URL(url).hostname.replace("www.", "");
    return VIDEO_SITES.find(s => host === s || host.endsWith("." + s)) || host;
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
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map(c => `${c.name}=${c.value}`).join("; ");
  } catch (_) { return ""; }
}

function mergeCookies(a, b) {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set();
  return [...a.split(";"), ...b.split(";")]
    .map(s => s.trim())
    .filter(s => s.includes("="))
    .filter(s => {
      const k = s.split("=")[0].trim();
      return seen.has(k) ? false : !!seen.add(k);
    })
    .join("; ");
}

async function checkBridgeStatus() {
  try {
    const resp = await fetch(STATUS_URL, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    bridgeAvailable = data.status === "running";
  } catch (_) {
    bridgeAvailable = false;
  }
  chrome.action.setBadgeText({ text: bridgeAvailable ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: bridgeAvailable ? "#22c55e" : "#ef4444" });
}

async function getSettings() {
  return chrome.storage.sync.get({
    interceptEnabled: true,
    notificationsEnabled: true,
    bridgePort: 6969
  });
}

async function loadSettings() {
  const s = await getSettings();
  interceptEnabled = s.interceptEnabled;
}

async function saveSettings(settings) {
  await chrome.storage.sync.set(settings);
}

function notify(title, message) {
  chrome.storage.sync.get({ notificationsEnabled: true }, ({ notificationsEnabled }) => {
    if (!notificationsEnabled) return;
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.svg",
      title,
      message: String(message).slice(0, 100),
      priority: 0
    });
  });
}
