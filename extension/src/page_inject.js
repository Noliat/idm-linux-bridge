// page_inject.js — roda em document_start (ISOLATED world)
// Única responsabilidade: injetar o interceptor.js no contexto
// da página o mais cedo possível, antes do JS do site executar.

(function () {
  "use strict";

  if (window.__idmInterceptorInjected) return;
  window.__idmInterceptorInjected = true;

  function inject() {
    if (document.getElementById("__idm_interceptor")) return;
    const root = document.head || document.documentElement;
    if (!root) return;

    const s = document.createElement("script");
    s.id  = "__idm_interceptor";
    s.src = chrome.runtime.getURL("src/interceptor.js");
    s.onload = () => s.remove();
    // insertBefore garante que é o primeiro script a rodar
    root.insertBefore(s, root.firstChild);
  }

  // document_start: documentElement existe, head pode não existir ainda
  if (document.documentElement) {
    inject();
  } else {
    new MutationObserver((_, obs) => {
      if (document.documentElement) { obs.disconnect(); inject(); }
    }).observe(document, { childList: true });
  }
})();
