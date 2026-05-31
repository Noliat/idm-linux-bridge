// content.js — document_idle — UI, botão flutuante, detecção de links
// v1.6 — lógica de exibição do botão simplificada e robusta

(function () {
  "use strict";

  if (window.__idmBridgeInjected) return;
  window.__idmBridgeInjected = true;

  // ── Mídias capturadas pelo interceptor (world: MAIN) ─────────
  // O interceptor.js usa postMessage (mais confiável que CustomEvent
  // para cruzar a barreira MAIN → ISOLATED no Chrome MV3).
  const pageMedia = new Map();
  const ORIGIN = window.origin || location.origin;

  // Mapa de chaves HLS capturadas pelo interceptor.js
  // key: URL do manifest ou "key:<url>" — value: array de objetos de chave
  const hlsKeys = new Map();

  window.addEventListener("message", (e) => {
    if (e.origin !== ORIGIN) return;
    if (!e.data?.__idmBridge) return;

    const { type, data } = e.data;

    // ── Mídia detectada ───────────────────────────────────────────────────
    if (type === "media") {
      if (!data?.url) return;
      pageMedia.set(data.url, data);

      // Pulsar o botão ao detectar nova mídia
      const bar = document.getElementById("idm-bar");
      if (bar) {
        bar.style.transition = "filter 0.3s";
        bar.style.filter = "brightness(1.4)";
        setTimeout(() => { bar.style.filter = ""; }, 350);
      }
      return;
    }

    // ── Chaves AES-128 do manifest HLS (parser M3U8) ──────────────────────
    // data = { manifestUrl, keys: [{ method, uri, iv, keyFormat }] }
    if (type === "hlsKeys") {
      if (data?.manifestUrl && Array.isArray(data.keys)) {
        hlsKeys.set(data.manifestUrl, data.keys);
      }
      return;
    }

    // ── Chave AES-128 capturada via XHR (16 bytes reais) ─────────────────
    // data = { url, keyBytes: number[], keyB64: string }
    if (type === "hlsKey") {
      if (data?.url && data.keyBytes) {
        hlsKeys.set("key:" + data.url, [{ method: "AES-128", uri: data.url, bytes: data.keyB64 }]);
      }
      return;
    }
  });

  // ── Extensões de download direto ─────────────────────────────
  const DL_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|mp3|flac|wav|aac|zip|rar|7z|gz|pdf|exe|deb|iso|apk|torrent)(\?.*)?$/i;

  // ─────────────────────────────────────────────────────────────
  // Interceptar cliques em links de download
  // ─────────────────────────────────────────────────────────────

  document.addEventListener("click", async (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    const href = a.href;
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;
    if (!a.hasAttribute("download") && !DL_EXT.test(href)) return;

    let available = false;
    try { available = (await chrome.runtime.sendMessage({ action: "getBridgeStatus" }))?.available; } catch (_) {}
    if (!available) return;

    e.preventDefault();
    e.stopPropagation();
    try {
      await chrome.runtime.sendMessage({
        action: "captureDownload",
        url: href,
        filename: a.getAttribute("download") || "",
        cookies: document.cookie,
        referrer: location.href
      });
    } catch (_) {}
  }, true);

  // ─────────────────────────────────────────────────────────────
  // Mensagens do background
  // ─────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.action === "ping") { respond({ ok: true }); return false; }

    if (msg.action === "findVideos") {
      const videos = detectVideos();
      try { chrome.runtime.sendMessage({ action: "videosFound", videos }).catch(() => {}); } catch (_) {}
      respond({ count: videos.length });
      return true;
    }

    // setFloatBtn — enviado pelo popup ao mudar o toggle.
    // Liga ou desliga o botão flutuante em tempo real, sem recarregar a página.
    if (msg.action === "setFloatBtn") {
      if (msg.enabled) {
        // Reativar: remover classe idm-closed e deixar o PlayerWatcher retomar.
        const wrap = document.getElementById("idm-float");
        if (wrap) {
          wrap.classList.remove("idm-closed");
        } else {
          // Botão ainda não foi injetado — tentar agora
          btnInjected = false;
          tryShow();
        }
      } else {
        // Desativar: marcar como fechado permanentemente até o popup reativar.
        const wrap = document.getElementById("idm-float");
        if (wrap) wrap.classList.add("idm-closed");
      }
      respond({ ok: true });
      return true;
    }

    return true;
  });

  // ─────────────────────────────────────────────────────────────
  // Botão flutuante — lógica de exibição
  // ─────────────────────────────────────────────────────────────

  // Mostrar o botão em QUALQUER página que tenha <video> ou <audio>,
  // ou nos sites de vídeo conhecidos (player pode carregar depois).
  // Sincronizado com background.js — qualquer alteração deve ser refletida nos dois
  const VIDEO_SITES = [
    "youtube.com", "youtu.be", "drive.google.com", "hotmart.com",
    "udemy.com", "coursera.org", "dropbox.com", "mega.nz",
    "twitch.tv", "vimeo.com", "dailymotion.com", "facebook.com",
    "instagram.com", "twitter.com", "x.com", "reddit.com", "tiktok.com"
  ];

  const host = location.hostname.replace(/^www\./, "");
  const isKnownVideoSite = VIDEO_SITES.some(s => host === s || host.endsWith("." + s));

  let btnInjected = false;

  function shouldShow() {
    if (btnInjected) return false;
    // Sempre mostrar em sites conhecidos
    if (isKnownVideoSite) return true;
    // Mostrar em qualquer página com <video> ou <audio>
    if (document.querySelector("video, audio")) return true;
    // Mostrar se o interceptor já capturou algo
    if (pageMedia.size > 0) return true;
    return false;
  }

  function tryShow() {
    if (btnInjected) return;
    if (!shouldShow()) return;
    btnInjected = true;
    obs.disconnect();
    buildFloatBtn();
  }

  // Observer no documentElement — nunca é null
  const obs = new MutationObserver(tryShow);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  // Verificar a preferência do usuário (toggle do popup) antes de injetar.
  // Lê do storage uma vez — o PlayerWatcher só roda se o botão for habilitado.
  // Mudanças posteriores chegam via mensagem setFloatBtn (sem reload).
  chrome.storage.sync.get({ floatBtnEnabled: true }, ({ floatBtnEnabled }) => {
    if (!floatBtnEnabled) return; // toggle desligado — não injetar
    // Tentar logo após o idle (document_idle = DOM pronto)
    tryShow();
    // Último recurso: verificar após 3s (players lentos)
    setTimeout(tryShow, 3000);
  });

  // ─────────────────────────────────────────────────────────────
  // buildFloatBtn — constrói o widget completo
  // ─────────────────────────────────────────────────────────────

  function buildFloatBtn() {
    // Remover instância anterior se existir
    document.getElementById("idm-float")?.remove();
    document.getElementById("__idm_style")?.remove();

    // ── CSS ─────────────────────────────────────────────────────
    const css = document.createElement("style");
    css.id = "__idm_style";
    css.textContent = `

      /* ═══════════════════════════════════════════════════════════
         IDM Linux Bridge — Float Button  v2.2
         Inspiração visual: botão flutuante nativo do IDM Windows.

         O botão original do IDM é uma janela Win32 sem bordas com:
           - Fundo azul-escuro  (#0f2744 → #091b30) degradê vertical
           - Ícone esférico azul-cobalto com seta laranja para baixo
           - Texto branco/azul-claro "Download with IDM"
           - Borda fina cinza-escura + sombra drop suave
           - Separadores verticais entre ícone, texto e botões
           - Botão ▾ (resoluções) e ✕ (fechar) à direita
         ═══════════════════════════════════════════════════════════ */

      /* ── Contêiner raiz ─────────────────────────────────────── */
      #idm-float {
        all: initial;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 2147483647 !important;
        font-family: "Segoe UI", Tahoma, Arial, sans-serif !important;
        font-size: 12px !important;
        user-select: none !important;
        will-change: transform !important;
        /* Idle: quase transparente para não atrapalhar o conteúdo */
        opacity: 0.22 !important;
        transition: opacity 0.20s ease !important;
      }
      #idm-float * { box-sizing: border-box !important; }

      /* Focado: hover ou dragging */
      #idm-float:hover,
      #idm-float.idm-focused { opacity: 1 !important; }

      /* Oculto por ausência de player — fade + leve recuo */
      #idm-float.idm-hidden {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: scale(0.92) !important;
      }

      /* Fechado pelo usuário */
      #idm-float.idm-closed { display: none !important; }

      /* ── Fundo para os botões arr, cls e lbl ────────────────── */

      #idm-bg-lbl {
        display: flex !important;
        align-items: stretch !important;
        height: 14.24px !important;
        width: 101px !important;
        border-radius: 2.5px !important;
        overflow: visible !important;
        cursor: grab !important;                
        position: relative !important;

        /* Degradê vertical — igual ao fundo do botão nativo */
        background: linear-gradient(180deg,
          #1a3d6b 0%,
          #0f2744 45%,
          #091b30 100%) !important;

        /* Bordas: topo/esq com leve brilho, dir/baixo escuras */
        border-top:    1px solid rgba(100,160,240,0.30) !important;
        border-left:   1px solid rgba(80,130,210,0.22)  !important;
        border-right:  1px solid rgba(0,0,0,0.60)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.70)       !important;

        /* Sombra: o original tem drop-shadow moderado
        box-shadow:
          0 0.50px 1.5px  rgba(0,0,0,0.60),
          0 0.25px 0.50px  rgba(0,0,0,0.45),
          inset 0 0.25px 0 rgba(130,185,255,0.12) !important; */
      }
      #idm-bg-lbl:active { background: rgba(0,0,0,0.25) !important; cursor: grabbing !important; }
      
      #idm-bg-lbl:hover { 
        background: rgba(255,255,255,0.10) !important; }

      /* Linha de brilho do topo — efeito "vidro" Win32 */
      #idm-bg-lbl::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important; left: 2px !important; right: 2px !important;
        height: 1px !important;
        background: linear-gradient(90deg,
          transparent,
          rgba(160,210,255,0.45) 20%,
          rgba(180,220,255,0.55) 50%,
          rgba(160,210,255,0.45) 80%,
          transparent) !important;
        pointer-events: none !important;
      }

      #idm-bg-bt {
        display: flex !important;
        align-items: stretch !important;
        height: 14.24px !important;
        width: 14.24px !important;
        border-radius: 2.5px !important;        
        overflow: visible !important;
        cursor: grab !important;
        position: relative !important;

        /* Degradê vertical — igual ao fundo do botão nativo */
        background: linear-gradient(180deg,
          #1a3d6b 0%,
          #0f2744 45%,
          #091b30 100%) !important;

        /* Bordas: topo/esq com leve brilho, dir/baixo escuras */
        border-top:    1px solid rgba(100,160,240,0.30) !important;
        border-left:   1px solid rgba(80,130,210,0.22)  !important;
        border-right:  1px solid rgba(0,0,0,0.60)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.70)       !important;

        /* Sombra: o original tem drop-shadow moderado 
        box-shadow:
          0 0.50px 1.5px  rgba(0,0,0,0.60),
          0 0.25px 0.50px  rgba(0,0,0,0.45),
          inset 0 0.25px 0 rgba(130,185,255,0.12) !important; */
      }
      #idm-bg-bt:active { 
        cursor: grabbing !important;         
        border-radius: 2.5px !important; 
        background: rgba(0,0,0,0.25) !important; }

      #idm-bg-bt:hover {
        border-radius: 2.5px !important; 
        background: rgba(255,255,255,0.10) !important; }

      /* Linha de brilho do topo — efeito "vidro" Win32 */
      #idm-bg-bt::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important; left: 2px !important; right: 2px !important;
        height: 1px !important;
        background: linear-gradient(90deg,
          transparent,
          rgba(160,210,255,0.45) 20%,
          rgba(180,220,255,0.55) 50%,
          rgba(160,210,255,0.45) 80%,
          transparent) !important;
        pointer-events: none !important;
      }

      /* ── Barra principal ────────────────────────────────────── */
      /* Réplica fiel do botão Win32 do IDM:
           - Degradê vertical azul escuro (topo iluminado, base escura)
           - Borda sutil: topo/esq mais clara, dir/baixo mais escura
           - Sombra drop externa + brilho interno no topo */
           
      #idm-bar {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        height: 20px !important;
        width: 142px !important;
        border-radius: 2px !important;
        overflow: visible !important;
        cursor: grab !important;
        position: relative !important;        
        gap: 2.3px !important;

        /* Degradê vertical — igual ao fundo do botão nativo */
        background: linear-gradient(180deg,
          #1a3d6b 0%,
          #0f2744 45%,
          #091b30 100%) !important;

        /* Bordas: topo/esq com leve brilho, dir/baixo escuras */
        border-top:    1px solid rgba(100,160,240,0.30) !important;
        border-left:   1px solid rgba(80,130,210,0.22)  !important;
        border-right:  1px solid rgba(0,0,0,0.60)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.70)       !important;

        /* Sombra: o original tem drop-shadow moderado */
        box-shadow:
          0 2px 6px  rgba(0,0,0,0.60),
          0 1px 2px  rgba(0,0,0,0.45),
          inset 0 1px 0 rgba(130,185,255,0.12) !important;
      }
      #idm-bar:active { cursor: grabbing !important; }

      /* Linha de brilho do topo — efeito "vidro" Win32 */
      #idm-bar::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important; left: 2px !important; right: 2px !important;
        height: 1px !important;
        background: linear-gradient(90deg,
          transparent,
          rgba(160,210,255,0.45) 20%,
          rgba(180,220,255,0.55) 50%,
          rgba(160,210,255,0.45) 80%,
          transparent) !important;
        pointer-events: none !important;
      }

      /* ── Área do ícone ──────────────────────────────────────── */
      /* No botão original: quadrado ~32×32 com fundo levemente
         mais escuro, separado do texto por uma linha vertical */
      #idm-ico {
        display: flex !important;
        align-items: stretch !important;
        justify-content: center !important;
        width: 14.24px !important;
        height: 14.28px !important;
        flex-shrink: 0 !important;     
        border-radius: 2px !important;
        margin-left: 4px !important;
        margin-top: 2px !important;

        /* Fundo ligeiramente diferente do texto — como no original 
        background: linear-gradient(180deg,
          rgba(255,255,255,0.05) 0%,
          rgba(0,0,0,0.08) 100%) !important;
          padding: 3px !important; */
      }
      
      /* ── Texto principal ────────────────────────────────────── */
      /* Original: "Download with IDM" em branco/azul-claro,
         fonte Tahoma/Segoe ~11-12px, sem negrito */
      #idm-lbl {
        flex: 1 !important;
        color: #c8dff5 !important;       
        font-weight: 2.5 !important;
        font-size: 10px !important;        
        align-items: stretch !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        cursor: pointer !important;            
        border-radius: 2px !important;
        padding: 5px 3px 5px 4px !important;
        line-height: 1px !important;
        letter-spacing: 0.01em !important;
      }
      #idm-lbl:hover { color: #f97316 !important;    
        font-weight: 5 !important; }

      /* ── Botões de ação ─────────────────────────────────────── */
      /* ▾ e ✕: separados por linha vertical do texto,
         cor cinza-azulada, clareiam no hover */
      #idm-arr, #idm-cls {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;        
        cursor: pointer !important;
        flex-shrink: 0 !important;
        border-radius: 2px !important;
        transition: background 0.10s !important;
        color: rgba(160,200,245,0.70) !important;
      }
      
      #idm-arr {
        width: 5,0 px !important;
        height: 3,58 px !important; 
        padding: 2px !important;  
        margin-left: 1.55px !important;
        margin-top: 0.40px !important;
      }

      #idm-cls {    
        font-size: 10px !important; 
        font-weight: 1.5 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        cursor: pointer !important;            
        border-radius: 2px !important;
        padding: 2px !important;
        margin-top: 0.25px
        margin-left: 1.55px !important;
        line-height: 1px !important;
        letter-spacing: 0.01em !important; 
        }

      #idm-arr:hover, #idm-cls:hover { color: #f97316 !important; }

      /* Seta vira laranja (cor de acento IDM) quando dropdown abre */
      #idm-arr.open {
        transform: rotate(180deg) !important;
        color: #f97316 !important;
      }

      /* ── Dropdown de resoluções ─────────────────────────────── */
      #idm-drop {
        position: absolute !important;
        top: calc(100% + 3px) !important;
        right: 0 !important;
        min-width: 240px !important;
        max-width: 340px !important;
        max-height: 300px !important;
        overflow-y: auto !important;
        display: none !important;
        flex-direction: column !important;
        border-radius: 3px !important;

        /* Mesma paleta da barra */
        background: #0b1e33 !important;
        border-top:    1px solid rgba(80,140,220,0.30)  !important;
        border-left:   1px solid rgba(60,110,190,0.20)  !important;
        border-right:  1px solid rgba(0,0,0,0.55)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.65)       !important;
        box-shadow:
          0 6px 20px rgba(0,0,0,0.65),
          0 2px 5px  rgba(0,0,0,0.45),
          inset 0 1px 0 rgba(100,170,255,0.08) !important;
      }
      #idm-drop.open { display: flex !important; }
      #idm-drop::-webkit-scrollbar { width: 5px !important; }
      #idm-drop::-webkit-scrollbar-track {
        background: rgba(0,0,0,0.2) !important;
      }
      #idm-drop::-webkit-scrollbar-thumb {
        background: rgba(80,140,220,0.35) !important;
        border-radius: 3px !important;
      }

      /* Cabeçalho do dropdown — faixa azul mais clara */
      #idm-drop-head {
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        padding: 7px 10px 6px !important;
        background: linear-gradient(180deg,
          #1a3d6b 0%, #0f2744 100%) !important;
        border-bottom: 1px solid rgba(255,255,255,0.07) !important;
        border-radius: 2px 2px 0 0 !important;
        flex-shrink: 0 !important;
      }
      #idm-drop-title {
        font-size: 10.5px !important;
        font-weight: 600 !important;
        color: #a8cbf0 !important;
        letter-spacing: 0.03em !important;
        text-shadow: 0 1px 2px rgba(0,0,0,0.6) !important;
      }

      /* Seção label (VIDEO, ÁUDIO…) */
      .idm-sec {
        padding: 5px 10px 2px !important;
        font-size: 9px !important;
        font-weight: 700 !important;
        text-transform: uppercase !important;
        letter-spacing: 1px !important;
        color: #2d5a9e !important;
      }

      /* Divisor */
      .idm-div {
        height: 1px !important;
        background: rgba(255,255,255,0.05) !important;
        margin: 2px 8px !important;
      }

      /* Linha de item de mídia */
      .idm-row {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 6px 10px !important;
        cursor: pointer !important;
        color: #b8d4f0 !important;
        background: none !important;
        border: none !important;
        width: calc(100% - 6px) !important;
        margin: 1px 3px !important;
        text-align: left !important;
        border-radius: 2px !important;
        transition: background 0.09s !important;
      }
      .idm-row:hover {
        background: rgba(25,90,195,0.32) !important;
        color: #e0f0ff !important;
      }
      .idm-row:active { background: rgba(25,90,195,0.50) !important; }

      /* Ícone de tipo de mídia */
      .idm-ico2 {
        width: 22px !important; height: 22px !important;
        border-radius: 3px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 11px !important;
        flex-shrink: 0 !important;
      }
      .t-video .idm-ico2 { background: rgba(249,115,22,0.16) !important; }
      .t-audio .idm-ico2 { background: rgba(59,130,246,0.16) !important; }
      .t-hls   .idm-ico2 { background: rgba(168,85,247,0.16) !important; }

      /* Informações textuais do item */
      .idm-info { flex: 1 !important; overflow: hidden !important; min-width: 0 !important; }

      .idm-meta {
        font-size: 9px !important;
        color: #2d5a9e !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        margin-top: 1px !important;
      }

      /* ── Badge de resolução/qualidade ───────────────────────────────────
         Layout: número grande + tier sobrescrito pequeno no canto superior.
         Ex: "1080" com "HD" em superscript → lê-se "1080 HD" visualmente.  */
      .idm-badge {
        display: inline-flex !important;
        align-items: baseline !important;
        gap: 1px !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        padding: 2px 7px 2px 6px !important;
        border-radius: 3px !important;
        flex-shrink: 0 !important;
        letter-spacing: 0.01em !important;
        white-space: nowrap !important;
        line-height: 1.1 !important;
        background: rgba(249,115,22,0.13) !important;
        color: #f97316 !important;
        border: 1px solid rgba(249,115,22,0.28) !important;
        align-self: center !important;
      }
      /* "HD", "FHD", "UHD" — sobrescrito menor no canto superior-direito
          do número. Tamanho 7px + vertical-align:super dá o efeito pedido. */
      .idm-badge-tier {
        font-size: 7px !important;
        font-weight: 800 !important;
        letter-spacing: 0.06em !important;
        vertical-align: super !important;
        line-height: 0 !important;
        opacity: 0.90 !important;
        margin-left: 1px !important;
      }

      /* ── Linha de nome: nome truncado + extensão na mesma linha ─────────
         Flexbox com min-width:0 garante o truncamento do texto no meio
         sem empurrar a extensão para fora do contêiner.               */
      .idm-name {
        display: flex !important;
        align-items: baseline !important;
        gap: 0 !important;
        min-width: 0 !important;
        font-weight: 600 !important;
        font-size: 11px !important;
        color: #d0e8ff !important;
      }
      /* Parte do nome: cresce e trunca com reticências */
      .idm-name-text {
        flex: 1 !important;
        min-width: 0 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
      /* ".MP4" / ".MKV" — mesmo tamanho do nome mas cor diferente,
         não trunca (flex-shrink:0), separado por espaço estreito. */
      .idm-ext {
        flex-shrink: 0 !important;
        font-size: 10px !important;
        font-weight: 700 !important;
        color: #5b8ec4 !important;
        letter-spacing: 0.04em !important;
        text-transform: uppercase !important;
        margin-left: 4px !important;
        opacity: 0.90 !important;
      }

      /* Estado vazio */
      .idm-empty {
        padding: 16px 12px !important;
        color: #2d5a9e !important;
        font-size: 11px !important;
        text-align: center !important;
        line-height: 1.5 !important;
      }

      /* Spinner de scan */
      .idm-spin-wrap {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 11px 12px !important;
        color: #2d5a9e !important;
        font-size: 11px !important;
      }
      .idm-spin {
        width: 13px !important; height: 13px !important;
        border: 2px solid rgba(80,140,220,0.18) !important;
        border-top-color: #3b82f6 !important;
        border-radius: 50% !important;
        animation: idm-spin 0.65s linear infinite !important;
        flex-shrink: 0 !important;
      }
      @keyframes idm-spin { to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(css);

    // ── HTML ────────────────────────────────────────────────────
    const logoPath = chrome.runtime.getURL("icons/logo.png");
    const wrap = document.createElement("div");
    wrap.id = "idm-float";
    wrap.innerHTML = `
      <div id="idm-bar" title="Baixar com IDM">

        <!-- Ícone: esfera azul-cobalto com seta laranja para baixo,
             inspirada no ícone oficial do IDM (globe + download arrow) -->            

          <!-- Texto: igual ao "Download with IDM" do botão original -->
        <span id="idm-bg-lbl">
          <span id="idm-ico">
            <img src="${logoPath}" 
              alt="Logo" 
              width="9.33" 
              height="7.57" />
            </span>  
          <span id="idm-lbl">Baixar com IDM</span>
        </span>

        <!-- ▾: abre dropdown de resoluções -->
        <span id="idm-bg-bt">
        <span id="idm-arr" title="Ver resoluções disponíveis">▾</span>
        </span>

        <!-- ✕: fechar -->
        <span id="idm-bg-bt">
        <span id="idm-cls" title="Fechar">✕</span>
        </span>
      </div>

      <!-- Dropdown de mídias detectadas -->
      <div id="idm-drop">
        <div id="idm-drop-head">
          <!-- Ícone menor no cabeçalho do dropdown -->
          <svg width="13" height="13" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="idmSph2" cx="36%" cy="32%" r="68%">
                <stop offset="0%"   stop-color="#7ec8ff"/>
                <stop offset="100%" stop-color="#0d3070"/>
              </radialGradient>
              <clipPath id="idmClp2"><circle cx="10" cy="9.5" r="7.8"/></clipPath>
            </defs>
            <circle cx="10" cy="9.5" r="7.8" fill="url(#idmSph2)"/>
            <g clip-path="url(#idmClp2)" fill="none"
               stroke="rgba(255,255,255,0.25)" stroke-width="0.8">
              <ellipse cx="10" cy="9.5" rx="7.8" ry="2.8"/>
              <ellipse cx="10" cy="9.5" rx="2.8" ry="7.8"/>
            </g>
            <rect    x="9.1" y="11.0" width="1.8" height="4.2" rx="0.9" fill="#f97316"/>
            <polygon points="7.0,13.8 10,17.4 13,13.8"                   fill="#f97316"/>
          </svg>
          <span id="idm-drop-title">Internet Download Manager</span>
        </div>
        <div class="idm-spin-wrap">
          <div class="idm-spin"></div>
          Escaneando player...
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    const bar  = wrap.querySelector("#idm-bar");
    const lbl  = wrap.querySelector("#idm-lbl");
    const arr  = wrap.querySelector("#idm-arr");
    const cls  = wrap.querySelector("#idm-cls");
    const drop = wrap.querySelector("#idm-drop");

    // ── Fechar ───────────────────────────────────────────────────
    cls.addEventListener("click", e => { e.stopPropagation(); wrap.classList.add("idm-closed"); });

    // ── Arrastar ─────────────────────────────────────────────────
    makeDraggable(wrap, bar);

    // ── Dropdown ─────────────────────────────────────────────────
    let open = false, scanned = false;

    function openDrop() {
      open = true;
      arr.classList.add("open");
      drop.classList.add("open");
      bar.removeAttribute("title");
      if (!scanned) { scanned = true; populateDrop(); }
    }
    function closeDrop() {
      open = false;
      arr.classList.remove("open");
      drop.classList.remove("open");
      bar.setAttribute("title", "Baixar com IDM");
    }

    arr.addEventListener("click", e => { e.stopPropagation(); open ? closeDrop() : openDrop(); });
    document.addEventListener("click", e => { if (!wrap.contains(e.target)) closeDrop(); }, true);

    // ── Clique no label ───────────────────────────────────────────
    // Regra:
    //   - 0 mídias detectadas → abrir dropdown (exibe "nenhuma mídia")
    //   - 1 mídia detectada   → download direto sem abrir dropdown
    //   - 2+ mídias           → abrir dropdown para o usuário escolher
    lbl.addEventListener("click", e => {
      e.stopPropagation();
      const items = detectVideos();
      if (items.length === 1) {
        sendDownload(items[0]);
      } else {
        openDrop();
      }
    });

    // ── Popular dropdown ─────────────────────────────────────────
    function populateDrop() {
      // Aguardar 500ms para o interceptor ter tempo de capturar
      // antes de renderizar — importante no YouTube
      const render = () => {
        const items = detectVideos();
        drop.innerHTML = "";

        if (!items.length) {
          drop.innerHTML = `<div class="idm-empty">Nenhuma mídia detectada.<br>Inicie a reprodução e tente novamente.</div>`;
          // Tentar de novo em 2s (player pode ainda estar carregando)
          setTimeout(() => { if (drop.classList.contains("open")) { scanned = false; populateDrop(); } }, 2000);
          return;
        }

        // Ordenar vídeos por resolução (maior primeiro)
        function sortByRes(arr) {
          return arr.sort((a, b) => {
            const ah = a.height || parseInt(a.label) || 0;
            const bh = b.height || parseInt(b.label) || 0;
            return bh - ah;
          });
        }

        const muxed   = sortByRes(items.filter(v => v.type === "video" && v.muxed));
        const vidOnly = sortByRes(items.filter(v => v.type === "video" && !v.muxed));
        const streams = items.filter(v => v.type === "hls" || v.type === "dash");
        const audio   = items.filter(v => v.type === "audio");

        if (muxed.length) {
          addSection(`⭐ Vídeo + Áudio — ${muxed.length} qualidades`);
          muxed.forEach(v => drop.appendChild(makeRow(v, "t-video", "⭐")));
        }
        if (vidOnly.length) {
          if (muxed.length) addDiv();
          addSection(`🎬 Vídeo puro — ${vidOnly.length} qualidades`);
          vidOnly.forEach(v => drop.appendChild(makeRow(v, "t-video", "🎬")));
        }
        if (streams.length) {
          if (muxed.length || vidOnly.length) addDiv();
          addSection(`📡 Stream — ${streams.length}`);
          streams.forEach(v => drop.appendChild(makeRow(v, "t-hls", "📡")));
        }
        if (audio.length) {
          if (muxed.length || vidOnly.length || streams.length) addDiv();
          addSection(`🎵 Áudio — ${audio.length} qualidades`);
          audio.forEach(v => drop.appendChild(makeRow(v, "t-audio", "🎵")));
        }
      };

      // Pequeno delay para YT ter tempo de definir ytInitialPlayerResponse
      setTimeout(render, 600);

      function addSection(txt) {
        const d = document.createElement("div");
        d.className = "idm-sec"; d.textContent = txt;
        drop.appendChild(d);
      }
      function addDiv() {
        const d = document.createElement("div");
        d.className = "idm-div";
        drop.appendChild(d);
      }
    }

    // ── makeRow — layout do item do dropdown ─────────────────────────────────
    //
    // Formato visual:
    //   [ico]  nome do vídeo truncado…  .MP4        [1080 ᴴᴰ]
    //
    // Onde:
    //   - nome: título truncado (sem extensão), sem a resolução embutida
    //   - .EXT: extensão do arquivo em destaque sutil
    //   - badge: número da resolução + tier sobrescrito (HD, FHD, UHD)
    //
    function makeRow(v, cls, ico) {
      const btn = document.createElement("button");
      btn.className = `idm-row ${cls}`;

      // ── Nome limpo: título sem resolução embutida ─────────────────────
      // v.title vem do título do vídeo/página (ex: "Aula de Introdução ao JS")
      // v.label vem da resolução (ex: "1080p", "720p 60fps", "Áudio 128kbps")
      // Preferir v.title quando disponível e diferente da resolução.
      let displayName = v.title || v.label || "Desconhecido";
      // Remover sufixos de resolução que às vezes escapam para o título
      displayName = displayName.replace(/\s*\d{3,4}[pP]\s*(\d+fps)?/g, "").trim();
      if (!displayName) displayName = v.label || "Desconhecido";

      // ── Extensão: extrair da URL ou inferir pelo tipo ─────────────────
      let ext = "";
      try {
        const urlClean = v.url.split("?")[0].split("#")[0];
        const m = urlClean.match(/\.(\w{2,5})$/);
        if (m) ext = m[1].toLowerCase();
      } catch (_) {}
      if (!ext) {
        ext = v.type === "audio" ? "mp3"
            : v.type === "hls"   ? "m3u8"
            : v.type === "dash"  ? "mpd"
            : "mp4";
      }

      // ── Badge: número + tier sobrescrito ─────────────────────────────
      // Separar "1080" do "p" e calcular o tier (HD/FHD/UHD)
      // v.label exemplos: "1080p", "720p 60fps", "1440p", "4K", "Áudio 128kbps"
      let badgeNum  = "";
      let badgeTier = "";

      if (v.type === "audio") {
        // Áudio: mostrar bitrate se disponível, senão só "ÁUDIO"
        const brMatch = (v.label || "").match(/(\d+)\s*k/i);
        badgeNum  = brMatch ? brMatch[1] + "k" : "ÁUDIO";
        badgeTier = brMatch ? "bps" : "";
      } else if (v.type === "hls" || v.type === "dash") {
        badgeNum  = v.type.toUpperCase();
        badgeTier = "";
      } else {
        // Vídeo: extrair altura e calcular tier
        const h = v.height || parseInt((v.label || "").match(/(\d{3,4})/)?.[1] || "0");
        if ((v.label || "").toUpperCase().includes("4K") || h >= 2160) {
          badgeNum = "4K"; badgeTier = "UHD";
        } else if (h >= 1440) {
          badgeNum = "1440"; badgeTier = "QHD";
        } else if (h >= 1080) {
          badgeNum = "1080"; badgeTier = "FHD";
        } else if (h >= 720) {
          badgeNum = "720"; badgeTier = "HD";
        } else if (h >= 480) {
          badgeNum = "480"; badgeTier = "";
        } else if (h >= 360) {
          badgeNum = "360"; badgeTier = "";
        } else if (h > 0) {
          badgeNum = h + "p"; badgeTier = "";
        } else if (v.label) {
          // Fallback: usar o label original limpo
          badgeNum = v.label.replace(/\s*\d+fps.*/i, "").trim();
          badgeTier = "";
        }
      }

      const tierHtml = badgeTier
        ? `<span class="idm-badge-tier">${esc(badgeTier)}</span>`
        : "";

      // Layout final:
      //   [ico]  nome truncado .EXT           [1080 ᴴᴰ]
      //
      // .idm-name-text trunca com ellipsis; .idm-ext nunca trunca;
      // badge fica fixo à direita com resolução + tier sobrescrito.
      // .idm-meta (URL curta) removido — ruído visual desnecessário.
      btn.innerHTML = `
        <span class="idm-ico2">${ico}</span>
        <span class="idm-info">
          <div class="idm-name">
            <span class="idm-name-text">${esc(displayName)}</span><span class="idm-ext">.${esc(ext)}</span>
          </div>
        </span>
        ${badgeNum ? `<span class="idm-badge">${esc(badgeNum)}${tierHtml}</span>` : ""}`;

      btn.title = "Baixar com IDM: " + v.url;
      btn.addEventListener("click", e => { e.stopPropagation(); closeDrop(); sendDownload(v); });
      return btn;
    }

    // ── Enviar download ──────────────────────────────────────────
    //
    // Para URLs de mídia assinadas (Hotmart, Vimeo, Cloudflare Stream,
    // Twitch, Akamai) o CDN valida três coisas além dos parâmetros de
    // assinatura na URL:
    //   1. Origin: deve ser o domínio da plataforma (ex: app.hotmart.com)
    //      — não a URL proxy do bridge nem undefined.
    //   2. Referer: deve ser a página que embed o player, não uma URL genérica.
    //   3. Cookies completos: document.cookie não inclui cookies HttpOnly,
    //      onde ficam os tokens de sessão. O background usa chrome.cookies
    //      API que acessa todos os cookies do domínio.
    //
    // Também distingue o tipo de request para o proxy saber quais
    // Sec-Fetch-* headers usar: "stream" usa same-origin/no-cors,
    // "download" usa cross-site/navigate.
    function sendDownload(v) {
      lbl.textContent = "Enviando...";
      setTimeout(() => { lbl.textContent = "Baixar com IDM"; }, 2500);

      // Derivar o Origin correto: domínio da URL de mídia, não da página.
      // CDNs validam que o Origin bate com os domínios permitidos no CORS
      // da plataforma — geralmente o próprio domínio do CDN ou o da plataforma.
      let mediaOrigin = "";
      let mediaDomain = "";
      try {
        const mu = new URL(v.url);
        mediaOrigin = `${mu.protocol}//${mu.host}`;
        mediaDomain = mu.hostname;
      } catch (_) {}

      // O Referer correto para o CDN é a página da plataforma (location.href),
      // não o domínio do CDN. Muitos WAFs checam que Referer pertence ao
      // domínio da plataforma dona do conteúdo.
      const mediaReferrer = location.href;

      // Classificar o tipo de requisição para o proxy usar os headers certos.
      // "stream": vídeo/áudio embutido — usar Sec-Fetch-Mode: no-cors, same-origin
      // "download": arquivo direto — usar navigate, cross-site (já implementado)
      const requestType = (v.type === "video" || v.type === "audio" || v.type === "hls") ? "stream" : "download";

      // Montar o nome do arquivo final:
      //   - Preferir o nome extraído da URL (já tem a extensão correta e é o
      //     nome real do arquivo no servidor — ex: "aula_03_introducao.mp4")
      //   - Fallback: título da página/vídeo sanitizado + extensão adivinhada
      //
      // PROBLEMA ANTERIOR: usava safeName(v.title) como nome direto.
      // O título vira algo como "Como_baixar_videos.mp4" e é passado ao IDM
      // via flag /f. Até aqui ok. Mas se o título tiver barras ou caracteres
      // especiais que sobrevivam ao sanitize, o IDM interpreta como caminho.
      // A correção está no proxy (/f + filepath.Base), mas na extensão também
      // queremos o nome mais limpo possível desde a origem.
      let filename = "";
      try {
        // Tentar extrair nome real da URL (sem query string e sem fragmento)
        const urlPath = v.url.split("?")[0].split("#")[0];
        const urlBase = urlPath.split("/").filter(Boolean).pop() || "";
        // Usar se parecer um nome de arquivo real (tem extensão de mídia)
        if (urlBase && /\.\w{2,5}$/.test(urlBase)) {
          filename = decodeURIComponent(urlBase);
        }
      } catch (_) {}

      // Fallback: compor a partir do título + extensão
      if (!filename) {
        filename = safeName(v.title || document.title) + guessExt(v);
      }

      // Incluir chaves HLS se disponíveis — necessário para streams criptografados.
      // Buscar pelas chaves do manifest pai (masterUrl) ou da própria URL.
      const streamKeys = [];
      for (const src of [v.url, v.masterUrl].filter(Boolean)) {
        const k = hlsKeys.get(src) || hlsKeys.get("key:" + src);
        if (k) streamKeys.push(...k);
      }

      try {
        chrome.runtime.sendMessage({
          action: "captureDownload",
          url:        v.url,
          filename,
          referrer:   mediaReferrer,
          mediaOrigin,
          mediaDomain,
          requestType,
          site:       v.site || location.hostname.replace(/^www\./, ""),
          hlsKeys:    streamKeys.length > 0 ? streamKeys : undefined
        }).catch(() => {});
      } catch (_) {}
    }

    // ── PlayerWatcher: posicionamento + visibilidade + opacidade ──
    startPlayerWatcher(wrap, closeDrop, () => { scanned = false; });
  }

  // ─────────────────────────────────────────────────────────────
  // detectVideos — combina interceptor + DOM + scripts
  // ─────────────────────────────────────────────────────────────

  function detectVideos() {
    const seen = new Set();
    const out  = [];

    function add(item) {
      if (!item?.url) return;
      if (item.url.startsWith("blob:") || item.url.startsWith("data:")) return;
      if (seen.has(item.url)) return;
      seen.add(item.url);
      out.push({ title: document.title, ...item });
    }

    // Fonte 1: __idmGetMedia() — lista completa capturada pelo interceptor (world: MAIN)
    // É a fonte mais confiável: inclui ytInitialPlayerResponse, fetch, XHR interceptados
    try {
      const intercepted = window.__idmGetMedia?.() || [];
      intercepted.forEach(add);
    } catch (_) {}

    // Fonte 2: pageMedia — eventos postMessage acumulados em tempo real
    // Complementa __idmGetMedia com capturas feitas após o carregamento inicial
    pageMedia.forEach(add);

    // 2. Elementos <video>/<audio> com src HTTP
    [...document.querySelectorAll("video")]
      .sort((a, b) => {
        const ap = !a.paused ? 1 : 0, bp = !b.paused ? 1 : 0;
        return ap !== bp ? bp - ap : (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight);
      })
      .forEach(el => {
        [el.currentSrc, el.src].forEach(s => {
          if (s?.startsWith("http")) add({ url: s, label: fmtRes(el.videoWidth, el.videoHeight) || "Vídeo", type: "video" });
        });
        el.querySelectorAll("source[src]").forEach(s => {
          if (s.src?.startsWith("http"))
            add({ url: s.src, label: s.getAttribute("label") || s.getAttribute("data-res") || "Vídeo", type: "video" });
        });
      });

    [...document.querySelectorAll("audio")].forEach(el => {
      [el.currentSrc, el.src].forEach(s => {
        if (s?.startsWith("http")) add({ url: s, label: "Áudio", type: "audio" });
      });
    });

    // 3. iframes YouTube / Vimeo
    document.querySelectorAll("iframe[src]").forEach(el => {
      const yt = el.src.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([^?&"]+)/);
      if (yt) add({ url: `https://www.youtube.com/watch?v=${yt[1]}`, label: "YouTube", type: "youtube" });
      const vi = el.src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (vi) add({ url: `https://vimeo.com/${vi[1]}`, label: "Vimeo", type: "vimeo" });
    });

    // 4. Scripts inline — JWPlayer, VideoJS, URLs diretas
    document.querySelectorAll("script:not([src])").forEach(s => {
      const t = s.textContent || "";
      if (!t.includes("http")) return;

      // URLs diretas de mídia
      (t.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd|mp4|webm|mkv|mp3|m4a|aac)(?:[?#][^\s"'<>]*)?/gi) || [])
        .forEach(u => add({ url: u.replace(/['")\]\\,;]+$/, ""), label: resFromUrl(u) || extLabel(u), type: typeFromUrl(u) }));

      // Pares file/label
      for (const [, a, b] of t.matchAll(/"(?:file|src|url)"\s*:\s*"(https?:[^"]+)"[^}]{0,150}"(?:label|quality|res)"\s*:\s*"([^"]+)"/gi))
        add({ url: a.replace(/\\/g,""), label: b, type: typeFromUrl(a) });
      for (const [, a, b] of t.matchAll(/"(?:label|quality|res)"\s*:\s*"([^"]+)"[^}]{0,150}"(?:file|src|url)"\s*:\s*"(https?:[^"]+)"/gi))
        add({ url: b.replace(/\\/g,""), label: a, type: typeFromUrl(b) });
    });

    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // getPrimary — player ativo ou maior
  // ─────────────────────────────────────────────────────────────

  function getPrimary() {
    const videos = detectVideos();
    if (!videos.length) return null;
    const playing = videos.find(v => {
      const el = [...document.querySelectorAll("video,audio")].find(e => e.currentSrc === v.url || e.src === v.url);
      return el && !el.paused;
    });
    return playing || videos[0];
  }
  // ─────────────────────────────────────────────────────────────
  // startPlayerWatcher
  //
  // Responsável por três comportamentos:
  //
  //  1. OPACIDADE IDLE / FOCUS
  //     O botão nasce com opacity:0.22 (definido no CSS).
  //     Ao receber hover ou iniciar drag adiciona .idm-focused
  //     que sobe para opacity:1. Ao perder hover/drag retira.
  //
  //  2. VISIBILIDADE POR PLAYER ATIVO
  //     Varre os elementos <video> a cada 800ms e classifica:
  //       - PRINCIPAL: visível ≥ 40% do viewport, área ≥ 90k px²,
  //                    ou tocando e área ≥ 40k px²
  //       - PRÉVIA:    qualquer outro <video> tocando ou com hover
  //     Se existe PRINCIPAL → ancora nele, ignora prévias.
  //     Se não existe PRINCIPAL → segue a PRÉVIA com hover/play.
  //     Se nenhum → .idm-hidden (some com fade).
  //
  //  3. RESCAN DE SPA
  //     Detecta mudança de URL (YouTube, etc.) e reseta o estado.
  // ─────────────────────────────────────────────────────────────

  function startPlayerWatcher(wrap, closeDrop, onNavigate) {
    // ── Opacidade: idle ↔ focused ─────────────────────────────

    wrap.addEventListener("mouseenter", () => wrap.classList.add("idm-focused"));
    wrap.addEventListener("mouseleave", () => wrap.classList.remove("idm-focused"));

    // Também aplicar focused durante o drag (makeDraggable seta cursor:grabbing)
    // O mousedown/mouseup no wrap garantem que o foco persiste durante o arrasto
    wrap.addEventListener("mousedown", () => wrap.classList.add("idm-focused"));
    window.addEventListener("mouseup", () => {
      // Remover focused só se o cursor não estiver sobre o botão
      if (!wrap.matches(":hover")) wrap.classList.remove("idm-focused");
    });

    // ── Classificação de players ──────────────────────────────

    // Área mínima para ser considerado player principal (px²)
    const PRINCIPAL_AREA = 90_000;   // ~300×300px
    const PLAYING_AREA   = 40_000;   // ~200×200px (principal se estiver tocando)
    // Visibilidade mínima do player no viewport (fração 0-1)
    const MIN_VISIBILITY = 0.40;

    // Elemento <video> sendo monitorado por hover (prévia)
    let hoveredVideo = null;

    // Rastrea hover nos <video> para detectar prévias sem som/play
    function attachHoverTrackers() {
      document.querySelectorAll("video").forEach(el => {
        if (el.__idmHoverTracked) return;
        el.__idmHoverTracked = true;
        el.addEventListener("mouseenter", () => { hoveredVideo = el; });
        el.addEventListener("mouseleave", () => { if (hoveredVideo === el) hoveredVideo = null; });
      });
    }

    /**
     * classifyPlayers
     * Retorna { principal, preview } onde cada um é um elemento <video>
     * ou null.
     *
     * Algoritmo:
     *  1. Para cada <video> calcular área visível no viewport.
     *  2. Principal = maior área visível que supera PRINCIPAL_AREA
     *     OU que está tocando e supera PLAYING_AREA.
     *  3. Preview = player tocando OU com hover que não seja o principal.
     */
    function classifyPlayers() {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const viewportArea = vw * vh;

      let principal = null;
      let principalScore = 0;
      let preview = null;

      attachHoverTrackers();

      document.querySelectorAll("video").forEach(el => {
        const r = el.getBoundingClientRect();

        // Área visível (interseção com viewport)
        const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        const visArea = visW * visH;
        const visRatio = viewportArea > 0 ? visArea / viewportArea : 0;

        const playing = !el.paused && !el.ended && el.readyState >= 2;
        const elemArea = r.width * r.height;

        // Critério de principal: grande O SUFICIENTE no viewport
        const isPrincipal =
          (visRatio >= MIN_VISIBILITY && elemArea >= PRINCIPAL_AREA) ||
          (playing && elemArea >= PLAYING_AREA && visRatio >= 0.15);

        if (isPrincipal) {
          // Escolher o de maior área visível como principal
          const score = visArea + (playing ? 50_000 : 0);
          if (score > principalScore) {
            principalScore = score;
            principal = el;
          }
        } else if (!principal) {
          // Candidato a prévia: tocando OU com hover
          if ((playing || el === hoveredVideo) && visArea > 1000) {
            if (!preview || visArea > preview._visArea) {
              el._visArea = visArea;
              preview = el;
            }
          }
        }
      });

      return { principal, preview };
    }

    // ── Estado do watcher ─────────────────────────────────────
    let lastTarget     = null;  // <video> alvo no tick anterior
    let lastHidden     = null;  // null=indefinido | true | false
    let lastHref       = location.href;

    // userMoved: verdadeiro quando o usuário arrastou o botão manualmente.
    // Reset em dois casos:
    //   a) navegação de SPA (nova página = novo contexto)
    //   b) target mudou para um preview diferente por hover — nesse caso
    //      o usuário não posicionou o botão intencionalmente sobre aquele
    //      player, então o reposicionamento automático deve ocorrer.
    let userMoved      = false;
    let lastMoveTarget = null;  // target que estava ativo quando userMoved foi marcado

    // Detectar arrasto manual (mousemove após mousedown no botão)
    wrap.addEventListener("mousedown", () => {
      const mark = () => {
        userMoved      = true;
        lastMoveTarget = lastTarget; // lembrar para qual player o usuário moveu
        window.removeEventListener("mousemove", mark);
      };
      window.addEventListener("mousemove", mark);
    });

    // ── Loop principal ────────────────────────────────────────

    function tick() {
      // ── Rescan de SPA ───────────────────────────────────────
      if (location.href !== lastHref) {
        lastHref       = location.href;
        lastTarget     = null;
        lastMoveTarget = null;
        userMoved      = false;
        closeDrop();
        onNavigate();
        wrap.classList.remove("idm-closed");
      }

      // Se o usuário fechou manualmente (botão ✕), não interferir
      if (wrap.classList.contains("idm-closed")) return;

      const { principal, preview } = classifyPlayers();
      const target = principal || preview;

      // ── Flag: botão com foco (cursor sobre ele) ─────────────
      // Quando o cursor sai de um preview e vai direto para o botão,
      // hoveredVideo some mas o botão está :hover → não ocultar.
      const btnFocused = wrap.classList.contains("idm-focused");

      if (!target) {
        // Nenhum player ativo.
        // Se o botão está focado (cursor sobre ele), manter visível —
        // só ocultar quando o foco também sair do botão.
        if (btnFocused) return;

        if (lastHidden !== true) {
          wrap.classList.add("idm-hidden");
          lastHidden = true;
        }
        return;
      }

      // ── Há player alvo → garantir visível ───────────────────
      if (lastHidden !== false) {
        wrap.classList.remove("idm-hidden");
        lastHidden = false;
      }

      // ── Reposicionar quando o alvo muda ─────────────────────
      if (target !== lastTarget) {
        const previousTarget = lastTarget;
        lastTarget = target;

        // Decidir se reposiciona:
        //   - Sempre reposicionar se é a primeira vez (previousTarget === null)
        //   - Sempre reposicionar se mudou de preview (hover em outro player):
        //     o usuário moveu o mouse para outro player, não o botão.
        //     Reset userMoved para que o botão siga o novo player.
        //   - Não reposicionar se userMoved === true E o move foi feito
        //     enquanto o target atual era o lastMoveTarget (usuário
        //     intencionalmente posicionou o botão sobre este player).
        const movedForThisTarget = userMoved && lastMoveTarget === target;

        if (!movedForThisTarget) {
          // Prévia mudou por hover → resetar userMoved para o novo target
          if (previousTarget !== null && !principal) userMoved = false;
          positionNearVideo(wrap, target);
        }
      }
    }

    // Rodar a cada 800ms
    setInterval(tick, 800);

    // Execuções iniciais: imediata + delays para players lentos
    tick();
    // Segunda tentativa com delay para players lentos (YouTube, etc.)
    setTimeout(tick, 1500);
    setTimeout(tick, 4000);
  }

  // ─────────────────────────────────────────────────────────────
  // positionNearVideo
  //
  // Versão que recebe diretamente o elemento <video> alvo,
  // calculando a posição a partir da sua área visível no viewport.
  // Chamada pelo PlayerWatcher quando o target muda.
  // ─────────────────────────────────────────────────────────────

  function positionNearVideo(wrap, videoEl) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const r = videoEl.getBoundingClientRect();

    // Área visível do elemento
    const visLeft   = Math.max(r.left,   0);
    const visTop    = Math.max(r.top,    0);
    const visRight  = Math.min(r.right,  vw);
    const visBottom = Math.min(r.bottom, vh);

    if (visRight <= visLeft || visBottom <= visTop) return; // fora do viewport

    const wr = wrap.getBoundingClientRect();
    const ww = wr.width  || 220;
    const wh = wr.height || 38;
    const MARGIN = 10;

    let tx = visRight - ww - MARGIN;
    let ty = visTop   + MARGIN;

    tx = Math.max(MARGIN, Math.min(tx, vw - ww - MARGIN));
    ty = Math.max(MARGIN, Math.min(ty, vh - wh - MARGIN));

    setPosition(wrap, tx, ty);
  }

  // ─────────────────────────────────────────────────────────────
  // positionNearPlayer
  //
  // Posiciona o botão no canto superior-direito da área VISÍVEL
  // do player. Usa transform:translate() — o mesmo mecanismo do
  // drag — para garantir consistência de coordenadas.
  // ─────────────────────────────────────────────────────────────

  function positionNearPlayer(wrap) {
    const candidates = [
      ...document.querySelectorAll("video"),
      ...document.querySelectorAll(
        ".html5-video-container, #movie_player, " +
        ".vp-player-ui-overlays, [class*='video-player'], " +
        "[class*='player-container']"
      )
    ].filter(Boolean);

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let best     = null;
    let bestArea = 0;

    for (const el of candidates) {
      const r = el.getBoundingClientRect();

      // Interseção do elemento com o viewport (área realmente visível)
      const visLeft   = Math.max(r.left,   0);
      const visTop    = Math.max(r.top,    0);
      const visRight  = Math.min(r.right,  vw);
      const visBottom = Math.min(r.bottom, vh);
      const visW      = visRight  - visLeft;
      const visH      = visBottom - visTop;

      if (visW < 120 || visH < 60) continue;

      const visArea = visW * visH;
      if (visArea > bestArea) {
        bestArea = visArea;
        best = { visLeft, visTop, visRight, visBottom };
      }
    }

    // Dimensões do botão (medidas após estar no DOM)
    const wr = wrap.getBoundingClientRect();
    const ww = wr.width  || 220;
    const wh = wr.height || 38;

    const MARGIN = 10;
    let tx, ty;

    if (best) {
      // Canto superior-direito da área visível do player
      tx = best.visRight - ww - MARGIN;
      ty = best.visTop   + MARGIN;
    } else {
      // Fallback: canto superior-direito da tela
      tx = vw - ww - MARGIN;
      ty = MARGIN;
    }

    // Clamp dentro do viewport
    tx = Math.max(MARGIN, Math.min(tx, vw - ww - MARGIN));
    ty = Math.max(MARGIN, Math.min(ty, vh - wh - MARGIN));

    // Posicionar via transform — consistente com o sistema do drag
    setPosition(wrap, tx, ty);
  }

  // ─────────────────────────────────────────────────────────────
  // setPosition / getPosition
  //
  // Fonte única de verdade para mover #idm-float.
  // Usa transform:translate(x,y) em vez de left/top porque:
  //   1. transform move o layer de GPU já existente — zero repaint.
  //   2. left/top + filter causam recomposição de todo o stacking
  //      context, gerando o artefato de "janela transparente".
  //   3. O browser já tem will-change:transform no elemento, então
  //      o layer está sempre promovido e pronto para ser movido.
  // ─────────────────────────────────────────────────────────────

  function setPosition(wrap, x, y) {
    wrap.style.transform = `translate(${x}px,${y}px)`;
    // Guardar as coordenadas como atributo data para getPosition()
    wrap._tx = x;
    wrap._ty = y;
  }

  function getPosition(wrap) {
    // Lê do cache interno — evita forçar layout com getBoundingClientRect
    return { x: wrap._tx || 0, y: wrap._ty || 0 };
  }

  // ─────────────────────────────────────────────────────────────
  // makeDraggable
  //
  // Drag livre em qualquer direção com clamp nas bordas do viewport.
  //
  // Causa raiz dos bugs anteriores:
  //   A) "Janela transparente" no drag horizontal:
  //      left/top + filter:drop-shadow criam um stacking context de
  //      compositing. Mover com left/top força o browser a redesenhar
  //      o layer inteiro, deixando artefato da posição anterior.
  //      → Resolvido: transform:translate() move o layer sem repaint.
  //
  //   B) Elemento "preso" após arrastar:
  //      mouseleave no document dispara ao entrar em qualquer filho
  //      (bubbling), cancelando dragging no meio do movimento.
  //      → Resolvido: remover mouseleave; usar mouseup no window
  //        (captura mesmo fora da aba) com listeners temporários.
  //
  // Arquitetura de listeners:
  //   - mousedown no handle: registra listeners temporários de
  //     mousemove e mouseup no window (não no document).
  //   - Os listeners temporários são removidos no mouseup,
  //     evitando acúmulo de handlers a cada drag.
  // ─────────────────────────────────────────────────────────────

  function makeDraggable(wrap, handle) {

    handle.addEventListener("mousedown", e => {
      if (["idm-cls", "idm-arr"].includes(e.target.id)) return;
      e.preventDefault();

      const origin = getPosition(wrap);
      const ox  = origin.x;
      const oy  = origin.y;
      const mx0 = e.clientX;
      const my0 = e.clientY;

      const wr  = wrap.getBoundingClientRect();
      const elW = wr.width;
      const elH = wr.height;

      // Flag que distingue "clique simples" de "arrasto real".
      // Threshold de 4px tolera tremores de mão sem suprimir cliques legítimos.
      const DRAG_THRESHOLD = 4;
      let wasDragged = false;

      document.body.style.userSelect = "none";
      wrap.style.cursor              = "grabbing";

      function onMove(ev) {
        const dx = ev.clientX - mx0;
        const dy = ev.clientY - my0;

        // Só considera drag após ultrapassar o threshold
        if (!wasDragged && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        wasDragged = true;

        let nx = Math.max(0, Math.min(ox + dx, window.innerWidth  - elW));
        let ny = Math.max(0, Math.min(oy + dy, window.innerHeight - elH));
        setPosition(wrap, nx, ny);
      }

      function onUp() {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup",   onUp);
        document.body.style.userSelect = "";
        wrap.style.cursor              = "";

        // Se houve arrasto real, bloquear o próximo `click` que o browser
        // dispara automaticamente após mousedown+mouseup.
        //
        // useCapture:true — roda na fase de descida, antes dos handlers
        // dos filhos (arr, cls, lbl). Cancela o evento antes que chegue
        // a qualquer handler de ação.
        //
        // once:true — remove-se automaticamente após o primeiro click
        // interceptado, sem deixar handler residual que bloquearia
        // cliques futuros legítimos.
        if (wasDragged) {
          wrap.addEventListener("click", e => {
            e.stopImmediatePropagation();
            e.preventDefault();
          }, { capture: true, once: true });
        }
      }

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup",   onUp);
    });
  }


  // ─────────────────────────────────────────────────────────────
  // Utilitários
  // ─────────────────────────────────────────────────────────────

  function fmtRes(w, h) {
    if (!h) return "";
    return h >= 2160 ? "4K" : h >= 1440 ? "1440p" : h >= 1080 ? "1080p" :
           h >= 720  ? "720p" : h >= 480 ? "480p"  : h >= 360  ? "360p" : h + "p";
  }

  function resFromUrl(url) {
    const m = url.match(/[/_-](\d{3,4})[pP]|(\d{3,4})[xX](\d{3,4})/);
    return m ? (m[1] ? m[1]+"p" : m[3]+"p") : "";
  }

  function typeFromUrl(url) {
    const p = url.split("?")[0].toLowerCase();
    if (p.match(/\.m3u8|\.mpd/)) return "hls";
    if (p.match(/\.mp3|\.m4a|\.aac|\.ogg|\.opus|\.flac|\.wav/)) return "audio";
    return "video";
  }

  function extLabel(url) {
    const p = url.split("?")[0].toLowerCase();
    if (p.endsWith(".m3u8")) return "HLS";
    if (p.endsWith(".mpd"))  return "DASH";
    if (p.match(/\.mp[34]$|\.webm$|\.mkv$/)) return "Vídeo";
    if (p.match(/\.mp3$|\.m4a$|\.aac$/)) return "Áudio";
    return "Mídia";
  }

  function guessExt(v) {
    if (v.type === "audio") return ".mp3";
    if (v.type === "hls")   return ".m3u8";
    const m = v.url.split("?")[0].match(/\.(\w{2,5})$/);
    return m ? "." + m[1] : ".mp4";
  }

  function safeName(s) {
    return (s||"video").replace(/[/\\:*?"<>|]/g,"").replace(/\s+/g,"_").slice(0,80);
  }

  function shortUrl(url) {
    try { const u = new URL(url); return u.hostname + "/…/" + u.pathname.split("/").pop().slice(0,30); }
    catch(_) { return url.slice(0,50); }
  }

  function esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

})();
