// popup.js

const BRIDGE_URL = "http://127.0.0.1:6969";

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  await checkStatus();
  bindEvents();
});

async function checkStatus() {
  const dot  = document.getElementById("statusDot");
  const text = document.getElementById("statusText");

  try {
    const resp = await fetch(`${BRIDGE_URL}/status`, {
      signal: AbortSignal.timeout(3000)
    });
    const data = await resp.json();

    dot.classList.add("online");
    text.textContent = data.idmFound
      ? "Bridge online · IDM encontrado"
      : "Bridge online · IDM não localizado";
  } catch (_) {
    dot.classList.remove("online");
    text.textContent = "Bridge offline — inicie com: idm-bridge";
  }
}

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    interceptEnabled: true,
    notificationsEnabled: true
  });
  document.getElementById("toggleIntercept").checked     = settings.interceptEnabled;
  document.getElementById("toggleNotifications").checked = settings.notificationsEnabled;
}

function bindEvents() {
  // Toggles
  document.getElementById("toggleIntercept").addEventListener("change", async (e) => {
    await chrome.runtime.sendMessage({
      action: "updateSettings",
      settings: { interceptEnabled: e.target.checked }
    });
  });

  document.getElementById("toggleNotifications").addEventListener("change", async (e) => {
    await chrome.storage.sync.set({ notificationsEnabled: e.target.checked });
  });

  // Download manual
  document.getElementById("manualDownload").addEventListener("click", async () => {
    const url = document.getElementById("manualUrl").value.trim();
    if (!url) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.runtime.sendMessage({
      action: "captureDownload",
      url,
      referrer: tab?.url || ""
    });
    window.close();
  });

  // Capturar vídeo da página
  document.getElementById("btnFindVideos").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { action: "findVideos" });
    }
    window.close();
  });

  // Verificar bridge
  document.getElementById("btnCheckBridge").addEventListener("click", checkStatus);
}
