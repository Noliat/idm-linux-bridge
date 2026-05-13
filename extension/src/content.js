// content.js — Injetado em todas as páginas
// Monitora cliques em links de download e detecta vídeos embutidos

(function () {
  "use strict";

  // Evitar injeção dupla
  if (window.__idmBridgeInjected) return;
  window.__idmBridgeInjected = true;

  // Extensões consideradas downloadáveis
  const DL_EXTENSIONS = /\.(mp4|mkv|avi|mov|wmv|flv|webm|mp3|flac|wav|aac|zip|rar|7z|tar\.gz|pdf|exe|deb|iso|apk|torrent)(\?.*)?$/i;

  // ─────────────────────────────────────────
  // Interceptar cliques em links
  // ─────────────────────────────────────────

  document.addEventListener("click", async (e) => {
    const anchor = e.target.closest("a[href]");
    if (!anchor) return;

    const href = anchor.href;
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;

    // Verificar se é um link de download
    const isDownload = anchor.hasAttribute("download") || DL_EXTENSIONS.test(href);
    if (!isDownload) return;

    // Verificar se bridge está disponível
    const { available } = await chrome.runtime.sendMessage({ action: "getBridgeStatus" });
    if (!available) return;

    e.preventDefault();
    e.stopPropagation();

    // Coletar cookies da página atual
    const cookies = document.cookie;

    await chrome.runtime.sendMessage({
      action: "captureDownload",
      url: href,
      filename: anchor.getAttribute("download") || "",
      cookies,
      referrer: window.location.href
    });
  }, true); // capture phase para interceptar antes do browser

  // ─────────────────────────────────────────
  // Detectar vídeos embutidos (YouTube, Vimeo, etc.)
  // ─────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "findVideos") {
      const videos = findVideosOnPage();
      chrome.runtime.sendMessage({ action: "videosFound", videos });
      sendResponse({ count: videos.length });
    }
    return true;
  });

  function findVideosOnPage() {
    const videos = [];

    // Elementos <video> nativos
    document.querySelectorAll("video[src], video source[src]").forEach(el => {
      const src = el.src || el.getAttribute("src");
      if (src && src.startsWith("http")) {
        videos.push({
          url: src,
          title: document.title,
          type: "native"
        });
      }
    });

    // iframes com vídeos (YouTube, Vimeo)
    document.querySelectorAll("iframe[src]").forEach(el => {
      const src = el.src;
      if (src.includes("youtube.com/embed/") || src.includes("youtu.be/")) {
        const videoId = src.match(/embed\/([^?&]+)/)?.[1];
        if (videoId) {
          videos.push({
            url: `https://www.youtube.com/watch?v=${videoId}`,
            title: document.title,
            type: "youtube"
          });
        }
      } else if (src.includes("vimeo.com/video/")) {
        videos.push({
          url: src.replace("/video/", "/").replace("player.", ""),
          title: document.title,
          type: "vimeo"
        });
      }
    });

    // Sources de players customizados (HLS/DASH)
    const scripts = document.querySelectorAll("script:not([src])");
    scripts.forEach(script => {
      const text = script.textContent || "";
      // Procurar URLs de stream HLS (.m3u8)
      const m3u8Matches = text.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g);
      if (m3u8Matches) {
        m3u8Matches.forEach(url => {
          videos.push({ url, title: document.title, type: "hls" });
        });
      }
      // Procurar URLs de stream MP4 em variáveis JS
      const mp4Matches = text.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/g);
      if (mp4Matches) {
        mp4Matches.forEach(url => {
          if (!videos.find(v => v.url === url)) {
            videos.push({ url, title: document.title, type: "mp4" });
          }
        });
      }
    });

    return videos;
  }

  // ─────────────────────────────────────────
  // Botão flutuante de download (sites de vídeo)
  // ─────────────────────────────────────────

  const VIDEO_SITES = ["youtube.com", "vimeo.com", "dailymotion.com", "twitch.tv"];
  const hostname = window.location.hostname.replace("www.", "");

  if (VIDEO_SITES.some(s => hostname.includes(s))) {
    injectDownloadButton();
  }

  function injectDownloadButton() {
    // Esperar o player carregar
    const observer = new MutationObserver(() => {
      const player = document.querySelector(
        "video, .ytp-chrome-top, .player-controls, [class*='player']"
      );
      if (!player || document.getElementById("idm-bridge-btn")) return;

      const btn = document.createElement("button");
      btn.id = "idm-bridge-btn";
      btn.title = "Baixar com IDM";
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      `;
      btn.style.cssText = `
        position: fixed;
        bottom: 80px;
        right: 20px;
        z-index: 9999;
        background: #e74c3c;
        color: white;
        border: none;
        border-radius: 50%;
        width: 44px;
        height: 44px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        transition: transform 0.15s;
      `;
      btn.onmouseenter = () => btn.style.transform = "scale(1.1)";
      btn.onmouseleave = () => btn.style.transform = "scale(1)";
      btn.onclick = () => {
        chrome.runtime.sendMessage({
          action: "captureDownload",
          url: window.location.href,
          referrer: window.location.href
        });
      };

      document.body.appendChild(btn);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
