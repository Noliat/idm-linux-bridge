// downloads_page.js — Lógica da página chrome://downloads/ substituída
//
// Acesso à chrome.downloads API disponível porque esta é uma página
// de extensão (chrome-extension://). A API retorna os mesmos dados
// que a página nativa de downloads do Chrome.

const BRIDGE_URL   = "http://127.0.0.1:6969";
const CAPTURE_URL  = `${BRIDGE_URL}/capture`;
const STATUS_URL   = `${BRIDGE_URL}/status`;

// ── Estado ────────────────────────────────────────────────────────
let allDownloads   = [];
let currentFilter  = "all";
let searchQuery    = "";
let bridgeOk       = false;

// ── Inicializar ───────────────────────────────────────────────────

async function init() {
  await checkBridge();
  await loadDownloads();
  setupListeners();
  // Atualizar a cada 2s (downloads em progresso mudam de tamanho/velocidade)
  setInterval(loadDownloads, 2000);
  setInterval(checkBridge,   8000);
}

async function checkBridge() {
  try {
    const r = await fetch(STATUS_URL, { signal: AbortSignal.timeout(2500) });
    bridgeOk = (await r.json()).status === "running";
  } catch (_) { bridgeOk = false; }

  const dot    = document.getElementById("bridge-dot");
  const label  = document.getElementById("bridge-label");
  const banner = document.getElementById("bridge-banner");

  dot.style.background    = bridgeOk ? "#22c55e" : "#ef4444";
  dot.title               = bridgeOk ? "IDM Bridge online" : "IDM Bridge offline";
  label.textContent       = bridgeOk ? "Bridge online" : "Bridge offline";
  label.style.color       = bridgeOk ? "#4ade80" : "#94a3b8";
  banner.classList.toggle("visible", !bridgeOk);

  // Atualizar botões IDM em cards já renderizados
  document.querySelectorAll(".btn-idm").forEach(btn => {
    btn.disabled = !bridgeOk;
    btn.title    = bridgeOk ? "Transferir para IDM" : "IDM Bridge offline";
  });
}

async function loadDownloads() {
  const items = await chrome.downloads.search({
    orderBy: ["-startTime"],
    limit:   500
  });
  allDownloads = items;
  render();
}

// ── Render ────────────────────────────────────────────────────────

function render() {
  const list = document.getElementById("list");

  let items = allDownloads;

  // Filtro de estado
  if (currentFilter !== "all") {
    items = items.filter(d => d.state === currentFilter ||
      (currentFilter === "interrupted" && d.error));
  }

  // Filtro de busca
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    items = items.filter(d => {
      const name = filenameOf(d).toLowerCase();
      const url  = (d.url || "").toLowerCase();
      return name.includes(q) || url.includes(q);
    });
  }

  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <div class="emoji">📭</div>
        <p>Nenhum download encontrado</p>
        <small>${currentFilter !== "all" ? "Tente mudar o filtro" : "Inicie um download para vê-lo aqui"}</small>
      </div>`;
    return;
  }

  // Renderizar cards preservando o DOM de cards já existentes
  // para não perder estados de botões (loading, etc.)
  const existingCards = new Map(
    [...list.querySelectorAll(".dl-card")].map(el => [+el.dataset.id, el])
  );

  const newCards = items.map(d => {
    const existing = existingCards.get(d.id);
    if (existing) {
      // Atualizar apenas os campos dinâmicos (progresso, estado, tamanho)
      updateCard(existing, d);
      existingCards.delete(d.id);
      return existing;
    }
    return buildCard(d);
  });

  // Remover cards que não existem mais
  existingCards.forEach(el => el.remove());

  // Manter ordem correta
  newCards.forEach((card, i) => {
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
  });
}

// ── Construir card ────────────────────────────────────────────────

function buildCard(d) {
  const card = document.createElement("div");
  card.className = "dl-card";
  card.dataset.id = d.id;
  card.innerHTML = cardHTML(d);
  attachCardListeners(card, d);
  return card;
}

function updateCard(card, d) {
  // Atualizar progresso
  const fill = card.querySelector(".dl-progress-fill");
  if (fill) {
    const pct = progressPct(d);
    fill.style.width = pct + "%";
    fill.className = "dl-progress-fill " + (d.state === "complete" ? "complete" : d.error ? "error" : "");
  }
  // Atualizar meta
  const meta = card.querySelector(".dl-meta");
  if (meta) meta.innerHTML = metaHTML(d);
  // Atualizar badge
  const badge = card.querySelector(".badge");
  if (badge) { badge.className = "badge " + badgeClass(d); badge.textContent = badgeText(d); }
  // Habilitar/desabilitar botão IDM conforme bridge
  const btn = card.querySelector(".btn-idm");
  if (btn && !btn.classList.contains("loading")) {
    btn.disabled = !bridgeOk || d.state === "complete";
  }
}

function cardHTML(d) {
  const name    = filenameOf(d);
  const iconCls = iconClass(name);
  const iconCh  = iconChar(iconCls);
  const pct     = progressPct(d);
  const bCls    = badgeClass(d);
  const bText   = badgeText(d);

  return `
    <div class="dl-icon ${iconCls}">${iconCh}</div>
    <div class="dl-info">
      <div class="dl-name" title="${esc(d.url)}">${esc(name)}</div>
      <div class="dl-meta">${metaHTML(d)}</div>
      <div class="dl-progress-bar">
        <div class="dl-progress-fill ${d.state === "complete" ? "complete" : d.error ? "error" : ""}"
             style="width:${pct}%"></div>
      </div>
    </div>
    <div class="dl-actions">
      <button class="btn-idm" title="Transferir para IDM"
              ${!bridgeOk ? "disabled" : ""}>
        <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        <span class="btn-label">⬇ Transferir para IDM</span>
      </button>
      <button class="btn-icon copy-url" title="Copiar URL">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
          <rect x="5" y="5" width="9" height="9" rx="1.5"/>
          <path d="M11 5V3a1.5 1.5 0 00-1.5-1.5H3A1.5 1.5 0 001.5 3v6.5A1.5 1.5 0 003 11h2"/>
        </svg>
      </button>
      ${d.state === "complete" ? `
      <button class="btn-icon show-folder" title="Abrir pasta">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
          <path d="M1.5 4.5A1.5 1.5 0 013 3h3l1.5 1.5H13A1.5 1.5 0 0114.5 6v6A1.5 1.5 0 0113 13.5H3A1.5 1.5 0 011.5 12V4.5z"/>
        </svg>
      </button>` : ""}
      <button class="btn-icon danger remove-dl" title="Remover da lista">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
          <path d="M2 4h12M5 4V2.5h6V4M6 7v5M10 7v5M3 4l1 9.5h8L13 4"/>
        </svg>
      </button>
    </div>`;
}

function attachCardListeners(card, d) {
  // ── Transferir para IDM ──────────────────────────────────────────
  card.querySelector(".btn-idm").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (btn.disabled || btn.classList.contains("loading")) return;

    btn.classList.add("loading");
    btn.disabled = true;

    try {
      // Cancelar o download do Chrome para evitar conflito de arquivo
      const [current] = await chrome.downloads.search({ id: d.id });
      if (current?.state === "in_progress") {
        await chrome.downloads.cancel(d.id);
      }

      // Obter cookies para a URL do download
      const cookieList = await chrome.cookies.getAll({ url: d.url });
      const cookies    = cookieList.map(c => `${c.name}=${c.value}`).join("; ");

      const filename = filenameOf(d);

      // Enviar ao IDM Bridge
      const resp = await fetch(CAPTURE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url:        d.url,
          filename,
          cookies,
          referrer:   d.referrer || "",
          userAgent:  navigator.userAgent,
          site:       hostnameOf(d.url),
          silent:     false,
          headers:    {},
          requestType: "download"
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        showToast(`✓ Enviado ao IDM: ${filename}`, "success");
        // Remover da lista de downloads do Chrome
        setTimeout(() => chrome.downloads.erase({ id: d.id }), 800);
      } else {
        throw new Error(`HTTP ${resp.status}`);
      }
    } catch (err) {
      showToast(`✗ Erro: ${err.message}`, "error");
      btn.classList.remove("loading");
      btn.disabled = !bridgeOk;
    }
  });

  // ── Copiar URL ───────────────────────────────────────────────────
  card.querySelector(".copy-url")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(d.url).catch(() => {});
    showToast("URL copiada", "success");
  });

  // ── Abrir pasta ──────────────────────────────────────────────────
  card.querySelector(".show-folder")?.addEventListener("click", () => {
    chrome.downloads.show(d.id);
  });

  // ── Remover da lista ─────────────────────────────────────────────
  card.querySelector(".remove-dl")?.addEventListener("click", async () => {
    try {
      if (d.state === "in_progress") await chrome.downloads.cancel(d.id);
      await chrome.downloads.erase({ id: d.id });
      allDownloads = allDownloads.filter(x => x.id !== d.id);
      card.remove();
    } catch (_) {}
  });
}

// ── Helpers ───────────────────────────────────────────────────────

function metaHTML(d) {
  const parts = [];
  if (d.fileSize > 0 || d.bytesReceived > 0) {
    const total = d.fileSize || d.totalBytes || 0;
    const recv  = d.bytesReceived || 0;
    if (total > 0 && d.state !== "complete") {
      parts.push(`${fmtBytes(recv)} / ${fmtBytes(total)}`);
    } else if (d.state === "complete" && total > 0) {
      parts.push(fmtBytes(total));
    } else if (recv > 0) {
      parts.push(fmtBytes(recv));
    }
  }
  if (d.state === "in_progress" && d.estimatedEndTime) {
    const ms = new Date(d.estimatedEndTime) - Date.now();
    if (ms > 0 && ms < 86400000) parts.push(fmtTime(ms / 1000));
  }
  const pct = progressPct(d);
  if (d.state === "in_progress" && pct > 0) parts.push(`${pct}%`);
  parts.push(`<span class="badge ${badgeClass(d)}">${badgeText(d)}</span>`);
  const host = hostnameOf(d.url);
  if (host) parts.push(host);
  return parts.join(" &bull; ");
}

function progressPct(d) {
  const total = d.fileSize || d.totalBytes || 0;
  if (d.state === "complete") return 100;
  if (!total || !d.bytesReceived) return 0;
  return Math.min(100, Math.round(d.bytesReceived / total * 100));
}

function badgeClass(d) {
  if (d.state === "complete")    return "complete";
  if (d.state === "interrupted" || d.error) return "interrupted";
  if (d.state === "in_progress" && d.paused) return "paused";
  if (d.state === "in_progress") return "in-progress";
  return "cancelled";
}

function badgeText(d) {
  if (d.state === "complete")    return "Concluído";
  if (d.state === "interrupted" || d.error) return "Erro";
  if (d.state === "in_progress" && d.paused) return "Pausado";
  if (d.state === "in_progress") return "Baixando";
  return "Cancelado";
}

function filenameOf(d) {
  if (d.filename) return d.filename.replace(/^.*[/\\]/, "");
  try { return decodeURIComponent(new URL(d.url).pathname.split("/").pop() || "download"); }
  catch (_) { return "download"; }
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
}

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576)    return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024)       return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

function fmtTime(secs) {
  if (secs < 60)   return Math.round(secs) + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + Math.round(secs % 60) + "s";
  return Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m";
}

function esc(s) {
  return (s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

const VIDEO_EXT   = /\.(mp4|mkv|avi|mov|webm|m4v|ts|flv|wmv|mpg|mpeg|3gp)$/i;
const AUDIO_EXT   = /\.(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i;
const DOC_EXT     = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|epub|mobi|txt|csv)$/i;
const ARCHIVE_EXT = /\.(zip|rar|7z|tar|gz|bz2|xz|zst|iso|img)$/i;
const APP_EXT     = /\.(exe|msi|deb|rpm|apk|dmg|pkg|sh|bin)$/i;

function iconClass(name) {
  if (VIDEO_EXT.test(name))   return "video";
  if (AUDIO_EXT.test(name))   return "audio";
  if (DOC_EXT.test(name))     return "doc";
  if (ARCHIVE_EXT.test(name)) return "archive";
  if (APP_EXT.test(name))     return "app";
  return "other";
}

function iconChar(cls) {
  return { video:"🎬", audio:"🎵", doc:"📄", archive:"📦", app:"⚙️", other:"📁" }[cls] || "📁";
}

// ── Toast ─────────────────────────────────────────────────────────

let _toastTimer;
function showToast(msg, type = "") {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className   = "show " + type;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { toast.className = ""; }, 3500);
}

// ── Listeners de filtro e busca ───────────────────────────────────

function setupListeners() {
  // Filtros de estado
  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentFilter = btn.dataset.filter;
      render();
    });
  });

  // Busca com debounce
  let searchTimer;
  document.getElementById("search").addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchQuery = e.target.value.trim();
      render();
    }, 200);
  });

  // Reagir a novos downloads iniciados enquanto a página está aberta
  chrome.downloads.onCreated.addListener(item => {
    allDownloads.unshift(item);
    render();
  });

  // Reagir a mudanças de estado (progresso, conclusão, erro)
  chrome.downloads.onChanged.addListener(delta => {
    const idx = allDownloads.findIndex(d => d.id === delta.id);
    if (idx < 0) return;
    // Aplicar delta ao item existente
    const d = { ...allDownloads[idx] };
    if (delta.state)          d.state          = delta.state.current;
    if (delta.bytesReceived)  d.bytesReceived  = delta.bytesReceived.current;
    if (delta.fileSize)       d.fileSize       = delta.fileSize.current;
    if (delta.totalBytes)     d.totalBytes     = delta.totalBytes.current;
    if (delta.estimatedEndTime) d.estimatedEndTime = delta.estimatedEndTime.current;
    if (delta.error)          d.error          = delta.error.current;
    if (delta.paused)         d.paused         = delta.paused.current;
    allDownloads[idx] = d;
    render();
  });

  // Reagir a remoções
  chrome.downloads.onErased.addListener(id => {
    allDownloads = allDownloads.filter(d => d.id !== id);
    render();
  });
}

// ── Arrancar ──────────────────────────────────────────────────────
init();
