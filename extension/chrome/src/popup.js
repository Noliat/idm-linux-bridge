// popup.js

const BRIDGE_URL = "http://127.0.0.1:6969";

document.addEventListener("DOMContentLoaded", async () => {
  detectBrowser();
  showExtensionVersion();
  await loadSettings();
  await checkStatus();
  bindEvents();
});

// ── Versão da extensão ──────────────────────────────────────────────────────
// Lida diretamente do manifest.json via chrome.runtime.getManifest() — nunca
// fica desatualizada, pois é o próprio navegador que reporta o valor real
// instalado (substitui o "v2.2" que ficava hardcoded em popup.html e nunca
// era atualizado junto dos bumps de versão no manifest).
function showExtensionVersion() {
  const v = chrome.runtime.getManifest().version;
  const el = document.getElementById("extVersion");
  if (el) el.textContent = `v${v}`;
}

// ── Detecção de navegador ─────────────────────────────────────────────────────
function detectBrowser() {
  const isFirefox = typeof browser !== "undefined" &&
    typeof browser.runtime?.getBrowserInfo === "function";
  if (isFirefox)
    document.getElementById("interceptModeBar").classList.add("firefox");
}

// ── Status do bridge ──────────────────────────────────────────────────────────
async function checkStatus() {
  const dot   = document.getElementById("statusDot");
  const text  = document.getElementById("statusText");
  const badge = document.getElementById("bridgeVersionBadge");
  try {
    const resp = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    dot.classList.add("online");
    text.textContent = `Bridge online · ${data.idmFound ? "IDM encontrado" : "IDM não localizado"}`;
    if (data.reverseProxy) text.title = `Proxy reverso: ${data.reverseProxy}`;
    // data.version vem do endpoint /status (const Version em server.go) —
    // é a versão do PROXY, não da extensão. Os dois são versionados de
    // forma independente (ver CHANGELOG.md), então o badge mostra
    // explicitamente "bridge vX.Y.Z" para não ser confundido com a versão
    // da extensão exibida no cabeçalho (extVersion).
    if (badge) badge.textContent = data.version ? `bridge v${data.version}` : "bridge ?";
  } catch (_) {
    dot.classList.remove("online");
    text.textContent = "Bridge offline — inicie com: idm-bridge";
    // Sem conexão com o bridge, não há como saber sua versão — estado
    // neutro em vez de manter um valor antigo/hardcoded na tela.
    if (badge) badge.textContent = "bridge offline";
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
