// interceptor.js — world: MAIN, document_start
// Roda no contexto real da página — acesso a fetch, XHR, MediaSource reais.
// Comunica com content.js (ISOLATED) via window.postMessage.
//
// Melhorias v2.3 (inspiradas no File Centipede):
//   [1] JSON.parse monkey-patch global — captura dados de qualquer player
//       que carregue configuração via JSON.parse(), sem saber o player específico.
//   [2] Varredura heurística de objetos JSON — percorre recursivamente objetos
//       procurando campos url/mime/quality/resolution/duration para extrair mídias
//       de plataformas arbitrárias sem precisar de caso especial por site.
//   [3] Detecção de chave HLS AES-128 — intercepta respostas XHR de 16 bytes
//       com URL contendo "key", necessária para descriptografar streams HLS.
//   [4] Parser M3U8 com qualidades — integra parser_m3u8.js para extrair
//       cada qualidade de um manifest master como item separado no dropdown.

(function () {
  "use strict";

  if (window.__idmBridgeMain) return;
  window.__idmBridgeMain = true;

  const ORIGIN = window.origin || location.origin;
  const captured = new Map();

  // ── Comunicação MAIN → ISOLATED ──────────────────────────────────────────
  function toContent(type, data) {
    window.postMessage({ __idmBridge: true, type, data }, ORIGIN);
  }

  // ── Deduplicador de URLs ──────────────────────────────────────────────────
  function normalizeKey(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes("googlevideo")) {
        return "yt:" + (u.searchParams.get("itag") || u.pathname);
      }
      return u.hostname + u.pathname;
    } catch (_) { return url; }
  }

  function emit(url, info) {
    if (!url || typeof url !== "string" || !url.startsWith("http")) return;
    const key = normalizeKey(url);
    if (captured.has(key)) return;
    const entry = { url, ...info };
    captured.set(key, entry);
    toContent("media", entry);
  }

  // Exportar lista para content.js (world ISOLATED) ler diretamente
  window.__idmGetMedia = () => [...captured.values()];

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 1 — ytInitialPlayerResponse (YouTube)
  // YouTube embute TODAS as qualidades nesta variável antes de qualquer
  // request de rede — fonte mais completa e confiável para o YouTube.
  // ─────────────────────────────────────────────────────────────────────────

  function parseYT(data) {
    if (!data?.streamingData) return;
    const title = data.videoDetails?.title || document.title;

    function processFormat(f, muxed) {
      let url = f.url;
      if (!url) {
        try {
          const p = new URLSearchParams(f.signatureCipher || f.cipher || "");
          url = p.get("url");
        } catch (_) {}
      }
      if (!url?.startsWith("http")) return;

      const mime  = f.mimeType || "";
      const isVid = mime.startsWith("video");
      const isAud = mime.startsWith("audio");
      if (!isVid && !isAud) return;

      let label;
      if (isVid) {
        const res = f.height ? `${f.height}p` : "";
        const fps = f.fps > 30 ? `${f.fps}fps` : "";
        label = [res, fps].filter(Boolean).join(" ") || `itag${f.itag}`;
      } else {
        const br  = f.bitrate ? `${Math.round(f.bitrate / 1000)}k` : "";
        const cod = mime.match(/codecs="([^"]+)"/)?.[1]?.split(",")[0] || "";
        label = ["Áudio", br, cod].filter(Boolean).join(" ");
      }

      emit(url, {
        type: isAud ? "audio" : "video",
        label, muxed: !!muxed,
        itag:    String(f.itag || ""),
        height:  f.height  || 0,
        width:   f.width   || 0,
        bitrate: f.bitrate || 0,
        mime, title, site: "youtube"
      });
    }

    (data.streamingData.formats         || []).forEach(f => processFormat(f, true));
    (data.streamingData.adaptiveFormats || []).forEach(f => processFormat(f, false));

    if (data.streamingData.hlsManifestUrl)
      emit(data.streamingData.hlsManifestUrl,  { type: "hls",  label: "HLS Manifest",  muxed: true,  title, site: "youtube" });
    if (data.streamingData.dashManifestUrl)
      emit(data.streamingData.dashManifestUrl, { type: "dash", label: "DASH Manifest", muxed: false, title, site: "youtube" });
  }

  // Interceptar setter — YT define antes do DOMContentLoaded
  try {
    let _yt;
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      get() { return _yt; },
      set(v) { _yt = v; try { parseYT(v); } catch (_) {} },
      configurable: true
    });
  } catch (_) {}

  function tryReadYT() {
    if (window.ytInitialPlayerResponse) {
      try { parseYT(window.ytInitialPlayerResponse); } catch (_) {}
    }
    document.querySelectorAll("script:not([src]):not([data-ytread])").forEach(s => {
      s.dataset.ytread = "1";
      const t = s.textContent || "";
      const idx = t.indexOf("ytInitialPlayerResponse");
      if (idx < 0) return;
      const start = t.indexOf("{", idx);
      if (start < 0) return;
      let depth = 0, end = start;
      for (; end < t.length; end++) {
        if (t[end] === "{") depth++;
        else if (t[end] === "}") { depth--; if (depth === 0) break; }
      }
      try { parseYT(JSON.parse(t.slice(start, end + 1))); } catch (_) {}
    });
  }
  document.addEventListener("DOMContentLoaded", tryReadYT);
  setTimeout(tryReadYT, 2000);

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 2 — JSON.parse monkey-patch global
  //
  // Herança do File Centipede (content_injected.js):
  // Sobrescreve JSON.parse e analisa TODOS os objetos que a página parsear,
  // independente de origem — captura dados de players que carregam
  // configuração via JSON.parse() sem fazer request visível:
  //   - JWPlayer, Brightcove, Kaltura, Wistia
  //   - Hotmart (payload de inicialização do player embutido na página)
  //   - Qualquer player que faça JSON.parse(configString) ou JSON.parse(xhr.responseText)
  //
  // CUIDADO: chamado com alta frequência — a análise heurística deve ser
  // rápida. Limitar profundidade de recursão e tamanho de objetos.
  // ─────────────────────────────────────────────────────────────────────────

  const _origParse = JSON.parse;

  JSON.parse = function (text) {
    // Chamar o parse original primeiro — nunca bloquear a página
    const result = _origParse.apply(this, arguments);
    try {
      // Só analisar objetos/arrays não triviais
      if (result !== null && typeof result === "object") {
        analyzeJsonObject(result, 0);
      }
    } catch (_) {}
    return result;
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 3 — Varredura heurística de objetos JSON
  //
  // Herança do File Centipede (content_extract.js → analyse_medias_from_object):
  // Percorre recursivamente qualquer objeto JSON procurando campos
  // que indiquem URL de mídia + metadados de qualidade, sem precisar
  // conhecer o schema do player específico.
  //
  // Campos considerados indicativos de mídia:
  //   URL:     nome do campo contém "url", "src", "file", "stream", "uri"
  //   MIME:    nome contém "mime", "content_type", "type" + valor começa com video/audio
  //   QUALITY: nome contém "quality", "resolution", "label", "height", "width"
  //   BITRATE: nome contém "bitrate", "bandwidth", "size"
  //   DURAÇÃO: nome contém "duration"
  //
  // Pontuação mínima de 2 metadados para confirmar que é um objeto de mídia
  // — evita falsos positivos em objetos genéricos com campo "url".
  // ─────────────────────────────────────────────────────────────────────────

  // Cache de objetos já varridos para evitar loops em referências circulares
  const _analyzedObjects = new WeakSet();

  function analyzeJsonObject(obj, depth) {
    if (depth > 8) return; // Limitar profundidade
    if (!obj || typeof obj !== "object") return;
    if (_analyzedObjects.has(obj)) return;
    _analyzedObjects.add(obj);

    if (Array.isArray(obj)) {
      // Limitar arrays grandes — evitar custo O(n) em arrays de segmentos
      if (obj.length > 500) return;
      for (const item of obj) {
        if (item && typeof item === "object") analyzeJsonObject(item, depth + 1);
      }
      return;
    }

    // Tentar extrair mídia deste objeto
    extractMediaFromObject(obj);

    // Recursão nos valores objeto/array
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === "object") {
        analyzeJsonObject(val, depth + 1);
      }
    }
  }

  function extractMediaFromObject(obj) {
    let mediaUrl   = null;  // URL candidata
    let urlKey     = null;  // chave do campo URL
    let mimeType   = null;
    let quality    = null;
    let height     = 0;
    let width      = 0;
    let bitrate    = 0;
    let duration   = 0;
    let score      = 0;     // pontuação de evidências

    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) continue;
      const k = key.toLowerCase();
      const isStr = typeof val === "string";
      const isNum = typeof val === "number";

      // ── Campos de URL ──────────────────────────────────────────
      if (isStr && (k === "url" || k === "src" || k === "file" || k === "uri" ||
                    k === "stream" || k === "source" || k === "videourl" ||
                    k.includes("_url") || k.includes("url_"))) {
        if (val.startsWith("http") || val.startsWith("//")) {
          // Só aceitar se parecer URL de mídia
          if (looksLikeMediaUrl(val)) {
            mediaUrl = val.startsWith("//") ? location.protocol + val : val;
            urlKey   = key;
          }
        }
      }

      // ── Campos de MIME type ────────────────────────────────────
      else if (isStr && (k.includes("mime") || k.includes("content_type") ||
               (k.includes("type") && (val.startsWith("video/") || val.startsWith("audio/"))))) {
        mimeType = val;
        score++;
      }

      // ── Campos de qualidade/resolução ──────────────────────────
      else if (k.includes("quality") || k.includes("label") || k.includes("resolution")) {
        quality = String(val);
        score++;
      }
      else if ((k === "height" || k.endsWith("_height")) && isNum && val > 0) {
        height = val;
        score++;
      }
      else if ((k === "width" || k.endsWith("_width")) && isNum && val > 0) {
        width = val;
      }

      // ── Campos de bitrate/bandwidth ────────────────────────────
      else if ((k.includes("bitrate") || k.includes("bandwidth")) && isNum && val > 0) {
        bitrate = val;
        score++;
      }

      // ── Campos de duração ──────────────────────────────────────
      else if (k.includes("duration") && isNum && val > 0) {
        duration = val;
        score++;
      }
    }

    // Emitir apenas se tiver URL válida + pontuação mínima de metadados
    // Pontuação 0 = URL sem contexto (ex: obj com só "url") → ignorar
    // Pontuação ≥ 1 = URL + pelo menos um metadado de mídia → emitir
    if (!mediaUrl || score < 1) return;

    // Construir label a partir dos metadados disponíveis
    let label = "";
    if (quality) {
      label = quality;
    } else if (height > 0) {
      label = `${height}p`;
    } else if (bitrate > 0) {
      label = `${Math.round(bitrate / 1000)}k`;
    }

    // Inferir tipo pelo MIME ou pela URL
    let type = "video";
    if (mimeType) {
      if (mimeType.startsWith("audio/"))  type = "audio";
      else if (mimeType.includes("m3u8")) type = "hls";
      else if (mimeType.includes("dash")) type = "dash";
    } else {
      const p = mediaUrl.split("?")[0].toLowerCase();
      if (p.endsWith(".m3u8"))                         type = "hls";
      else if (p.endsWith(".mpd"))                     type = "dash";
      else if (/\.(mp3|aac|ogg|opus|m4a|flac)$/.test(p)) type = "audio";
    }

    emit(mediaUrl, {
      type,
      label:   label || (type === "audio" ? "Áudio" : "Vídeo"),
      height,
      width,
      bitrate,
      mime:    mimeType || ""
    });
  }

  // Verificar se uma string parece URL de mídia (evitar falsos positivos)
  function looksLikeMediaUrl(url) {
    try {
      const u   = new URL(url.startsWith("//") ? "https:" + url : url);
      const ext = u.pathname.split(".").pop().toLowerCase();
      // Extensões de mídia comuns
      if (/^(mp4|webm|mkv|mov|avi|m4v|ts|m3u8|mpd|mp3|aac|ogg|opus|m4a|flac|wav)$/.test(ext)) return true;
      // CDNs conhecidos de vídeo
      if (/cf-media\.|vimeocdn\.|akamaized\.|cloudfront\.|googlevideo\.|twitch\.tv|hotmart\./.test(u.hostname)) return true;
      // Parâmetros indicativos de mídia
      if (u.searchParams.has("itag") || u.searchParams.has("quality") ||
          u.searchParams.has("format") || u.pathname.includes("/video/") ||
          u.pathname.includes("/media/") || u.pathname.includes("/stream")) return true;
    } catch (_) {}
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 4 — fetch + XHR com leitura de manifests
  // ─────────────────────────────────────────────────────────────────────────

  const EXT_RE = /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;
  const SEG_RE = /\/(seg|chunk|frag|part)[-_]?\d|\/\d+\.(ts|m4s)(\?|$)|[?&]sq=\d+|\/seg\/\d+\//i;
  const CDN_RE = [
    /cf-media\.hotmart\.com/i,
    /vimeocdn\.com\/.+(sep|chop)\//i,
    /vimeo\.com\/progressive_redirect/i,
    /usher\.twitchapps\.com/i,
    /video-edge[^.]*\.twitch\.tv/i,
    /proxy-\d+\.dailymotion\.com/i,
    /\.akamaized\.net\/.*(video|media)/i,
    /cloudfront\.net\/.*\.(mp4|m3u8|mpd)/i,
  ];

  function isMediaUrl(url) {
    if (!url?.startsWith("http")) return false;
    // Ignorar URLs do próprio proxy local — segmentos HLS reescritos
    // (http://127.0.0.1:PORT/jobID/s?u=...) não devem ser re-emitidos
    // como nova mídia; o proxy já os gerencia com os headers corretos.
    if (url.includes("127.0.0.1") || url.includes("localhost")) return false;
    if (url.includes("googlevideo.com")) return false;
    const path = url.split("?")[0];
    if (SEG_RE.test(path) || SEG_RE.test(url)) return false;
    if (EXT_RE.test(path)) return true;
    return CDN_RE.some(r => r.test(url));
  }

  function classifyUrl(url) {
    const p = url.split("?")[0].toLowerCase();
    if (p.endsWith(".m3u8")) return { type: "hls",   label: "HLS Stream" };
    if (p.endsWith(".mpd"))  return { type: "dash",  label: "DASH Stream" };
    if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/.test(p)) return { type: "audio", label: "Áudio" };
    const res = guessRes(url);
    if (/vimeo/.test(url))       return { type: "video", label: res || "Vimeo" };
    if (/hotmart/.test(url))     return { type: "video", label: res || "Hotmart" };
    if (/twitch/.test(url))      return { type: "video", label: res || "Twitch" };
    if (/dailymotion/.test(url)) return { type: "video", label: res || "Dailymotion" };
    return { type: "video", label: res || "Vídeo" };
  }

  function guessRes(url) {
    const m = url.match(/[/_-](\d{3,4})[pP](?:\b|_)|(\d{3,4})[xX](\d{3,4})|[?&](?:height|h|quality)=(\d{3,4})/i);
    return m ? (m[1] || m[3] || m[4] || "") + "p" : "";
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 5 — Parser M3U8 com extração de qualidades
  //
  // Herança do File Centipede (parser_m3u8.js + create_m3u8_item):
  // Ao detectar um manifest .m3u8, buscar o conteúdo e parsear com
  // parser_m3u8.js para extrair cada qualidade como item separado.
  // Isso permite ao usuário escolher "1080p", "720p", "480p" no dropdown
  // em vez de ver apenas "HLS Stream" como item único.
  //
  // Também captura:
  //   - Streams de áudio separados (#EXT-X-MEDIA TYPE=AUDIO)
  //   - URIs de chaves AES-128 (#EXT-X-KEY) para download de streams criptografados
  // ─────────────────────────────────────────────────────────────────────────

  // Cache de manifests já parseados (evitar re-fetch)
  const parsedManifests = new Set();

  function parseAndEmitM3U8(body, manifestUrl) {
    // Usar o parser injetado por parser_m3u8.js (world: MAIN)
    const parser = window.__idmM3u8Parser;
    if (!parser) {
      // Fallback: parser legado via regex
      parseLegacyM3U8(body, manifestUrl);
      return;
    }

    const result = parser.parse(body, manifestUrl);
    if (!result) return;

    // Emitir chaves de criptografia via mensagem dedicada ao content.js
    // O content.js as inclui no payload enviado ao IDM para descriptografar
    if (result.keys.length > 0) {
      toContent("hlsKeys", { manifestUrl, keys: result.keys });
    }

    if (result.isMaster && result.streams.length > 0) {
      // Playlist master: emitir cada qualidade separada
      for (const stream of result.streams) {
        const absUrl = resolveUrl(stream.address, manifestUrl);
        if (!absUrl) continue;

        // Montar label: resolução + framerate (ex: "1080p 60fps")
        let label = "";
        if (stream.resolution) {
          const [w, h] = stream.resolution.split("x").map(Number);
          label = h ? `${h}p` : stream.resolution;
          if (stream.frameRate > 30) label += ` ${Math.round(stream.frameRate)}fps`;
        } else if (stream.bandwidth > 0) {
          label = `${Math.round(stream.bandwidth / 1000)}k`;
        }

        // Extrair altura para o badge do dropdown
        const [, h] = (stream.resolution || "x").split("x").map(Number);

        emit(absUrl, {
          type:      "hls",
          label:     label || "HLS",
          height:    h || 0,
          bandwidth: stream.bandwidth,
          codecs:    stream.codecs,
          masterUrl: manifestUrl   // referência ao manifest pai
        });
      }

      // Emitir streams de áudio separados se houver
      for (const audio of result.audios) {
        const absUrl = resolveUrl(audio.url, manifestUrl);
        if (!absUrl) continue;
        emit(absUrl, {
          type:  "audio",
          label: audio.name || audio.language || "Áudio HLS"
        });
      }
    } else if (!result.isMaster) {
      // Media playlist simples: emitir a duração total como label
      const dur = result.duration > 0 ? formatDuration(result.duration) : "";
      emit(manifestUrl, {
        type:  "hls",
        label: dur ? `HLS ${dur}` : "HLS Stream"
      });
    }
  }

  // Fallback de parsing via regex (usado se parser_m3u8.js não carregou)
  function parseLegacyM3U8(body, baseUrl) {
    for (const [, w, h, u] of body.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n(https?:[^\n]+)/gi)) {
      emit(u.trim(), { type: "hls", label: `${h}p`, height: +h, width: +w });
    }
    for (const [, u] of body.matchAll(/URI="(https?:[^"]+)"/g)) {
      if (isMediaUrl(u)) emit(u, classifyUrl(u));
    }
  }

  function resolveUrl(address, base) {
    if (!address) return null;
    if (address.startsWith("http")) return address;
    try { return new URL(address, base).href; } catch (_) { return null; }
  }

  function formatDuration(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // Parsear corpo de DASH MPD
  function parseMPD(body) {
    for (const [, u] of body.matchAll(/<BaseURL>(https?:[^<]+)<\/BaseURL>/g)) {
      const url = u.trim();
      if (isMediaUrl(url)) emit(url, classifyUrl(url));
    }
  }

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input
          : input instanceof Request  ? input.url
          : String(input);
    } catch (_) {}

    if (isMediaUrl(url)) {
      const info = classifyUrl(url);
      emit(url, info);
      if ((info.type === "hls" || info.type === "dash") && !parsedManifests.has(url)) {
        parsedManifests.add(url);
        return origFetch.apply(this, arguments).then(resp => {
          if (resp.ok && resp.body) {
            try {
              resp.clone().text().then(body => {
                try {
                  if (info.type === "hls")  parseAndEmitM3U8(body, url);
                  else                      parseMPD(body);
                } catch (_) {}
              }).catch(() => {});
            } catch (_) {}
          }
          return resp;
        });
      }
    }
    return origFetch.apply(this, arguments);
  };

  // XHR — também intercepta chaves HLS AES-128
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__idmUrl    = String(url);
      this.__idmMethod = String(method).toUpperCase();
    } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__idmUrl || "";
      if (isMediaUrl(url)) {
        const info = classifyUrl(url);
        emit(url, info);
        if ((info.type === "hls" || info.type === "dash") && !parsedManifests.has(url)) {
          parsedManifests.add(url);
          this.addEventListener("load", () => {
            try {
              if (info.type === "hls")  parseAndEmitM3U8(this.responseText || "", url);
              else                      parseMPD(this.responseText || "");
            } catch (_) {}
          });
        }
      }

      // ── MELHORIA 3: Detecção de chave HLS AES-128 ─────────────────────
      //
      // Herança do File Centipede (content_injected.js):
      // Streams HLS criptografados com AES-128 fazem um request separado
      // para buscar a chave. O request tem estas características únicas:
      //   - responseType === "arraybuffer"
      //   - response.byteLength === 16 (chave AES-128 = 128 bits = 16 bytes)
      //   - URL geralmente contém "key" ou tem extensão .key
      //
      // Ao detectar, emitir a URL da chave via mensagem dedicada "hlsKey"
      // para que o content.js a inclua no payload enviado ao IDM.
      // Sem a chave, o IDM não consegue descriptografar os segmentos .ts.
      //
      // Nota: também capturar via readystatechange (estado 4) para ter
      // acesso ao response final antes do load disparar.
      if (url.toLowerCase().includes("key") ||
          url.toLowerCase().endsWith(".key")) {
        this.addEventListener("readystatechange", function () {
          if (this.readyState === 4 &&
              this.responseType === "arraybuffer" &&
              this.response instanceof ArrayBuffer &&
              this.response.byteLength === 16) {
            // É uma chave AES-128 — capturar os bytes e a URL
            const keyBytes = Array.from(new Uint8Array(this.response));
            toContent("hlsKey", {
              url:      url,
              keyBytes: keyBytes,   // array de 16 inteiros (0-255)
              keyB64:   btoa(String.fromCharCode(...keyBytes))
            });
          }
        });
      }
    } catch (_) {}
    return origSend.apply(this, arguments);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 6 — <video>/<audio> src direto (players simples)
  // ─────────────────────────────────────────────────────────────────────────

  function watchEl(el) {
    if (el.__idmW) return;
    el.__idmW = true;
    const isAud = el.tagName === "AUDIO";

    function check() {
      const src = el.currentSrc || el.src || "";
      if (!src.startsWith("http") || src.startsWith("blob:")) return;
      const h     = el.videoHeight || 0;
      const label = h >= 2160 ? "4K"   : h >= 1080 ? "1080p" : h >= 720 ? "720p"
                  : h >= 480  ? "480p" : h >= 360  ? "360p"  : h > 0 ? h + "p"
                  : isAud ? "Áudio" : "Vídeo";
      emit(src, { type: isAud ? "audio" : "video", label });
    }

    ["loadstart","loadedmetadata","canplay","playing"].forEach(e => el.addEventListener(e, check));
    check();
  }

  new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType !== 1) return;
    if (n.matches?.("video,audio")) watchEl(n);
    n.querySelectorAll?.("video,audio").forEach(watchEl);
  }))).observe(document.documentElement, { childList: true, subtree: true });
  document.querySelectorAll("video,audio").forEach(watchEl);

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 7 — Scripts inline (JWPlayer, VideoJS, Plyr…)
  // ─────────────────────────────────────────────────────────────────────────

  const scannedScripts = new WeakSet();

  function scanScripts() {
    document.querySelectorAll("script:not([src])").forEach(s => {
      if (scannedScripts.has(s)) return;
      scannedScripts.add(s);
      const t = s.textContent || "";
      if (!t.includes("http")) return;
      if (t.includes("ytInitialPlayerResponse")) return;

      for (const raw of (t.match(/https?:\/\/[^\s"'<>`\\]{10,}/g) || [])) {
        const u = raw.replace(/['")\\],;>\n\r]+$/, "");
        if (isMediaUrl(u)) emit(u, { ...classifyUrl(u), label: guessRes(u) || classifyUrl(u).label });
      }
      for (const m of t.matchAll(/"(?:file|src|url)"\s*:\s*"(https?:[^"]{8,})"[^}]{0,300}"(?:label|quality|res|height)"\s*:\s*"?([^",}\n]{1,30})"?/gi)) {
        const u = m[1].replace(/\\/g, "");
        if (isMediaUrl(u)) emit(u, { ...classifyUrl(u), label: m[2].trim() });
      }
      for (const m of t.matchAll(/"(?:label|quality|res|height)"\s*:\s*"?([^",}\n]{1,30})"?[^}]{0,300}"(?:file|src|url)"\s*:\s*"(https?:[^"]{8,})"/gi)) {
        const u = m[2].replace(/\\/g, "");
        if (isMediaUrl(u)) emit(u, { ...classifyUrl(u), label: m[1].trim() });
      }
    });
  }

  document.addEventListener("DOMContentLoaded", scanScripts);
  new MutationObserver(muts => {
    if (muts.some(m => [...m.addedNodes].some(n => n.nodeName === "SCRIPT" && !n.src)))
      setTimeout(scanScripts, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });

})();
