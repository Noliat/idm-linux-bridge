// content.js — document_idle — UI, botão flutuante, detecção de links

(function () {
  "use strict";

  if (window.__idmBridgeInjected) return;
  window.__idmBridgeInjected = true;

  // ── Mídias capturadas pelo interceptor (world: MAIN) ─────────
  const pageMedia = new Map();
  const ORIGIN = window.origin || location.origin;
  const hlsKeys = new Map();

  // Timestamp da última mídia capturada — usado para invalidar cache do dropdown
  let lastMediaTs = 0;
  // Janela de tempo onde titles do interceptor são substituídos por document.title.
  // Renovado tanto em onNavigate (YouTube/Shorts) quanto quando o <title> muda
  // (TikTok scroll infinito sem navigation event real).
  let navFreshUntil      = 0;
  // URL do iframe de player externo ativo (JW, Brightcove, etc.)
  let activeExternalFrame = null;

  // TikTok: ID do vídeo atualmente no player ativo.
  // Extraído da URL: tiktok.com/@user/video/7123456789
  // Atualizado a cada navegação SPA (scroll para próximo vídeo).
  let activeTikTokVideoId = null;

  // activeTikTokSrc/lastTikTokSrc: rastreiam o src do <video> ativo no
  // TikTok entre ticks — usados para detectar troca de mídia sem
  // navegação de URL real (scroll infinito que só troca o src).
  // Precisam ser escopo de módulo: resetados em onNavigate (dentro de
  // createButtonInstance) mas potencialmente lidos pelo tick() de
  // qualquer instância do botão.
  let activeTikTokSrc = null;
  let lastTikTokSrc   = null;

  function extractTikTokVideoId(url) {
    try {
      const m = (url || location.href).match(/\/video\/(\d+)/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  // Atualizar activeVideoId a cada tick de URL (já temos o tick em startPlayerWatcher)
  function refreshTikTokActiveId() {
    if (!location.hostname.includes("tiktok.com")) return;
    const id = extractTikTokVideoId(location.href);
    if (id && id !== activeTikTokVideoId) {
      activeTikTokVideoId = id;
      // Limpar mídias de outros vídeos — manter só as do ativo
      for (const [key, entry] of pageMedia) {
        if (entry.site === "tiktok" && entry.__videoId !== id) {
          pageMedia.delete(key);
        }
      }
      notifyDropdownUpdate();
    }
  }

  // Observar mudanças no <title> — TikTok, Instagram Reels e outros SPAs
  // mudam document.title sem disparar navigation events. Quando o título
  // muda, qualquer mídia recebida em seguida (próximos 3s) deve usar o
  // novo document.title em vez do title vindo do interceptor (que pode
  // ter sido emitido antes da mudança do título).
  // watchTitle: sinaliza navFreshUntil quando document.title muda.
  // Para TikTok (título fixo "TikTok - Make Your Day") é ignorado.
  // Útil para YouTube, Vimeo e outros SPAs onde document.title é o título do vídeo.
  (function watchTitle() {
    let lastDocTitle = document.title;

    function onTitleChange() {
      const cur = document.title;
      // Ignorar títulos genéricos fixos que não representam o conteúdo ativo
      const isGeneric = /^tiktok[\s\-]/i.test(cur) ||
                        /^youtube$/i.test(cur)      ||
                        cur.length < 4;
      if (!cur || cur === lastDocTitle || isGeneric) return;

      const prev   = lastDocTitle;  // salvar ANTES de atualizar (corrige bug: prev === cur)
      lastDocTitle = cur;
      navFreshUntil = Date.now() + 3000;

      // Atualizar retroativamente entradas com título do vídeo anterior (prev).
      // Útil para YouTube onde o document.title muda antes da re-emissão da mídia.
      if (pageMedia.size > 0) {
        for (const [key, entry] of pageMedia) {
          if (!entry.title || entry.title === prev) {
            pageMedia.set(key, { ...entry, title: cur });
          }
        }
      }
    }

    // MutationObserver com subtree capta document.title = "..." (recria Text node)
    const titleObs = new MutationObserver(onTitleChange);
    function attachObs(el) {
      titleObs.observe(el, { childList: true, characterData: true, subtree: true });
    }
    const titleEl = document.querySelector("title");
    if (titleEl) {
      attachObs(titleEl);
    } else {
      new MutationObserver((_, obs) => {
        const el = document.querySelector("title");
        if (el) { obs.disconnect(); attachObs(el); }
      }).observe(document.head || document.documentElement, { childList: true, subtree: true });
    }
    setInterval(onTitleChange, 800);
  })();

  // Aceitar mensagens do interceptor.js no mesmo frame (same-origin)
  // E de iframes de players (cross-origin, via page_inject.js relay)
  // O relay em page_inject.js adiciona __idmFromFrame: true para identificar
  window.addEventListener("message", (e) => {
    if (!e.data?.__idmBridge) return;
    // same-origin: checar origem; cross-origin de iframe: aceitar com __idmFromFrame
    if (!e.data.__idmFromFrame && e.origin !== ORIGIN) return;

    const { type, data } = e.data;

    if (type === "media") {
      if (!data?.url) return;

      // Normalizar key igual ao interceptor
      let mediaKey;
      try {
        const u = new URL(data.url);
        mediaKey = u.hostname.includes("googlevideo")
          ? "yt:" + (u.searchParams.get("itag") || u.pathname)
          : u.hostname + u.pathname;
      } catch (_) { mediaKey = data.url; }

      const entry    = { ...data };
      const docTitle = document.title || "";
      // Não sobrescrever com document.title genérico (TikTok, YouTube home)
      const docIsGeneric = /^tiktok[\s\-]/i.test(docTitle) ||
                           /^youtube$/i.test(docTitle)      ||
                           docTitle.length < 4;
      if (!entry.title && !docIsGeneric) {
        // Interceptor não enviou título — usar document.title se útil
        entry.title = docTitle;
      } else if (entry.title && navFreshUntil > Date.now() && !docIsGeneric) {
        // Dentro da janela pós-navegação: document.title pode estar mais atualizado
        // (YouTube muda título antes de re-emitir a mídia)
        entry.title = docTitle || entry.title;
      }

      // Registrar iframe de origem para posicionamento do botão
      // Quando a mídia vem de um iframe (JW, Brightcove, etc.),
      // guardar o frameUrl para encontrar o <iframe> correspondente.
      if (e.data.__idmFromFrame && e.data.__idmFrameUrl) {
        entry.__frameUrl = e.data.__idmFrameUrl;
        // Rastrear iframe de player externo ativo
        activeExternalFrame = e.data.__idmFrameUrl;
      }

      // TikTok: filtrar por videoId ativo — ignorar mídias de outros vídeos do feed
      if (entry.site === "tiktok" && activeTikTokVideoId) {
        if (entry.__videoId && entry.__videoId !== activeTikTokVideoId) {
          return; // Mídia de outro vídeo do feed — descartar
        }
      }

      pageMedia.set(mediaKey, entry);
      lastMediaTs = Date.now();

      // Pulsar o botão
      const bar = document.getElementById("idm-bar");
      if (bar) {
        bar.style.transition = "filter 0.3s";
        bar.style.filter = "brightness(1.4)";
        setTimeout(() => { bar.style.filter = ""; }, 350);
      }

      notifyDropdownUpdate();
      return;
    }

    // clearYtMedia: interceptor detectou novo videoId no Shorts
    // → limpar qualidades do vídeo anterior no pageMedia
    if (type === "clearYtMedia") {
      for (const [key] of pageMedia) {
        if (key.startsWith("yt:")) pageMedia.delete(key);
      }
      // dropPopulatedTs é estado privado de cada instância do botão —
      // resetAllDropPopulated() invalida o cache de todas elas (a
      // referência direta a "dropPopulatedTs" aqui causava
      // ReferenceError, pois esta variável não existe neste escopo).
      resetAllDropPopulated();
      notifyDropdownUpdate();
      return;
    }

    if (type === "hlsKeys") {
      if (data?.manifestUrl && Array.isArray(data.keys)) {
        hlsKeys.set(data.manifestUrl, data.keys);
      }
      return;
    }

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

    if (msg.action === "setFloatBtn") {
      if (msg.enabled) {
        const wrap = document.getElementById("idm-float");
        if (wrap) {
          wrap.classList.remove("idm-closed");
        } else {
          btnInjected = false;
          tryShow();
        }
      } else {
        const wrap = document.getElementById("idm-float");
        if (wrap) wrap.classList.add("idm-closed");
      }
      respond({ ok: true });
      return true;
    }

    return true;
  });

  // ─────────────────────────────────────────────────────────────
  // Botão flutuante
  // ─────────────────────────────────────────────────────────────

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
    if (isKnownVideoSite) return true;
    if (document.querySelector("video, audio")) return true;
    if (pageMedia.size > 0) return true;
    return false;
  }

  function tryShow() {
    if (btnInjected) return;
    if (!shouldShow()) return;
    btnInjected = true;
    obs.disconnect();
    createButtonInstance("idm-float", false);
  }

  const obs = new MutationObserver(tryShow);
  obs.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage.sync.get({ floatBtnEnabled: true }, ({ floatBtnEnabled }) => {
    if (!floatBtnEnabled) return;
    tryShow();
    setTimeout(tryShow, 3000);
  });

  // ─────────────────────────────────────────────────────────────
  // [FIX 4] Notificação de atualização do dropdown
  // Chamada quando pageMedia recebe nova mídia.
  // Se o dropdown estiver aberto, re-popula em tempo real.
  // ─────────────────────────────────────────────────────────────

  // Callbacks de atualização do dropdown — array para suportar múltiplas instâncias
  const _dropdownCallbacks = [];

  // _dropPopulatedResetters — cada instância (principal/preview) registra
  // aqui uma função que zera seu próprio dropPopulatedTs (estado local
  // do closure de createButtonInstance). Usado por handlers em escopo de
  // módulo (ex: clearYtMedia) que precisam invalidar o cache de TODAS as
  // instâncias do dropdown sem acessar variáveis privadas de outro closure.
  const _dropPopulatedResetters = [];

  function resetAllDropPopulated() {
    for (const reset of _dropPopulatedResetters) {
      try { reset(); } catch (_) {}
    }
  }

  function notifyDropdownUpdate() {
    for (const cb of _dropdownCallbacks) {
      try { cb(); } catch (_) {}
    }
  }

  // ─────────────────────────────────────────────────────────────
  // createButtonInstance (instância principal)
  // ─────────────────────────────────────────────────────────────

  // createButtonInstance — cria uma instância do botão flutuante.
  //
  //   rootId:    id do elemento raiz ("idm-float" para o principal,
  //              "idm-float-pv" para a instância de preview).
  //   isPreview: true para a instância de preview (segundo botão).
  //              Afeta apenas o comportamento do tick() — a aparência
  //              visual é idêntica (CSS reaproveitado via replace de IDs).
  //
  // Internamente os elementos filhos usam os MESMOS ids literais
  // ("idm-bar", "idm-drop", etc) seguidos do mesmo sufixo de rootId
  // (ex: rootId="idm-float-pv" → "idm-bar-pv", "idm-drop-pv"...).
  // Isso é obtido com um replace simples de "idm-float" → rootId no
  // HTML/CSS gerados — todos os ids internos usam "idm-float" como
  // prefixo lógico através de INTERNAL_ID(name).
  function createButtonInstance(rootId, isPreview) {
    const SUF = rootId === "idm-float" ? "" : rootId.slice("idm-float".length);
    const ID  = name => `idm-${name}${SUF}`; // ex: ID("bar") → "idm-bar-pv"

    document.getElementById(rootId)?.remove();
    // __idm_style: folha de estilo principal, contém classes compartilhadas
    // (.idm-row, .idm-sec, @keyframes idm-spin, etc). A instância de preview
    // usa __idm_style_pv para evitar id duplicado no DOM — mas o CONTEÚDO é
    // o mesmo (gerado com o mesmo ID()/rootId da instância), então as regras
    // #${rootId}, #${ID('bar')}, etc ficam corretamente escopadas por instância.
    const styleId = isPreview ? "__idm_style_pv" : "__idm_style";
    document.getElementById(styleId)?.remove();

    const css = document.createElement("style");
    css.id = styleId;
    css.textContent = `
      #${rootId} {
        all: initial;
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        z-index: 2147483647 !important;
        font-family: "Segoe UI", Tahoma, Arial, sans-serif !important;
        font-size: 12px !important;
        user-select: none !important;
        will-change: transform !important;
        opacity: 0.22 !important;
        transition: opacity 0.20s ease !important;
      }
      #${rootId} * { box-sizing: border-box !important; }
      #${rootId}:hover,
      #${rootId}.idm-focused { opacity: 1 !important; }
      #${rootId}.idm-hidden {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: scale(0.92) !important;
      }
      #${rootId}.idm-closed { display: none !important; }

      /* ── Modo "flutuante livre" (idm-floating) ──────────────────────
         Aplicado quando nenhum <video> foi classificado como
         principal/preview no top frame (player real está num iframe
         cross-origin não detectável). O CONTAINER (#${rootId}) vira
         "ghost" — pointer-events:none — para não interceptar cliques
         destinados ao conteúdo da página por baixo dele. A BARRA
         visível (#${ID('bar')}) recupera pointer-events:auto, então o
         botão em si continua clicável/arrastável; apenas a "moldura"
         invisível do wrap (se houver, por margens/padding) deixa de
         bloquear cliques. */
      #${rootId}.idm-floating { pointer-events: none !important; }
      #${rootId}.idm-floating #${ID('bar')},
      #${rootId}.idm-floating #${ID('drop')} {
        pointer-events: auto !important;
      }
      #${ID('bg-lbl')} {
        display: flex !important;
        align-items: stretch !important;
        height: 14.24px !important;
        width: 101px !important;
        border-radius: 2.5px !important;
        overflow: visible !important;
        cursor: grab !important;
        position: relative !important;
        background: linear-gradient(180deg,#1a3d6b 0%,#0f2744 45%,#091b30 100%) !important;
        border-top:    1px solid rgba(100,160,240,0.30) !important;
        border-left:   1px solid rgba(80,130,210,0.22)  !important;
        border-right:  1px solid rgba(0,0,0,0.60)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.70)       !important;
      }
      #${ID('bg-lbl')}:active { background: rgba(0,0,0,0.25) !important; cursor: grabbing !important; }
      #${ID('bg-lbl')}:hover { background: rgba(255,255,255,0.10) !important; }
      #${ID('bg-lbl')}::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important; left: 2px !important; right: 2px !important;
        height: 1px !important;
        background: linear-gradient(90deg,transparent,rgba(160,210,255,0.45) 20%,rgba(180,220,255,0.55) 50%,rgba(160,210,255,0.45) 80%,transparent) !important;
        pointer-events: none !important;
      }
      #${ID('bg-bt')} {
        display: flex !important;
        align-items: stretch !important;
        height: 14.24px !important;
        width: 14.24px !important;
        border-radius: 2.5px !important;
        overflow: visible !important;
        cursor: grab !important;
        position: relative !important;
        background: linear-gradient(180deg,#1a3d6b 0%,#0f2744 45%,#091b30 100%) !important;
        border-top:    1px solid rgba(100,160,240,0.30) !important;
        border-left:   1px solid rgba(80,130,210,0.22)  !important;
        border-right:  1px solid rgba(0,0,0,0.60)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.70)       !important;
      }
      #${ID('bg-bt')}:active { cursor: grabbing !important; border-radius: 2.5px !important; background: rgba(0,0,0,0.25) !important; }
      #${ID('bg-bt')}:hover { border-radius: 2.5px !important; background: rgba(255,255,255,0.10) !important; }
      #${ID('bg-bt')}::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important; left: 2px !important; right: 2px !important;
        height: 1px !important;
        background: linear-gradient(90deg,transparent,rgba(160,210,255,0.45) 20%,rgba(180,220,255,0.55) 50%,rgba(160,210,255,0.45) 80%,transparent) !important;
        pointer-events: none !important;
      }
      #${ID('bar')} {
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
        background: linear-gradient(180deg,#1a3d6b 0%,#0f2744 45%,#091b30 100%) !important;
        border-top:    1px solid rgba(100,160,240,0.30) !important;
        border-left:   1px solid rgba(80,130,210,0.22)  !important;
        border-right:  1px solid rgba(0,0,0,0.60)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.70)       !important;
        box-shadow: 0 2px 6px rgba(0,0,0,0.60),0 1px 2px rgba(0,0,0,0.45),inset 0 1px 0 rgba(130,185,255,0.12) !important;
      }
      #${ID('bar')}:active { cursor: grabbing !important; }
      #${ID('bar')}::before {
        content: "" !important;
        position: absolute !important;
        top: 0 !important; left: 2px !important; right: 2px !important;
        height: 1px !important;
        background: linear-gradient(90deg,transparent,rgba(160,210,255,0.45) 20%,rgba(180,220,255,0.55) 50%,rgba(160,210,255,0.45) 80%,transparent) !important;
        pointer-events: none !important;
      }
      #${ID('ico')} {
        display: flex !important;
        align-items: stretch !important;
        justify-content: center !important;
        width: 14.24px !important;
        height: 14.28px !important;
        flex-shrink: 0 !important;
        border-radius: 2px !important;
        margin-left: 4px !important;
        margin-top: 2px !important;
      }
      #${ID('lbl')} {
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
        padding: 5px 3px 5px 3px !important;
        line-height: 1px !important;
        letter-spacing: 0.01em !important;
      }
      #${ID('lbl')}:hover { color: #f97316 !important; font-weight: 5 !important; }
      #${ID('arr')}, #${ID('cls')} {
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        flex-shrink: 0 !important;
        border-radius: 2px !important;
        margins: 2px !important;
        padding: 2px !important;
        transition: background 0.10s !important;
        color: rgba(160,200,245,0.70) !important;
      }
      #${ID('arr')} {
        font-size: 10px !important;
        font-weight: 1.5 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        cursor: pointer !important;
        border-radius: 2px !important;
        margin-left: 2.30px !important;
        margin-bottom: 1.79px !important;
        line-height: 1px !important;
        letter-spacing: 0.01em !important;
      }
      #${ID('cls')} {
        font-size: 10px !important;
        font-weight: 1.5 !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        cursor: pointer !important;
        border-radius: 2px !important;
        line-height: 1px !important;
        letter-spacing: 0.01em !important;
      }
      #${ID('arr')}:hover, #${ID('cls')}:hover { color: #f97316 !important; }
      #${ID('arr')}.open { transform: rotate(180deg) !important; color: #f97316 !important; }
      #${ID('drop')} {
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
        background: #0b1e33 !important;
        border-top:    1px solid rgba(80,140,220,0.30)  !important;
        border-left:   1px solid rgba(60,110,190,0.20)  !important;
        border-right:  1px solid rgba(0,0,0,0.55)       !important;
        border-bottom: 1px solid rgba(0,0,0,0.65)       !important;
        box-shadow: 0 6px 20px rgba(0,0,0,0.65),0 2px 5px rgba(0,0,0,0.45),inset 0 1px 0 rgba(100,170,255,0.08) !important;
      }
      #${ID('drop')}.open { display: flex !important; }
      #${ID('drop')}::-webkit-scrollbar { width: 5px !important; }
      #${ID('drop')}::-webkit-scrollbar-track { background: rgba(0,0,0,0.2) !important; }
      #${ID('drop')}::-webkit-scrollbar-thumb { background: rgba(80,140,220,0.35) !important; border-radius: 3px !important; }
      #${ID('drop')}-head {
        display: flex !important;
        align-items: center !important;
        gap: 7px !important;
        padding: 7px 10px 6px !important;
        background: linear-gradient(180deg,#1a3d6b 0%,#0f2744 100%) !important;
        border-bottom: 1px solid rgba(255,255,255,0.07) !important;
        border-radius: 2px 2px 0 0 !important;
        flex-shrink: 0 !important;
      }
      #${ID('drop')}-title { font-size: 10.5px !important; font-weight: 600 !important; color: #a8cbf0 !important; letter-spacing: 0.03em !important; text-shadow: 0 1px 2px rgba(0,0,0,0.6) !important; }
      .idm-sec { padding: 5px 10px 2px !important; font-size: 9px !important; font-weight: 700 !important; text-transform: uppercase !important; letter-spacing: 1px !important; color: #2d5a9e !important; }
      .idm-div { height: 1px !important; background: rgba(255,255,255,0.05) !important; margin: 2px 8px !important; }
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
      .idm-row:hover { background: rgba(25,90,195,0.32) !important; color: #e0f0ff !important; }
      .idm-row:active { background: rgba(25,90,195,0.50) !important; }
      .idm-ico2 { width: 22px !important; height: 22px !important; border-radius: 3px !important; display: flex !important; align-items: center !important; justify-content: center !important; font-size: 11px !important; flex-shrink: 0 !important; }
      .t-video .idm-ico2 { background: rgba(249,115,22,0.16) !important; }
      .t-audio .idm-ico2 { background: rgba(59,130,246,0.16) !important; }
      .t-hls   .idm-ico2 { background: rgba(168,85,247,0.16) !important; }
      .idm-info { flex: 1 !important; overflow: hidden !important; min-width: 0 !important; }
      .idm-meta { font-size: 9px !important; color: #2d5a9e !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; margin-top: 1px !important; }
      .idm-badge { display: inline-flex !important; align-items: flex-start !important; gap: 1px !important; font-size: 11px !important; font-weight: 700 !important; padding: 2px 7px 2px 6px !important; border-radius: 3px !important; flex-shrink: 0 !important; letter-spacing: 0.01em !important; white-space: nowrap !important; line-height: 1.1 !important; background: rgba(249,115,22,0.13) !important; color: #f97316 !important; border: 1px solid rgba(249,115,22,0.28) !important; align-self: center !important; margin-top: 1.5px !important; }
      .idm-badge-tier { font-size: 7px !important; font-weight: 500 !important; letter-spacing: 0.06em !important; vertical-align: super !important; line-height: 0 !important; opacity: 0.90 !important; margin-left: 1px !important; margin-top: 2.5px !important; }
      .idm-name { display: flex !important; align-items: baseline !important; gap: 0 !important; min-width: 0 !important; font-weight: 600 !important; font-size: 11px !important; color: #d0e8ff !important; }
      .idm-name-text { flex: 1 !important; min-width: 0 !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
      .idm-ext { flex-shrink: 0 !important; font-size: 10px !important; font-weight: 700 !important; color: #5b8ec4 !important; letter-spacing: 0.04em !important; text-transform: uppercase !important; margin-left: 4px !important; opacity: 0.90 !important; }
      .idm-empty { padding: 16px 12px !important; color: #2d5a9e !important; font-size: 11px !important; text-align: center !important; line-height: 1.5 !important; }
      .idm-spin-wrap { display: flex !important; align-items: center !important; gap: 8px !important; padding: 11px 12px !important; color: #2d5a9e !important; font-size: 11px !important; }
      .idm-spin { width: 13px !important; height: 13px !important; border: 2px solid rgba(80,140,220,0.18) !important; border-top-color: #3b82f6 !important; border-radius: 50% !important; animation: idm-spin 0.65s linear infinite !important; flex-shrink: 0 !important; }
      @keyframes idm-spin { to { transform: rotate(360deg); } }
    `;
    (document.head || document.documentElement).appendChild(css);

    const logoPath = chrome.runtime.getURL("icons/logo.png");
    const wrap = document.createElement("div");
    wrap.id = rootId;
    wrap.innerHTML = `
      <div id="${ID('bar')}" title="Baixar com IDM">
        <span id="${ID('bg-lbl')}">
          <span id="${ID('ico')}">
            <img src="${logoPath}" alt="Logo" width="9.33" height="7.57" />
          </span>
          <span id="${ID('lbl')}">Baixar com IDM</span>
        </span>
        <span id="${ID('bg-bt')}">
          <span id="${ID('arr')}" title="Ver resoluções disponíveis">▾</span>
        </span>
        <span id="${ID('bg-bt')}">
          <span id="${ID('cls')}" title="Fechar">✕</span>
        </span>
      </div>
      <div id="${ID('drop')}">
        <div id="${ID('drop-head')}">
          <svg width="13" height="13" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="${"idmSph2"+SUF}" cx="36%" cy="32%" r="68%">
                <stop offset="0%"   stop-color="#7ec8ff"/>
                <stop offset="100%" stop-color="#0d3070"/>
              </radialGradient>
              <clipPath id="${"idmClp2"+SUF}"><circle cx="10" cy="9.5" r="7.8"/></clipPath>
            </defs>
            <circle cx="10" cy="9.5" r="7.8" fill="url(#${"idmSph2"+SUF})"/>
            <g clip-path="url(#${"idmClp2"+SUF})" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="0.8">
              <ellipse cx="10" cy="9.5" rx="7.8" ry="2.8"/>
              <ellipse cx="10" cy="9.5" rx="2.8" ry="7.8"/>
            </g>
            <rect    x="9.1" y="11.0" width="1.8" height="4.2" rx="0.9" fill="#f97316"/>
            <polygon points="7.0,13.8 10,17.4 13,13.8"                   fill="#f97316"/>
          </svg>
          <span id="${ID('drop-title')}">Internet Download Manager</span>
        </div>
        <div class="idm-spin-wrap">
          <div class="idm-spin"></div>
          Escaneando player...
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    const bar  = wrap.querySelector(`#${ID("bar")}`);
    const lbl  = wrap.querySelector(`#${ID("lbl")}`);
    const arr  = wrap.querySelector(`#${ID("arr")}`);
    const cls  = wrap.querySelector(`#${ID("cls")}`);
    const drop = wrap.querySelector(`#${ID("drop")}`);

    // Rastrear quando o usuário fechou — se nova mídia chegar DEPOIS,
    // reexibir o botão (o fechamento era para o vídeo anterior).
    let closedAtMediaTs = -1; // timestamp de lastMediaTs no momento do fechamento

    cls.addEventListener("click", e => {
      e.stopPropagation();
      closedAtMediaTs = lastMediaTs; // guardar qual mídia estava ativa ao fechar
      wrap.classList.add("idm-closed");
      // ── REGRA: fechar pelo "✕" (idm-cls) é um reset explícito ──────
      // Ao reaparecer (nova mídia), o botão deve voltar à posição padrão
      // (top-right do player), não à posição arrastada anteriormente.
      // wrap.__idmResetPosition é definido por startPlayerWatcher() e
      // limpa userMoved/lastTarget/lastPrincipal daquela instância.
      wrap.__idmResetPosition?.();
    });

    makeDraggable(wrap, bar);

    // ── Dropdown ─────────────────────────────────────────────
    let open = false;
    // [FIX 4] Substituir flag booleana por timestamp.
    // O dropdown é re-populado sempre que lastMediaTs for
    // maior que dropPopulatedTs (novas mídias chegaram).
    let dropPopulatedTs = 0;

    // Registrar resetter desta instância — permite que handlers em
    // escopo de módulo (clearYtMedia) invalidem o cache do dropdown
    // de TODAS as instâncias (principal + preview) sem acessar esta
    // variável diretamente (ela é privada deste closure).
    _dropPopulatedResetters.push(() => { dropPopulatedTs = 0; });

    // Registrar callback de atualização para scroll infinito e SPA
    // O callback é adicionado ao array global — não sobrescreve outros frames
    _dropdownCallbacks.push(() => {
      if (open) {
        // Dropdown aberto e chegou nova mídia → re-popular em tempo real
        populateDrop(true);
      }
      // Dropdown fechado: dropPopulatedTs < lastMediaTs → próxima abertura re-popula

      // Re-exibir botão se estava fechado E chegou uma mídia NOVA
      // (diferente da que estava quando o usuário fechou).
      // Isso cobre: TikTok scroll, YouTube Shorts, qualquer SPA onde
      // o usuário fechou para o vídeo A mas veio o vídeo B.
      if (wrap.classList.contains("idm-closed") &&
          lastMediaTs > closedAtMediaTs &&
          closedAtMediaTs >= 0) {
        wrap.classList.remove("idm-closed");
      }
    });

    function openDrop() {
      open = true;
      arr.classList.add("open");
      drop.classList.add("open");
      bar.removeAttribute("title");
      // Re-popular se nunca populado OU se chegaram novas mídias
      if (dropPopulatedTs < lastMediaTs || dropPopulatedTs === 0) {
        populateDrop(false);
      }
    }
    function closeDrop() {
      open = false;
      arr.classList.remove("open");
      drop.classList.remove("open");
      bar.setAttribute("title", "Baixar com IDM");
    }

    arr.addEventListener("click", e => { e.stopPropagation(); open ? closeDrop() : openDrop(); });
    document.addEventListener("click", e => { if (!wrap.contains(e.target)) closeDrop(); }, true);

    lbl.addEventListener("click", e => {
      e.stopPropagation();
      const items = detectVideos();
      if (items.length === 1) {
        sendDownload(items[0]);
      } else {
        openDrop();
      }
    });

    // ── [FIX 4] populateDrop com refresh em tempo real ───────────────────
    // forceRefresh = true: re-popular sem delay (chamado quando chega nova mídia)
    // forceRefresh = false: popular com delay inicial (primeira abertura)
    function populateDrop(forceRefresh) {
      const render = () => {
        dropPopulatedTs = Date.now();
        const items = detectVideos();
        drop.innerHTML = "";

        // Recriar cabeçalho
        const head = document.createElement("div");
        head.id = ID("drop-head");
        head.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="${"idmSph3"+SUF}" cx="36%" cy="32%" r="68%">
                <stop offset="0%"   stop-color="#7ec8ff"/>
                <stop offset="100%" stop-color="#0d3070"/>
              </radialGradient>
              <clipPath id="${"idmClp3"+SUF}"><circle cx="10" cy="9.5" r="7.8"/></clipPath>
            </defs>
            <circle cx="10" cy="9.5" r="7.8" fill="url(#${"idmSph3"+SUF})"/>
            <g clip-path="url(#${"idmClp3"+SUF})" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="0.8">
              <ellipse cx="10" cy="9.5" rx="7.8" ry="2.8"/>
              <ellipse cx="10" cy="9.5" rx="2.8" ry="7.8"/>
            </g>
            <rect    x="9.1" y="11.0" width="1.8" height="4.2" rx="0.9" fill="#f97316"/>
            <polygon points="7.0,13.8 10,17.4 13,13.8"                   fill="#f97316"/>
          </svg>
          <span id="${ID('drop-title')}">Internet Download Manager</span>`;
        drop.appendChild(head);

        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "idm-empty";
          empty.innerHTML = "Nenhuma mídia detectada.<br>Inicie a reprodução e tente novamente.";
          drop.appendChild(empty);
          // Tentar novamente em 2s
          setTimeout(() => {
            if (open && dropPopulatedTs < lastMediaTs + 100) {
              populateDrop(true);
            }
          }, 2000);
          return;
        }

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

        // ── Merge automático YouTube ──────────────────────────────────────
        // Formatos adaptativos YT (vidOnly com site=youtube) são vídeo puro
        // sem áudio. Para o usuário, eles devem aparecer como "Vídeo + Áudio"
        // — o proxy fará merge via yt-dlp/ffmpeg ao baixar.
        //
        // Algoritmo:
        //  1. Separar vídeos YT adaptativos dos demais vídeos puros
        //  2. Para cada vídeo YT, encontrar o melhor áudio disponível
        //     (maior bitrate — geralmente itag 140 = AAC 128k ou 251 = Opus 160k)
        //  3. Criar item "merged" que sobe para a seção ⭐ com needsMerge=true
        //  4. Vídeos YT puros sem correspondência de áudio ficam em vidOnly
        const ytAudioItems = audio.filter(v => v.site === "youtube");
        const bestYtAudio  = ytAudioItems.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

        const ytVidOnly    = vidOnly.filter(v => v.site === "youtube");
        const nonYtVidOnly = vidOnly; // Manter todos os vídeos puros visíveis, incluindo YT

        // Criar itens mergeados para cada qualidade YT adaptativa
        const ytMerged = ytVidOnly.map(v => ({
          ...v,
          muxed:      true,      // exibir na seção ⭐
          needsMerge: true,      // sinalizar ao launcher que precisa merge
          audioItag:  bestYtAudio?.itag   || "",
          audioUrl:   bestYtAudio?.url    || "",
          label:      v.height ? `${v.height}p` : v.label,
        }));

        // Lista final de itens ⭐: muxed nativos + YT mergeados
        const allMuxed = sortByRes([...muxed, ...ytMerged]);

        if (allMuxed.length) {
          addSection(`⭐ Vídeo + Áudio — ${allMuxed.length} qualidades`);
          allMuxed.forEach(v => drop.appendChild(makeRow(v, "t-video", "⭐")));
        }
        if (nonYtVidOnly.length) {
          if (allMuxed.length) addDiv();
          addSection(`🎬 Vídeo puro — ${nonYtVidOnly.length} qualidades`);
          nonYtVidOnly.forEach(v => drop.appendChild(makeRow(v, "t-video", "🎬")));
        }
        if (streams.length) {
          if (allMuxed.length || nonYtVidOnly.length) addDiv();
          addSection(`📡 Stream — ${streams.length}`);
          streams.forEach(v => drop.appendChild(makeRow(v, "t-hls", "📡")));
        }
        if (audio.length) {
          if (allMuxed.length || nonYtVidOnly.length || streams.length) addDiv();
          addSection(`🎵 Áudio — ${audio.length} qualidades`);
          audio.forEach(v => drop.appendChild(makeRow(v, "t-audio", "🎵")));
        }
      };

      if (forceRefresh) {
        render();
      } else {
        setTimeout(render, 600);
      }

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

    function makeRow(v, cls, ico) {
      const btn = document.createElement("button");
      btn.className = `idm-row ${cls}`;

      let displayName = v.title || v.label || "Desconhecido";
      displayName = displayName.replace(/\s*\d{3,4}[pP]\s*(\d+fps)?/g, "").trim();
      if (!displayName) displayName = v.label || "Desconhecido";

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

      let badgeNum  = "";
      let badgeTier = "";

      if (v.type === "audio") {
        const brMatch = (v.label || "").match(/(\d+)\s*k/i);
        badgeNum  = brMatch ? brMatch[1] + "k" : "ÁUDIO";
        badgeTier = brMatch ? "bps" : "";
      } else if (v.type === "hls" || v.type === "dash") {
        badgeNum  = v.type.toUpperCase();
        badgeTier = "";
      } else {
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
          badgeNum = h + "p"; badgeTier = "";
        } else if (h >= 360) {
          badgeNum = h + "p"; badgeTier = "";
        } else if (h > 0) {
          badgeNum = h + "p"; badgeTier = "";
        } else if (v.label) {
          badgeNum = v.label.replace(/\s*\d+fps.*/i, "").trim();
          badgeTier = "";
        }
      }

      const tierHtml = badgeTier
        ? `<span class="idm-badge-tier">${esc(badgeTier)}</span>`
        : "";

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

    function sendDownload(v) {
      lbl.textContent = "Enviando...";
      setTimeout(() => { lbl.textContent = "Baixar com IDM"; }, 2500);

      let mediaOrigin = "";
      let mediaDomain = "";
      try {
        const mu = new URL(v.url);
        mediaOrigin = `${mu.protocol}//${mu.host}`;
        mediaDomain = mu.hostname;
      } catch (_) {}

      const mediaReferrer = location.href;
      const requestType = (v.type === "video" || v.type === "audio" || v.type === "hls") ? "stream" : "download";

      let filename = "";
      try {
        // Para vídeos YouTube que precisam de merge: usar título + resolução
        if (v.site === "youtube" && v.itag) {
          const res = v.height ? `_${v.height}p` : "";
          const safetitle = safeName(v.title || document.title);
          filename = safetitle + res + ".mp4";
        } else {
          const urlPath = v.url.split("?")[0].split("#")[0];
          const urlBase = urlPath.split("/").filter(Boolean).pop() || "";
          if (urlBase && /\.\w{2,5}$/.test(urlBase)) {
            filename = decodeURIComponent(urlBase);
          }
        }
      } catch (_) {}

      if (!filename) {
        filename = safeName(v.title || document.title) + guessExt(v);
      }

      const streamKeys = [];
      for (const src of [v.url, v.masterUrl].filter(Boolean)) {
        const k = hlsKeys.get(src) || hlsKeys.get("key:" + src);
        if (k) streamKeys.push(...k);
      }

      try {
        chrome.runtime.sendMessage({
          action:      "captureDownload",
          url:         v.url,
          filename,
          referrer:    mediaReferrer,
          mediaOrigin,
          mediaDomain,
          requestType,
          site:        v.site || location.hostname.replace(/^www\./, ""),
          hlsKeys:     streamKeys.length > 0 ? streamKeys : undefined,
          // Campos para merge YT: itag do vídeo, itag do áudio pareado, altura
          itag:        v.itag        || undefined,
          audioItag:   v.audioItag   || undefined,
          height:      v.height      || undefined,
          needsMerge:  v.needsMerge  || false,
          videoId:     v.videoId     || undefined,
        }).catch(() => {});
      } catch (_) {}
    }

    // onNavigate só faz sentido para a instância PRINCIPAL — ela é a
    // única que reage a mudanças de URL/SPA (reset de pageMedia,
    // resetForNav ao interceptor, estado do TikTok, etc). A instância
    // de preview (isPreview=true) recebe um onNavigate vazio: o
    // coordenador (dualButtonCoordinator.onPageNavigate) já cuida de
    // ocultar/resetar a instância de preview quando a principal navega.
    const onNavigate = isPreview ? () => {} : () => {
      // onNavigate: nova URL de SPA detectada (YouTube, TikTok, Shorts, etc.)
      dropPopulatedTs = 0;
      lastMediaTs     = 0;
      pageMedia.clear();
      hlsKeys.clear();
      navFreshUntil = Date.now() + 3000;

      // Enviar resetForNav ANTES de qualquer re-emissão do interceptor.
      // O postMessage é síncrono no mesmo frame: o interceptor (MAIN) recebe
      // no mesmo task, limpa captured, e fica pronto para re-emitir.
      window.postMessage({ __idmBridge: true, type: "resetForNav" }, "*");

      // Resetar estado TikTok ao navegar
      activeTikTokVideoId = extractTikTokVideoId(location.href);
      activeTikTokSrc     = null;
      lastTikTokSrc       = null;

      // Solicitar re-probe do interceptor após o resetForNav ser processado.
      // YouTube Shorts: ytInitialPlayerResponse pode já estar disponível no
      // window.ytInitialPlayerResponse da nova página — o re-probe captura.
      // Fazemos em 3 momentos: 150ms (dados já disponíveis), 800ms (player
      // setup concluído) e 2000ms (lazy loaders e iframes tardios).
      const reProbe = () => window.postMessage({ __idmBridge: true, type: "reprobeNow" }, "*");
      setTimeout(reProbe, 150);
      setTimeout(reProbe, 800);
      setTimeout(reProbe, 2000);
    };

    startPlayerWatcher(wrap, closeDrop, onNavigate, isPreview);

    return wrap;
  }

  // ─────────────────────────────────────────────────────────────
  // detectVideos
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

    try {
      const intercepted = window.__idmGetMedia?.() || [];
      intercepted.forEach(add);
    } catch (_) {}

    pageMedia.forEach(add);

    [...document.querySelectorAll("video")]
      .sort((a, b) => {
        const ap = !a.paused ? 1 : 0, bp = !b.paused ? 1 : 0;
        return ap !== bp ? bp - ap : (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight);
      })
      .forEach(el => {
        const res = fmtRes(el.videoWidth, el.videoHeight) || "Vídeo";
        [el.currentSrc, el.src].forEach(s => {
          if (s?.startsWith("http")) add({ url: s, label: res, type: "video" });
        });
        el.querySelectorAll("source[src]").forEach(s => {
          if (s.src?.startsWith("http"))
            add({ url: s.src, label: s.getAttribute("label") || s.getAttribute("data-res") || res, type: typeFromUrl(s.src) });
        });
        // data-src, data-url, data-file — attrs usados por lazy-load e players custom
        ["data-src","data-url","data-file","data-video","data-stream"].forEach(attr => {
          const v = el.getAttribute(attr);
          if (v?.startsWith("http")) add({ url: v, label: res, type: typeFromUrl(v) });
        });
      });

    [...document.querySelectorAll("audio")].forEach(el => {
      [el.currentSrc, el.src].forEach(s => {
        if (s?.startsWith("http")) add({ url: s, label: "Áudio", type: "audio" });
      });
    });

    document.querySelectorAll("iframe[src]").forEach(el => {
      const yt = el.src.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([^?&"]+)/);
      if (yt) add({ url: `https://www.youtube.com/watch?v=${yt[1]}`, label: "YouTube", type: "youtube" });
      const vi = el.src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
      if (vi) add({ url: `https://vimeo.com/${vi[1]}`, label: "Vimeo", type: "vimeo" });
    });

    document.querySelectorAll("script:not([src])").forEach(s => {
      const t = s.textContent || "";
      if (!t.includes("http")) return;

      (t.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd|mp4|webm|mkv|mp3|m4a|aac)(?:[?#][^\s"'<>]*)?/gi) || [])
        .forEach(u => add({ url: u.replace(/['")\\],;>\n\r]+$/, ""), label: resFromUrl(u) || extLabel(u), type: typeFromUrl(u) }));

      for (const [, a, b] of t.matchAll(/"(?:file|src|url)"\s*:\s*"(https?:[^"]+)"[^}]{0,150}"(?:label|quality|res)"\s*:\s*"([^"]+)"/gi))
        add({ url: a.replace(/\\/g,""), label: b, type: typeFromUrl(a) });
      for (const [, a, b] of t.matchAll(/"(?:label|quality|res)"\s*:\s*"([^"]+)"[^}]{0,150}"(?:file|src|url)"\s*:\s*"(https?:[^"]+)"/gi))
        add({ url: b.replace(/\\/g,""), label: a, type: typeFromUrl(b) });
    });

    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Rastreamento global do ponteiro (mousemove)
  //
  // PROBLEMA DAS VERSÕES ANTERIORES: a detecção de "preview em hover"
  // dependia de eventos mouseenter/mouseleave em cada <video>. Isso
  // falha em dois cenários reais do YouTube:
  //
  //   1. Trocar de prévia (card A → card B na Shorts shelf): o YouTube
  //      cria o <video> de B de forma ASSÍNCRONA, ~300-500ms depois do
  //      hover começar. Quando o elemento aparece, o cursor já está
  //      "dentro" dele — mas como ele não existia no momento do
  //      movimento do mouse, NENHUM evento mouseenter é disparado.
  //      hoveredVideo nunca se torna B → o botão nunca reaparece.
  //
  //   2. Mover o mouse para o botão de preview: como .idm-hidden
  //      define pointer-events:none, no instante em que o botão fica
  //      oculto (mesmo que por 1 tick) ele para de receber :hover —
  //      mesmo com o cursor fisicamente sobre ele. pointerOverPreviewButton()
  //      passa a retornar false permanentemente → o botão nunca volta
  //      a aparecer (estado sem saída).
  //
  // SOLUÇÃO: abandonar eventos de hover em <video>/botão. Em vez disso,
  // guardamos a posição ATUAL do ponteiro (mouseX/mouseY) e, a cada
  // previewTick, fazemos HIT-TEST por coordenadas contra os <video>
  // candidatos via getBoundingClientRect(). Isso funciona independente
  // de quando o elemento foi criado, e independente de pointer-events
  // do próprio botão (o botão nunca é o alvo do hit-test).
  // ─────────────────────────────────────────────────────────────

  let mouseX = -1;
  let mouseY = -1;

  window.addEventListener("mousemove", e => {
    mouseX = e.clientX;
    mouseY = e.clientY;

    // ── Resgate imediato do hover no card real do site ────────────────
    // Sem isso, o "resgate" só acontecia no próximo ciclo de
    // previewTick (até 400ms depois) — tempo suficiente para o site já
    // ter reagido ao mouseleave real (pausando/removendo o player de
    // prévia) antes do nosso evento sintético chegar. Verificamos AQUI,
    // a cada movimento real do mouse, se o ponteiro está sobre o botão
    // de preview — e se sim, disparamos o hover sintético no mesmo
    // instante, sem esperar o próximo tick.
    const pv = dualButtonCoordinator?._pvWrap;
    if (pv && !pv.classList.contains("idm-closed") && lastPreviewEl) {
      const pr = pv.getBoundingClientRect();
      if (pr.width > 0 && pr.height > 0 &&
          mouseX >= pr.left && mouseX <= pr.right &&
          mouseY >= pr.top  && mouseY <= pr.bottom) {
        dispatchSyntheticHover(lastPreviewEl);
      }
    }
  }, { passive: true });

  const PRINCIPAL_AREA = 90_000;
  const PLAYING_AREA   = 40_000;
  const MIN_VISIBILITY = 0.40;

  // pointInRect — true se (x,y) está dentro do rect (DOMRect ou objeto
  // {left,top,right,bottom}).
  function pointInRect(x, y, r) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  // dispatchSyntheticHover — simula, para o elemento real do site, que o
  // ponteiro do mouse ainda está sobre ele, mesmo que fisicamente o
  // cursor esteja sobre o nosso botão de preview (#idm-float-pv).
  //
  // POR QUÊ: vários sites (TikTok, YouTube) escutam mouseleave/
  // pointerleave no próprio <video>/card para pausar ou remover o
  // player de prévia quando o hover termina. Como nosso botão fica
  // posicionado SOBRE o card mas é um elemento DOM separado (não é
  // filho do card), mover o cursor até ele gera um mouseleave GENUÍNO
  // do browser no elemento de baixo — o site reage normalmente,
  // achando que o usuário não está mais interessado naquela prévia.
  //
  // Disparamos mouseover + mousemove (não mouseenter, que muitos sites
  // tratam como evento "de uma vez" — mousemove repetido é o sinal mais
  // confiável de "o ponteiro continua aqui", e é o que a maioria dos
  // listeners de hover-intent realmente verifica).
  //
  // Throttle de 300ms: chamado a cada ciclo de previewTick (400ms) via
  // classifyPlayers, não precisa disparar a cada chamada — apenas
  // manter o site "convencido" de que o hover continua, em intervalos
  // espaçados o suficiente para não gerar overhead perceptível.
  let _lastSyntheticHoverEl = null;
  let _lastSyntheticHoverTs = 0;

  function dispatchSyntheticHover(el) {
    if (!el || !document.contains(el)) return;
    const now = Date.now();
    if (el === _lastSyntheticHoverEl && (now - _lastSyntheticHoverTs) < 300) return;
    _lastSyntheticHoverEl = el;
    _lastSyntheticHoverTs = now;

    try {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const opts = {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        view: window,
      };
      el.dispatchEvent(new MouseEvent("mouseover", opts));
      el.dispatchEvent(new MouseEvent("mousemove", opts));
    } catch (_) {
      // Elemento problemático (ex: removido entre o contains() e o
      // dispatchEvent) — ignorar silenciosamente, não é crítico.
    }
  }

  // isInShortsShelf — detecta se um <video> está dentro do contêiner de
  // prévias do YouTube Shorts (rail horizontal na home/grade).
  //
  // REGRA ESPECIAL PARA SHORTS:
  // O contêiner ytd-rich-shelf-renderer com Shorts recria o player de
  // prévia (#inline-preview-player) a cada hover, e o elemento <video>
  // ANTERIOR pode permanecer no DOM por um instante em estado "morto"
  // (paused, sem dimensões) enquanto o NOVO já está renderizado.
  // Vídeos dentro deste contêiner são tratados como "preview" mesmo
  // que classifyPlayers não os qualifique pelas heurísticas normais
  // (área/visibilidade), pois os cards de Shorts são intencionalmente
  // pequenos e verticais — não atingem PLAYING_AREA com facilidade.
  function isInShortsShelf(el) {
    return !!el.closest(
      "ytd-rich-shelf-renderer, ytd-reel-shelf-renderer, " +
      "ytd-shorts, #shorts-container, [is-shorts]"
    );
  }

  // ─────────────────────────────────────────────────────────────
  // dualButtonCoordinator
  //
  // REGRA: quando há um player PRINCIPAL ativo/reproduzindo e o
  // usuário aponta para OUTRO player que entra em modo preview (e o
  // site permite reproduzir a prévia enquanto o principal continua
  // tocando), a instância principal NÃO se move — ela continua
  // apontando para o player principal. Uma SEGUNDA instância
  // (#idm-float-pv) é criada/atualizada para o preview, reposicionando
  // a cada nova prévia iniciada pelo hover.
  //
  // Quando o preview termina (mouse saiu, sem outro hover), a
  // instância de preview é ocultada (não destruída — reaproveitada na
  // próxima prévia, evitando recriar DOM/CSS repetidamente).
  // ─────────────────────────────────────────────────────────────

  const dualButtonCoordinator = {
    _pvWrap: null,

    // _creatingPvWrap — guarda de reentrância: true enquanto
    // createButtonInstance("idm-float-pv", ...) está em andamento, mas
    // ainda não retornou (e portanto this._pvWrap ainda não foi
    // atribuído). Defesa em profundidade contra qualquer chamada futura
    // a ensureInstance() que aconteça de forma reentrante durante essa
    // janela — sem este guard, _pvWrap fica null durante toda a
    // construção da instância, e qualquer código que rode síncrona-
    // mente dentro dela (ex: a primeira execução de previewTick, que já
    // foi removida daqui mas poderia reaparecer por outro caminho)
    // veria _pvWrap null e tentaria criar a instância de novo —
    // chamando createButtonInstance recursivamente até estourar a pilha
    // (RangeError: Maximum call stack size exceeded).
    _creatingPvWrap: false,

    // principalActive — true se o player principal está ativo/reproduzindo.
    // Definido pelo tick() da instância principal (800ms).
    principalActive: false,

    // ensureInstance — garante que #idm-float-pv existe no DOM.
    ensureInstance() {
      if (this._creatingPvWrap) return this._pvWrap; // reentrância — abortar
      if (!this._pvWrap) {
        this._creatingPvWrap = true;
        try {
          this._pvWrap = createButtonInstance("idm-float-pv", true);
        } finally {
          this._creatingPvWrap = false;
        }
      }
      this._pvWrap?.classList.remove("idm-closed");
      return this._pvWrap;
    },

    // onPageNavigate: chamado pela instância principal quando a URL
    // muda (REGRA 1 — navegação de página). A instância de preview,
    // se existir, deve voltar ao estado "recém-criado": esconder e
    // resetar sua posição para que o próximo preview na nova página
    // reposicione do zero.
    onPageNavigate() {
      if (this._pvWrap) {
        this._pvWrap.classList.add("idm-hidden");
        this._pvWrap.__idmResetPosition?.();
      }
      // lastPreviewEl referenciava um <video> da página anterior que
      // pode ter sido removido do DOM — invalidar.
      lastPreviewEl = null;
    },
  };

  // classifyPlayers — varre todos os <video> da página e classifica
  // em "principal" (player de watch ativo) e "preview" (card em hover
  // via posição do mouse, ou pequeno vídeo autoplay).
  //
  // O preview é determinado por HIT-TEST: o <video> cuja área visível
  // contém (mouseX, mouseY) — OU, se o botão de preview já existe e
  // está sendo exibido, o mouse pode estar sobre ELE (não sobre o
  // <video>); nesse caso o preview ANTERIOR (lastPreviewEl) é mantido,
  // pois o usuário está interagindo com o botão da prévia atual.
  let lastPreviewEl = null;

  // Cache de curtíssima duração para classifyPlayers(). tick() (800ms) e
  // previewTick() (400ms) chamavam esta função de forma totalmente
  // independente — em qualquer momento em que ambas rodassem perto uma da
  // outra (o que é frequente, já que 400 é divisor de 800), a varredura
  // completa de <video>s era feita DUAS VEZES processando o mesmo estado
  // do DOM. Em sites com centenas de <video> no DOM (TikTok com scroll
  // infinito acumula muitos elementos pausados fora da viewport, não
  // removidos), isso dobra o custo por ciclo sem necessidade — o conteúdo
  // da página não muda em uma janela de 150ms. Cache zera o trabalho
  // redundante sem prejudicar a responsividade percebida (150ms é bem
  // abaixo do limiar perceptível para reposicionamento de UI).
  let _classifyCache    = null;
  let _classifyCacheTs  = 0;
  const CLASSIFY_TTL_MS = 150;

  function classifyPlayers() {
    const now = Date.now();
    if (_classifyCache && (now - _classifyCacheTs) < CLASSIFY_TTL_MS) {
      return _classifyCache;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const viewportArea = vw * vh;

    let principal      = null;
    let principalScore = 0;
    let preview        = null;
    let previewArea    = 0;

    // ── Fallback "candidato único" ──────────────────────────────────
    // Em sites genéricos (players pequenos, abaixo de PRINCIPAL_AREA/
    // PLAYING_AREA, ou PAUSADOS — playing=false desqualifica a 2ª
    // condição de isPrincipal), nenhum <video> pode satisfazer
    // isPrincipal. Sem fallback, classifyPlayers retorna
    // {principal:null, preview:null} mesmo havendo um único <video>
    // real e visível na página — o tick() então cai no branch
    // "!target" (canto superior-direito da viewport), "roubando" a
    // posição do player legítimo.
    //
    // Contamos quantos <video> têm área visível mínima (>= 2.000px²,
    // ~50×40 — descarta elementos de tracking/anúncio ocultos com
    // dimensões residuais) e guardamos o ÚLTIMO como candidato único.
    // Se exatamente 1 atender, ele se torna "principal" mesmo
    // pausado/pequeno — desde que NENHUM outro vídeo tenha sido
    // classificado como principal/preview pelas regras normais.
    const SOLO_MIN_AREA = 2_000;
    let soloCandidate = null;
    let soloCount     = 0;

    // ── 0. O ponteiro está sobre o botão de preview atualmente exibido? ──
    // Se sim, e havia um preview válido, mantê-lo — o usuário está
    // interagindo com o botão (abrindo dropdown, etc), não abandonou
    // a prévia. Verificado por RECT, não por :hover (que falha quando
    // pointer-events:none está/esteve ativo).
    //
    // IMPORTANTE: o hit-test NÃO exclui o botão quando ele já está
    // com idm-hidden. Antes excluía (checava !idm-hidden antes do
    // hit-test) — isso criava um ciclo sem saída: assim que o botão
    // ficava oculto por qualquer motivo (ex: 1 tick em que nenhum
    // <video> estava sob o cursor durante a transição de hover), a
    // condição "!idm-hidden" passava a ser sempre falsa para ELE
    // MESMO, então pointerOverPvButton nunca mais podia ficar true —
    // mesmo com o mouse fisicamente sobre o botão — e ele nunca
    // reaparecia. O hit-test usa apenas getBoundingClientRect (que
    // continua válido mesmo com opacity:0/pointer-events:none via
    // CSS), então funciona independente do estado de visibilidade.
    const pv = dualButtonCoordinator._pvWrap;
    let pointerOverPvButton = false;
    if (pv && !pv.classList.contains("idm-closed") && mouseX >= 0) {
      const pr = pv.getBoundingClientRect();
      if (pr.width > 0 && pr.height > 0 && pointInRect(mouseX, mouseY, pr)) {
        pointerOverPvButton = true;
      }
    }

    // ── Limite de segurança para sites com muitos <video> ──────────────
    // Sites com vídeos de fundo decorativos (carrosséis, heros, players
    // de anúncio) podem ter dezenas de elementos <video>. TikTok em
    // particular acumula muitos elementos <video> pausados no DOM durante
    // o scroll infinito (vídeos antigos não são removidos, só ficam fora
    // da viewport). Processar todos com getClippedRect — que percorre até
    // 6 ancestrais com getComputedStyle cada — é custoso e foi associado
    // a RangeError (Maximum call stack size exceeded) e lentidão
    // perceptível. Reduzido de 30 para 20 elementos por chamada — ainda
    // mais que suficiente para qualquer candidato legítimo a principal/
    // preview, que está sempre próximo do topo do DOM/viewport.
    const allVideos = document.querySelectorAll("video");
    const videoCap  = Math.min(allVideos.length, 20);

    for (let vi = 0; vi < videoCap; vi++) {
      const el = allVideos[vi];
      // Qualquer exceção neste corpo (incluindo as lançadas por
      // getComputedStyle/getBoundingClientRect em elementos com estado
      // de layout atípico) é isolada por elemento — um <video>
      // problemático não interrompe a classificação dos demais nem
      // propaga o erro para o tick() que chamou classifyPlayers().
      try {
      const r = el.getBoundingClientRect();
      const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const visArea = visW * visH;
      const visRatio = viewportArea > 0 ? visArea / viewportArea : 0;
      const playing  = !el.paused && !el.ended && el.readyState >= 2;
      const elemArea = r.width * r.height;

      const inShorts    = isInShortsShelf(el);
      const minPrevArea = inShorts ? 50 : 300;

      // ── Hit-test por posição do mouse ───────────────────────────
      // Usa o rect RECORTADO (getClippedRect) — o mesmo usado para
      // posicionar o botão — para que o hit-test corresponda à área
      // VISÍVEL do card, não à área real (inflada) do <video> com
      // object-fit:cover.
      const clipped = getClippedRect(el);
      const pointerInside = mouseX >= 0 &&
        pointInRect(mouseX, mouseY, clipped) &&
        clipped.width > 0 && clipped.height > 0;

      if (pointerInside && visArea > minPrevArea) {
        if (!preview || visArea > previewArea) {
          preview     = el;
          previewArea = visArea;
        }
      }

      const isPrincipal =
        (visRatio >= MIN_VISIBILITY && elemArea >= PRINCIPAL_AREA) ||
        (playing && elemArea >= PLAYING_AREA && visRatio >= 0.15);

      // Candidato a "único vídeo da página" — qualquer <video> com
      // área visível mínima, independente de playing/pausado, exceto
      // os que já sabemos ser cards de prévia (Shorts shelf).
      if (visArea >= SOLO_MIN_AREA && !inShorts) {
        soloCount++;
        soloCandidate = el;
      }

      // Vídeos dentro do Shorts shelf NUNCA são "principal" — mesmo que
      // por acaso atendam aos critérios de área (ex: shelf expandido em
      // telas pequenas). Isso evita que um card de Shorts "roube" o
      // status de principal do player de watch real.
      if (isPrincipal && !inShorts) {
        const score = visArea + (playing ? 50_000 : 0);
        if (score > principalScore) {
          principalScore = score;
          principal = el;
        }
      } else if (!preview) {
        // Sem hover: vídeo pequeno reproduzindo conta como preview
        if (playing && visArea > 1000) {
          if (!preview || visArea > previewArea) {
            preview     = el;
            previewArea = visArea;
          }
        }
      }
      } catch (_) {
        // Elemento problemático — ignorar e seguir para o próximo
      }
    }

    // ── Aplicar fallback "candidato único" ──────────────────────────
    // Nenhum <video> satisfez isPrincipal (ex: player de site genérico
    // pequeno, ou PAUSADO — playing=false elimina a 2ª condição de
    // isPrincipal). Se exatamente 1 <video> visível existe na página
    // (fora do Shorts shelf), tratá-lo como principal. Isso evita que
    // o tick() caia no branch "!target" (canto superior-direito da
    // viewport) quando há um player real, apenas pausado ou pequeno.
    //
    // Não sobrescreve um `principal` já definido pelas regras normais,
    // e não interfere se houver 2+ candidatos (ambíguo — preferimos
    // não adivinhar qual é o player real).
    if (!principal && soloCount === 1) {
      principal = soloCandidate;
    }

    // ── Ponteiro sobre o botão de preview, sem novo <video> sob o cursor ──
    // Manter o preview anterior — o usuário está interagindo com o botão,
    // que fica posicionado SOBRE o card (logo o cursor não está mais
    // diretamente sobre o <video>, mas sim sobre o botão por cima dele).
    if (!preview && pointerOverPvButton && lastPreviewEl &&
        document.contains(lastPreviewEl)) {
      preview = lastPreviewEl;

      // ── Preservar o hover no elemento REAL do site ──────────────────
      // Diagnóstico: quando o ponteiro sai do <video>/card e entra no
      // nosso botão (#idm-float-pv, um elemento NOSSO, fora da árvore
      // do card), o card real do site recebe um mouseleave GENUÍNO do
      // browser. Muitos sites (TikTok, YouTube) escutam isso para
      // pausar ou até REMOVER do DOM o player de prévia quando o hover
      // termina — daí o preview "morrer" mesmo com pointerOverPvButton
      // true e lastPreviewEl ainda válido neste ciclo: no próximo ciclo,
      // document.contains(lastPreviewEl) já pode ser false (elemento
      // removido pelo site), ou o vídeo continua no DOM mas pausado/
      // sem frame renderizado.
      //
      // Solução: enquanto o ponteiro estiver sobre nosso botão de
      // preview, despachamos eventos sintéticos de mouse (mouseover/
      // mousemove) no elemento real do card — simulando para o site
      // que o cursor ainda está sobre ele. Isso evita que o listener de
      // mouseleave do PRÓPRIO SITE dispare, mantendo a prévia ativa
      // enquanto o usuário interage com nosso botão.
      dispatchSyntheticHover(lastPreviewEl);
    }

    // Preview igual ao principal: descartar (sem distinção de contexto)
    if (preview && preview === principal) preview = null;


    if (preview) lastPreviewEl = preview;

    const result = { principal, preview };
    _classifyCache   = result;
    _classifyCacheTs = now;
    return result;
  }

  // ─────────────────────────────────────────────────────────────
  // startPlayerWatcher
  //
  // isPreviewInstance = false → instância PRINCIPAL (#idm-float).
  //   Posiciona sobre o player principal (vídeo em reprodução/maior).
  //   Lida com navegação de página (onNavigate), reset de mídias, etc.
  //
  // isPreviewInstance = true  → instância de PREVIEW (#idm-float-pv).
  //   Posiciona sobre o card em hover (Shorts shelf, grade da home).
  //   Só existe enquanto há um preview ativo E o principal está sendo
  //   exibido/reproduzido — ver regra "dual button" abaixo.
  // ─────────────────────────────────────────────────────────────

  function startPlayerWatcher(wrap, closeDrop, onNavigate, isPreviewInstance) {
    wrap.addEventListener("mouseenter", () => wrap.classList.add("idm-focused"));
    wrap.addEventListener("mouseleave", () => wrap.classList.remove("idm-focused"));
    wrap.addEventListener("mousedown",  () => wrap.classList.add("idm-focused"));
    window.addEventListener("mouseup",  () => {
      if (!wrap.matches(":hover")) wrap.classList.remove("idm-focused");
    });

    let lastTarget     = null;
    let lastHidden     = null;
    let lastHref       = location.href;
    let userMoved      = false;
    let lastMoveTarget = null;

    // [FIX 6] Rastrear se o player principal mudou
    // para resetar posição imediatamente
    let lastPrincipal  = null;

    // resetPosition — volta ao estado "recém-criado": limpa userMoved,
    // lastTarget e lastPrincipal, forçando reposicionamento na próxima
    // detecção de target. Usado pelas 3 regras de reset:
    //   1. Navegação de página (handled inline em tick via lastHref)
    //   2. Player/preview trocou de mídia (link mudou)
    //   3. Botão foi fechado pelo "✕" (idm-cls)
    function resetPosition() {
      userMoved      = false;
      lastMoveTarget = null;
      lastTarget     = null;
      lastPrincipal  = null;
    }
    // Expor para o handler do botão "✕" (idm-cls), registrado em
    // createButtonInstance — closeDrop já é passado por referência,
    // resetPosition também precisa ser acessível de fora deste closure.
    wrap.__idmResetPosition = resetPosition;

    wrap.addEventListener("mousedown", () => {
      const mark = () => {
        userMoved      = true;
        lastMoveTarget = lastTarget;
        window.removeEventListener("mousemove", mark);
      };
      window.addEventListener("mousemove", mark);
    });

    // ── Instância de PREVIEW: ciclo de vida próprio ────────────────
    // Esta é a ÚNICA fonte de verdade para a visibilidade de
    // #idm-float-pv (idm-hidden). O tick() da instância principal
    // (800ms) NUNCA mexe em idm-hidden desta instância — apenas atualiza
    // dualButtonCoordinator.principalActive, lido aqui.
    //
    // Roda a 400ms (mais frequente que o principal) para acompanhar
    // hovers rápidos entre cards do Shorts shelf sem flicker.
    if (isPreviewInstance) {
      // Guarda de reentrância: se por qualquer motivo (ex: setInterval
      // empilhado, microtask atrasada) uma execução de previewTick ainda
      // estiver em andamento quando outra começa, a segunda é descartada
      // em vez de rodar concorrentemente. Camada final de defesa contra
      // empilhamento de chamadas em páginas pesadas (TikTok, scroll
      // infinito com muitos <video> no DOM).
      let previewTickRunning = false;
      function previewTick() {
        if (previewTickRunning) return;
        previewTickRunning = true;
        try {
          previewTickBody();
        } finally {
          previewTickRunning = false;
        }
      }

      function previewTickBody() {
        if (wrap.classList.contains("idm-closed")) return;

        const { preview } = classifyPlayers();

        // Esconder se: não há preview, OU o principal não está mais
        // ativo (regra: o segundo botão só existe enquanto o principal
        // está reproduzindo e há uma prévia simultânea).
        if (!preview || !dualButtonCoordinator.principalActive) {
          if (lastHidden !== true) {
            wrap.classList.add("idm-hidden");
            lastHidden = true;
            // Não resetar lastTarget aqui: se o MESMO preview voltar
            // (hover saiu e retornou rapidamente para o mesmo card),
            // a posição arrastada pelo usuário é preservada. Reset só
            // ocorre explicitamente (REGRA: novo preview diferente).
          }
          return;
        }

        // preview válido e principal ativo — a própria execução deste
        // previewTick já PROVA que a instância existe e está rodando.
        //
        // ANTES havia uma chamada redundante a dualButtonCoordinator.
        // ensureInstance() aqui — e essa era a causa raiz do
        // RangeError: Maximum call stack size exceeded. Sequência do
        // ciclo infinito:
        //   1. tick() principal detecta preview+principalActive →
        //      chama ensureInstance()
        //   2. _pvWrap ainda é null → ensureInstance() chama
        //      createButtonInstance("idm-float-pv", true)
        //   3. createButtonInstance chama startPlayerWatcher, que (por
        //      ser isPreviewInstance=true) executa previewTick() UMA
        //      VEZ DE FORMA SÍNCRONA, antes de createButtonInstance
        //      retornar — ou seja, ANTES de "this._pvWrap = ..." rodar
        //      em ensureInstance().
        //   4. Essa primeira previewTick() síncrona via aqui e chamava
        //      ensureInstance() de novo. _pvWrap CONTINUA null (ainda
        //      não voltamos do passo 2) → repete o passo 2 → repete o
        //      passo 3 → repete o passo 4 → ... recursão infinita até
        //      estourar a pilha.
        // A instância de preview nunca precisa garantir sua própria
        // existência — isso é responsabilidade exclusiva do tick() da
        // instância PRINCIPAL (ver useSecondButton mais abaixo no
        // arquivo). Removida a chamada.
        if (lastHidden !== false) {
          wrap.classList.remove("idm-hidden");
          lastHidden = false;
        }

        // REGRA: a cada NOVO preview (elemento <video> diferente do
        // anterior), reposicionar sempre — "a cada prévia que é
        // iniciada quando o usuário passar/parar o mouse sobre ele".
        if (preview !== lastTarget) {
          lastTarget = preview;
          userMoved  = false;
          positionNearVideo(wrap, preview, true);
        } else {
          // Mesmo preview: preservar posição arrastada pelo usuário,
          // a menos que ainda não tenha sido posicionado.
          const movedForThisTarget = userMoved && lastMoveTarget === preview;
          if (!movedForThisTarget) {
            positionNearVideo(wrap, preview, true);
          }
        }
      }

      setInterval(previewTick, 400); // mais frequente: hover muda rápido
      previewTick();
      return;
    }

    // ── Instância PRINCIPAL: ciclo completo ────────────────────────
    // Mesma guarda de reentrância aplicada a previewTick — ver comentário
    // acima. Protege contra empilhamento de execuções concorrentes do
    // tick principal (800ms) em páginas pesadas.
    let tickRunning = false;
    function tick() {
      if (tickRunning) return;
      tickRunning = true;
      try {
        tickBody();
      } finally {
        tickRunning = false;
      }
    }

    function tickBody() {
      // TikTok: atualizar ID do vídeo ativo a cada tick (captura scroll)
      refreshTikTokActiveId();

      // ── REGRA 1: Navegação de página → reset total ──────────────
      if (location.href !== lastHref) {
        lastHref = location.href;
        resetPosition();
        closeDrop();
        onNavigate();
        wrap.classList.remove("idm-closed");
        dualButtonCoordinator.onPageNavigate();
      }

      if (wrap.classList.contains("idm-closed")) {
        // Botão principal fechado pelo usuário: o principal não está
        // "ativo" do ponto de vista da regra de dual button — esconder
        // a instância de preview também (se existir).
        dualButtonCoordinator.principalActive = false;
        return;
      }

      const { principal, preview } = classifyPlayers();

      // ── REGRA 2 (dual button): decidir se cria/mantém/destrói o
      // botão de preview, e se o botão PRINCIPAL deve reagir ao
      // preview ou ignorá-lo (porque já existe instância dedicada).
      //
      //   - Sem principal ativo/reproduzindo → comportamento legado:
      //     preview tem prioridade sobre o principal no MESMO botão
      //     (não há "principal" para disputar).
      //   - Com principal ativo/reproduzindo E preview detectado →
      //     o botão principal NÃO se move; o coordenador cria/atualiza
      //     a instância de preview separadamente.
      const principalActive = !!principal && !principal.paused && !principal.ended;
      const useSecondButton = principalActive && !!preview;

      // Atualizar a flag lida pelo previewTick (400ms) da instância de
      // preview. A VISIBILIDADE de #idm-float-pv é decidida inteiramente
      // por previewTick — aqui apenas garantimos que a instância existe
      // quando o segundo botão passa a ser necessário pela primeira vez.
      dualButtonCoordinator.principalActive = principalActive;
      if (useSecondButton) dualButtonCoordinator.ensureInstance();

      const target          = useSecondButton ? principal : (preview || principal);
      const isPreviewTarget = !useSecondButton && !!preview;
      const btnFocused      = wrap.classList.contains("idm-focused");

      if (!target) {
        if (btnFocused) return;
        const hasInterceptedMedia = pageMedia.size > 0;
        if (hasInterceptedMedia) {
          if (lastHidden !== false) {
            wrap.classList.remove("idm-hidden");
            lastHidden = false;
          }
          // ── Modo "flutuante livre" ──────────────────────────────
          // Nenhum <video> foi classificado (top frame não tem player
          // visível — comum em sites genéricos onde o player real está
          // num iframe cross-origin que o content script não enxerga).
          // O botão é posicionado livremente no canto da viewport.
          //
          // PROBLEMA RESOLVIDO: nesse modo, o wrap fica sobreposto à
          // página em sites que ocultam/redirecionam para uma página
          // só-com-o-player — o elemento (101×14px, canto superior
          // direito) capturava cliques destinados ao conteúdo por
          // baixo dele, tornando aquela área "inclicável".
          //
          // idm-floating: aplica pointer-events:none ao CONTAINER
          // (wrap), mas os elementos visuais internos (bar) mantêm
          // pointer-events:auto via CSS — o botão continua clicável,
          // apenas a área "vazia" do wrap (se houver) não intercepta
          // cliques da página.
          wrap.classList.add("idm-floating");
          if (!positionOverIframe(wrap)) {
            const wr = wrap.getBoundingClientRect();
            const ww = wr.width || 150, wh = wr.height || 24;
            setPosition(wrap, window.innerWidth - ww - 12, 12);
          }
          return;
        }
        if (lastHidden !== true) {
          wrap.classList.add("idm-hidden");
          lastHidden = true;
        }
        return;
      }

      if (lastHidden !== false) {
        wrap.classList.remove("idm-hidden");
        lastHidden = false;
      }

      // Player real classificado — saiu do modo "flutuante livre".
      wrap.classList.remove("idm-floating");

      // ── REGRA 3: link do player mudou → reset de posição ────────
      // "ao ser movido para alguma posição (...) deve respeitar a
      // regra de que a página foi atualizada, o player teve alguma
      // atualização do link (...) nessas situações ele retorna ao
      // local original/inicial."
      //
      // Detectamos "link mudou" via currentSrc do <video> alvo — cobre
      // troca de qualidade, próximo vídeo de uma playlist sem navegação
      // de URL (SPA que só troca o src), etc. Comparamos ANTES de
      // decidir targetChanged, para que uma troca de src no MESMO
      // elemento <video> seja tratada como "novo player" (reset).
      const targetSrc  = target.currentSrc || target.src || "";
      const srcChanged = target.__idmLastSrc !== undefined &&
                         targetSrc !== "" &&
                         target.__idmLastSrc !== targetSrc;
      target.__idmLastSrc = targetSrc;

      const targetChanged = target !== lastTarget || srcChanged;

      if (targetChanged) {
        const principalChanged =
          !!principal && !!lastPrincipal && principal !== lastPrincipal;

        const previewChanged = isPreviewTarget;

        // ── FLAG: fechar dropdown ao trocar de player ──────────────
        // Sem isso, o dropdown permanecia aberto ao mudar de prévia —
        // o botão era reposicionado no novo player já com o dropdown
        // (da mídia anterior) visível. closeDrop() é chamado para
        // QUALQUER troca de target (principal→principal, preview→
        // preview, principal↔preview), exceto quando target===null
        // (flicker — não é uma troca real de player).
        if (target !== null) {
          closeDrop();
        }

        lastTarget = target;
        if (principal) lastPrincipal = principal;

        if (target === null) {
          // flicker — preserva estado
        } else if (principalChanged || previewChanged || srcChanged) {
          // (b), (c) ou troca de link no mesmo elemento: sempre
          // reposicionar e descartar a posição arrastada anterior —
          // ela pertencia à mídia anterior, não à nova.
          userMoved      = false;
          lastMoveTarget = null;
          positionNearVideo(wrap, target, isPreviewTarget);
        } else {
          const movedForThisTarget = userMoved && lastMoveTarget === target;
          if (!movedForThisTarget) {
            positionNearVideo(wrap, target, isPreviewTarget);
          }
        }
      }
    }

    setInterval(tick, 800);
    tick();
    setTimeout(tick, 1500);
    setTimeout(tick, 4000);
  }


  // ─────────────────────────────────────────────────────────────
  // positionNearVideo
  //
  // [FIX 6] Dois modos de posicionamento:
  //
  //   isPreview = false (player principal):
  //     Posiciona no canto superior-direito da área visível.
  //     Sempre resetado quando o player principal muda.
  //
  //   isPreview = true (prévia em hover):
  //     Posiciona no TOP do preview (borda superior-direita).
  //     Sempre resetado quando o hover muda para outro preview.
  // ─────────────────────────────────────────────────────────────

  // getClippedRect — retorna o rect do <video> recortado pelos contêineres
  // ancestrais com overflow oculto.
  //
  // PROBLEMA: no YouTube, as prévias em hover (Shorts shelf, grade da home)
  // usam a classe "ytp-fit-cover-video" (object-fit: cover). Isso faz o
  // elemento <video> ser DIMENSIONADO MAIOR que o card da thumbnail — o vídeo
  // "vaza" para fora do card e é recortado visualmente via overflow:hidden
  // no contêiner pai (#container.ytd-player, ytd-thumbnail, etc.).
  //
  // getBoundingClientRect() do <video> retorna o tamanho REAL (maior),
  // não o tamanho VISÍVEL (recortado). Isso fazia o botão se posicionar
  // fora do card visível, "flutuando" sobre vídeos vizinhos na grade.
  //
  // SOLUÇÃO: subir até 6 níveis na árvore de ancestrais. Para cada um,
  // se computedStyle indicar overflow hidden/clip (sinal de que ele recorta
  // o conteúdo), intersectar o rect acumulado com o rect desse ancestral.
  // Parar ao encontrar um contêiner com classe "ytd-thumbnail",
  // "html5-video-player" ou "#container.ytd-player" — esses delimitam
  // exatamente a área do card de prévia no YouTube.
  function getClippedRect(el) {
    const original = el.getBoundingClientRect();
    let rect = original;
    let node = el.parentElement;
    let hops = 0;

    // intersect: aplica a intersecção apenas se o ancestral JÁ TEM LAYOUT
    // (largura/altura > 0). Durante a recriação do player de prévia pelo
    // YouTube (troca de hover entre cards), o ancestral pode existir no DOM
    // mas ainda com rect 0×0×0×0 — um frame antes do layout assentar.
    // Intersectar com um rect zero produziria {0,0,0,0}, "engolindo" o
    // botão. Ignoramos ancestrais não laid-out e seguimos para o próximo.
    const intersect = (r, pr) => {
      if (pr.width <= 0 || pr.height <= 0) return r; // ancestral sem layout — ignorar
      const left   = Math.max(r.left,   pr.left);
      const top    = Math.max(r.top,    pr.top);
      const right  = Math.min(r.right,  pr.right);
      const bottom = Math.min(r.bottom, pr.bottom);
      if (right > left && bottom > top) {
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      }
      return r; // sem overlap válido — manter rect anterior
    };

    while (node && hops < 6) {
      hops++;

      let cs;
      try { cs = getComputedStyle(node); } catch (_) { node = node.parentElement; continue; }

      const overflowHidden =
        cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.overflowY === "hidden" ||
        cs.overflow === "clip"   || cs.overflowX === "clip"   || cs.overflowY === "clip";

      if (overflowHidden) {
        rect = intersect(rect, node.getBoundingClientRect());
      }

      // Containers que delimitam o card de prévia do YT — parar aqui.
      if (node.id === "container" && node.classList?.contains("ytd-player")) break;
      if (node.tagName === "YTD-THUMBNAIL") break;
      if (node.classList?.contains("html5-video-player") && !overflowHidden) {
        rect = intersect(rect, node.getBoundingClientRect());
        break;
      }

      node = node.parentElement;
    }

    // Fallback de segurança: se o recorte resultou em algo degenerado
    // (ex: ancestral ainda sem layout durante transição entre previews),
    // mas o <video> em si tem tamanho real, usar o rect original do <video>.
    // Melhor mostrar o botão um pouco "fora do card" por um frame do que
    // sumir completamente até reload.
    if ((rect.width < 10 || rect.height < 10) && original.width >= 10 && original.height >= 10) {
      return original;
    }

    return rect;
  }

  function positionNearVideo(wrap, videoEl, isPreview) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // [FIX 6] Verificar se o alvo é um iframe de player externo.
    // Quando activeExternalFrame está definido E não encontramos vídeo
    // no top frame, tentar posicionar sobre o <iframe> correspondente.
    // Usar rect recortado para prévias (cards da grade/Shorts shelf) —
    // o player principal raramente tem object-fit:cover problemático,
    // mas aplicar getClippedRect também nele é seguro (idempotente
    // quando não há ancestral com overflow:hidden relevante).
    let r = videoEl ? getClippedRect(videoEl) : null;

    if (!r || (r.width < 10 && r.height < 10)) {
      // Vídeo não visível no top frame — tentar iframe de player externo
      if (activeExternalFrame) {
        const iframes = document.querySelectorAll("iframe");
        for (const f of iframes) {
          try {
            const src = f.src || f.getAttribute("src") || "";
            const fsrc = new URL(src, location.href).origin;
            const target = new URL(activeExternalFrame).origin;
            if (fsrc === target) { r = f.getBoundingClientRect(); break; }
          } catch (_) {}
        }
      }
      if (!r || (r.width < 10 && r.height < 10)) return;
    }

    const visLeft   = Math.max(r.left,   0);
    const visTop    = Math.max(r.top,    0);
    const visRight  = Math.min(r.right,  vw);
    const visBottom = Math.min(r.bottom, vh);

    if (visRight <= visLeft || visBottom <= visTop) return;

    const wr = wrap.getBoundingClientRect();
    const ww = wr.width  || 150;
    const wh = wr.height || 24;
    const MARGIN = 8;

    // Sempre topo-direito: mesmo comportamento para principal e preview
    const tx = Math.max(MARGIN, Math.min(visRight - ww - MARGIN, vw - ww - MARGIN));
    const ty = Math.max(MARGIN, Math.min(visTop   + MARGIN,      vh - wh - MARGIN));

    setPosition(wrap, tx, ty);
  }

  // positionOverIframe: posicionar botão sobre iframe de player externo.
  // Estratégia em camadas:
  //  1. Buscar iframe cuja src origin coincide com activeExternalFrame origin (match exato)
  //  2. Buscar iframe cuja src CONTÉM parte do domínio da mídia capturada (match parcial)
  //  3. Buscar qualquer iframe grande visível (≥ 300×200) como fallback
  function positionOverIframe(wrap) {
    const iframes = Array.from(document.querySelectorAll("iframe"));
    let bestFrame = null;
    let bestArea  = 0;

    const targetOrigin = (() => {
      try { return new URL(activeExternalFrame || "").origin; } catch (_) { return ""; }
    })();

    // Domínio da mídia a partir do pageMedia (para match parcial)
    const mediaDomains = new Set();
    pageMedia.forEach(e => {
      try { mediaDomains.add(new URL(e.url).hostname); } catch (_) {}
    });

    for (const f of iframes) {
      const r = f.getBoundingClientRect();
      if (r.width < 100 || r.height < 80) continue; // muito pequeno
      const vw = window.innerWidth, vh = window.innerHeight;
      const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (visW < 100 || visH < 80) continue; // fora da viewport

      const area = visW * visH;
      const src  = f.src || f.getAttribute("src") || "";

      try {
        if (src && targetOrigin) {
          const fOrigin = new URL(src, location.href).origin;
          if (fOrigin === targetOrigin) { bestFrame = f; break; } // match exato, parar
        }
        // Match parcial: src do iframe contém domínio de uma mídia capturada
        if (src) {
          for (const domain of mediaDomains) {
            if (src.includes(domain)) { if (area > bestArea) { bestArea = area; bestFrame = f; } break; }
          }
        }
        // Fallback: maior iframe visível
        if (!bestFrame && area > bestArea) { bestArea = area; bestFrame = f; }
      } catch (_) {}
    }

    if (!bestFrame) return false;
    const r  = bestFrame.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const wr = wrap.getBoundingClientRect();
    const ww = wr.width || 150, wh = wr.height || 24;
    const M  = 8;
    setPosition(wrap, Math.max(M, Math.min(r.right - ww - M, vw - ww - M)),
                      Math.max(M, Math.min(r.top   + M,      vh - wh - M)));
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // setPosition / getPosition
  // ─────────────────────────────────────────────────────────────

  function setPosition(wrap, x, y) {
    wrap.style.transform = `translate(${x}px,${y}px)`;
    wrap._tx = x;
    wrap._ty = y;
  }

  function getPosition(wrap) {
    return { x: wrap._tx || 0, y: wrap._ty || 0 };
  }

  // ─────────────────────────────────────────────────────────────
  // makeDraggable
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

      const DRAG_THRESHOLD = 4;
      let wasDragged = false;

      document.body.style.userSelect = "none";
      wrap.style.cursor              = "grabbing";

      function onMove(ev) {
        const dx = ev.clientX - mx0;
        const dy = ev.clientY - my0;
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

  function esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

})();
