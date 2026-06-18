// page_inject.js — world: ISOLATED, run_at: document_start, all_frames: true
//
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA: MV3 + iframes cross-origin
// ─────────────────────────────────────────────────────────────────────────────
// No MV3, content_scripts com world:"MAIN" não são injetados pelo Chrome em
// iframes cross-origin (ex: player JW em cdn.jwplayer.com, Brightcove em
// players.brightcove.net). É uma restrição de segurança do MV3.
//
// O mundo ISOLATED SIM chega em todos os frames (all_frames:true). Por isso
// este arquivo roda no ISOLATED e injeta o interceptor no MAIN manualmente.
//
// ─────────────────────────────────────────────────────────────────────────────
// SOLUÇÃO: injeção inline síncrona (método do File Centipede adaptado para MV3)
// ─────────────────────────────────────────────────────────────────────────────
//
// O File Centipede usa inject_script() que cria um <script src="..."> — isso
// funciona no MV2 porque o background é persistente e o script já está em cache.
// No MV3, <script src="chrome-extension://..."> ainda é assíncrono e pode chegar
// depois que o player JW já executou seu setup.
//
// Nossa solução:
//   1. Ao carregar, buscar o código do interceptor via fetch() da URL da extensão.
//      fetch() de recursos locais da extensão resolve em microtask (< 1ms, sem rede).
//   2. Guardar o código em __idmInterceptorCode (compartilhado entre frames).
//   3. Em cada frame, injetar como <script> com textContent — SÍNCRONO no parser HTML.
//      O parser HTML executa scripts inline antes de continuar o parse do documento.
//   4. Para frames que carregam antes do fetch terminar: fallback para <script src>.
//
// Isso garante que em iframes de players JW/Brightcove/Kaltura, o interceptor
// instala seus monkey-patches (fetch, XHR, JSON.parse) antes do player executar.
//
// ─────────────────────────────────────────────────────────────────────────────
// RELAY: iframe → frame raiz
// ─────────────────────────────────────────────────────────────────────────────
// O interceptor no iframe faz postMessage para window. Este script faz relay
// para window.top com flag __idmFromFrame para que o content.js (frame raiz)
// receba as mídias capturadas no iframe.

(function () {
  "use strict";

  // Guard global por frame — evitar dupla execução
  if (window.__idmPageInjectDone) return;
  window.__idmPageInjectDone = true;

  const isIframe     = (window !== window.top);
  const interceptorURL = chrome.runtime.getURL("src/interceptor.js");
  const parserURL      = chrome.runtime.getURL("src/parser_m3u8.js");

  // ── Cache global do código do interceptor ────────────────────────────────
  // Compartilhado entre todas as instâncias deste script no mesmo processo
  // de renderer (frames do mesmo tab compartilham o mesmo extensionId scope).
  // Quando o primeiro frame faz o fetch, os demais reutilizam o cache.
  if (!window.__idmCodeCache) {
    window.__idmCodeCache = { parser: null, interceptor: null, promise: null };
  }
  const cache = window.__idmCodeCache;

  // ── Injetar código inline no MAIN (síncrono) ─────────────────────────────
  function injectInline(parserCode, interceptorCode) {
    if (window.__idmBridgeMain) return; // interceptor já ativo neste frame
    const id = "__idm_inl";
    if (document.getElementById(id)) return;

    const root = document.head || document.documentElement;
    if (!root) return;

    const s = document.createElement("script");
    s.id = id;
    // Inline é síncrono: o parser HTML executa este script antes de continuar.
    // Isso garante que fetch/XHR/JSON.parse são patchados antes do player rodar.
    s.textContent = parserCode + "\n" + interceptorCode;
    root.insertBefore(s, root.firstChild);
    // Não remover: remover um script inline não desfaz sua execução,
    // mas deixar no DOM é inofensivo. Remover para manter DOM limpo:
    try { s.remove(); } catch (_) {}
  }

  // ── Injetar via src= (fallback assíncrono) ───────────────────────────────
  // Usado quando o fetch ainda não concluiu (raro, mas possível em frames
  // que carregam muito rapidamente antes do cache ser populado).
  function injectViaSrc() {
    if (window.__idmBridgeMain) return;
    const root = document.head || document.documentElement;
    if (!root) return;

    if (!document.getElementById("__idm_parser_s")) {
      const sp = document.createElement("script");
      sp.id  = "__idm_parser_s";
      sp.src = parserURL;
      sp.onload = () => sp.remove();
      root.insertBefore(sp, root.firstChild);
    }
    if (!document.getElementById("__idm_interceptor_s")) {
      const si = document.createElement("script");
      si.id  = "__idm_interceptor_s";
      si.src = interceptorURL;
      si.dataset.isIframe = isIframe ? "1" : "0";
      si.onload = () => si.remove();
      // Inserir depois do parser para garantir ordem
      const parser = document.getElementById("__idm_parser_s");
      root.insertBefore(si, parser ? parser.nextSibling : root.firstChild);
    }
  }

  // ── Orquestrar a injeção ──────────────────────────────────────────────────
  function doInject() {
    if (cache.parser && cache.interceptor) {
      // Cache quente — injeção síncrona inline
      injectInline(cache.parser, cache.interceptor);
    } else {
      // Cache frio — injetar via src= imediatamente (não bloquear o frame)
      // e simultaneamente popular o cache para frames futuros
      injectViaSrc();

      if (!cache.promise) {
        cache.promise = Promise.all([
          fetch(parserURL).then(r => r.text()),
          fetch(interceptorURL).then(r => r.text())
        ]).then(([pCode, iCode]) => {
          cache.parser      = pCode;
          cache.interceptor = iCode;
          // Cache populado — próximos frames usarão inline
        }).catch(() => {
          // Se fetch falhar (improvável para recursos locais), usar src= apenas
        });
      }
    }
  }

  // Injetar o mais cedo possível
  if (document.documentElement) {
    doInject();
  } else {
    // Raro: document ainda não tem documentElement (parser muito precoce)
    new MutationObserver((_, obs) => {
      if (document.documentElement) { obs.disconnect(); doInject(); }
    }).observe(document, { childList: true });
  }

  // ── Relay: MAIN do iframe → ISOLATED do frame raiz ───────────────────────
  // O interceptor.js (MAIN) no iframe emite via postMessage para window.
  // Este relay (ISOLATED, mesmo frame) captura e repassa para window.top
  // onde o content.js está ouvindo com o botão flutuante.
  //
  // Filtramos __idmFromFrame para evitar relay em cadeia (A→B→C→...).
  if (isIframe) {
    window.addEventListener("message", (e) => {
      if (!e.data?.__idmBridge) return;
      if (e.data.__idmFromFrame) return; // já foi relayado — parar cadeia

      const relayed = {
        ...e.data,
        __idmFromFrame:   true,
        __idmFrameUrl:    location.href,
        __idmFrameOrigin: location.origin
      };

      // Tentar window.top diretamente (1 hop, independente de profundidade)
      try {
        window.top.postMessage(relayed, "*");
      } catch (_) {
        // cross-origin bloqueou top — usar parent como intermediário
        try { window.parent.postMessage(relayed, "*"); } catch (_) {}
      }
    });

    // Após load do iframe, solicitar ao interceptor (MAIN) que re-probe
    // os players externos — garante captura de JW/VideoJS que inicializam
    // durante o load e podem não ter sido capturados no document_start.
    // Fazemos em 3 momentos para cobrir players lentos.
    function requestProbe() {
      try {
        window.postMessage({ __idmBridge: true, type: "reprobeNow" }, "*");
      } catch (_) {}
    }
    if (document.readyState === "complete") {
      requestProbe();
      setTimeout(requestProbe, 800);
    } else {
      window.addEventListener("load", () => {
        requestProbe();
        setTimeout(requestProbe, 600);
        setTimeout(requestProbe, 1500);
      }, { once: true });
    }
  }

  // ── Iframes same-origin criados dinamicamente ─────────────────────────────
  // Para iframes que o site cria em JavaScript depois do document_start
  // (ex: player JW que cria um iframe via JS), tentamos injetar diretamente
  // no contentDocument deles quando são adicionados ao DOM.
  // Para iframes cross-origin, o background.js cuida via webNavigation.onCommitted.
  if (!isIframe) {
    function tryInjectSameOriginIframe(iframe) {
      try {
        const doc = iframe.contentDocument;
        if (!doc || doc.readyState === "uninitialized") return;
        if (doc.__idmBridgeMain) return; // já injetado
        const root = doc.head || doc.documentElement;
        if (!root) return;

        // ── Sempre injetar via src=, nunca inline ───────────────────────
        // O iframe tem sua PRÓPRIA CSP (script-src do site, ex: TikTok),
        // que costuma incluir 'self' e o próprio chrome-extension://<id>
        // do bridge — mas NÃO 'unsafe-inline'. Um <script> com
        // textContent (inline) viola essa CSP e é bloqueado
        // silenciosamente pelo browser:
        //
        //   "Executing inline script violates the following Content
        //    Security Policy directive 'script-src 'self' ...
        //    chrome-extension://<id>/'. [...] requires 'unsafe-inline'"
        //
        // src= apontando para chrome-extension://<id>/src/*.js é
        // permitido por essa mesma CSP (a origem da extensão está
        // explicitamente na allowlist) — então usamos sempre essa forma,
        // mesmo quando cache.parser/cache.interceptor já estão quentes.
        if (!doc.getElementById("__idm_parser_s")) {
          const sp = doc.createElement("script");
          sp.id  = "__idm_parser_s";
          sp.src = parserURL;
          sp.onload = () => sp.remove();
          root.insertBefore(sp, root.firstChild);
        }
        if (!doc.getElementById("__idm_interceptor_s")) {
          const si = doc.createElement("script");
          si.id  = "__idm_interceptor_s";
          si.src = interceptorURL;
          si.dataset.isIframe = "1";
          si.onload = () => si.remove();
          const parser = doc.getElementById("__idm_parser_s");
          root.insertBefore(si, parser ? parser.nextSibling : root.firstChild);
        }
      } catch (_) {
        // cross-origin — background.js cuida via webNavigation.onCommitted
      }
    }

    const iframeObs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeName === "IFRAME") tryInjectSameOriginIframe(node);
          node.querySelectorAll?.("iframe").forEach(tryInjectSameOriginIframe);
        }
      }
    });

    const root = document.documentElement || document;
    iframeObs.observe(root, { childList: true, subtree: true });
  }

})();
