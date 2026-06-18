// popup.js — v2.2

const BRIDGE_URL = "http://127.0.0.1:6969";

document.addEventListener("DOMContentLoaded", async () => {
  detectBrowser();
  await loadSettings();
  await checkStatus();
  bindEvents();
});

// ── Detecção de navegador ─────────────────────────────────────────────────────
function detectBrowser() {
  const isFirefox = typeof browser !== "undefined" &&
    typeof browser.runtime?.getBrowserInfo === "function";
  if (isFirefox)
    document.getElementById("interceptModeBar").classList.add("firefox");
}

// ── Status do bridge ──────────────────────────────────────────────────────────
async function checkStatus() {
  const dot  = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  try {
    const resp = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    dot.classList.add("online");
    text.textContent = `Bridge online · ${data.idmFound ? "IDM encontrado" : "IDM não localizado"}`;
    if (data.reverseProxy) text.title = `Proxy reverso: ${data.reverseProxy}`;
  } catch (_) {
    dot.classList.remove("online");
    text.textContent = "Bridge offline — inicie com: idm-bridge";
  }
}

// ── Configurações ─────────────────────────────────────────────────────────────
async function loadSettings() {
  const s = await chrome.storage.sync.get({
    interceptEnabled:     true,
    floatBtnEnabled:      true,   // ← novo
    notificationsEnabled: true,
    silentMode:           false
  });
  document.getElementById("toggleIntercept").checked     = s.interceptEnabled;
  document.getElementById("toggleFloatBtn").checked      = s.floatBtnEnabled;
  document.getElementById("toggleNotifications").checked = s.notificationsEnabled;
  document.getElementById("toggleSilent").checked        = s.silentMode;
}

// ── Eventos ───────────────────────────────────────────────────────────────────
function bindEvents() {

  // Interceptar downloads
  document.getElementById("toggleIntercept").addEventListener("change", async (e) => {
    await chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: { interceptEnabled: e.target.checked }
    });
  });

  // Botão flutuante — persiste no storage e notifica todos os content scripts
  document.getElementById("toggleFloatBtn").addEventListener("change", async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.sync.set({ floatBtnEnabled: enabled });
    // Propagar para todas as abas http/https da janela atual.
    // Filtrar por url para não tentar enviar mensagens a about:, chrome://, etc.
    // (lançaria exceção mesmo com try/catch em alguns contextos).
    const tabs = await chrome.tabs.query({ currentWindow: true, url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "setFloatBtn", enabled });
      } catch (_) { /* aba sem content script ativo — ignorar */ }
    }
  });

  // Notificações
  document.getElementById("toggleNotifications").addEventListener("change", async (e) => {
    await chrome.storage.sync.set({ notificationsEnabled: e.target.checked });
  });

  // Modo silencioso
  document.getElementById("toggleSilent").addEventListener("change", async (e) => {
    await chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: { silentMode: e.target.checked }
    });
  });

  // Download manual
  document.getElementById("manualDownload").addEventListener("click", async () => {
    const url = document.getElementById("manualUrl").value.trim();
    if (!url) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({ action: "captureDownload", url, referrer: tab?.url || "" });
    window.close();
  });

  // Capturar vídeo
  document.getElementById("btnFindVideos").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { action: "findVideos" });
    window.close();
  });

  // Verificar bridge
  document.getElementById("btnCheckBridge").addEventListener("click", checkStatus);
}
