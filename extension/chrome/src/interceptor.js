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

  // ── Snapshot de globals nativos do browser (document_start) ──────────────
  // Usado por scanWindowGlobals (Estratégia 10) para detectar globals
  // CRIADOS PELO SITE/PLAYER, comparando com este snapshot.
  //
  // Capturado AGORA, em document_start — antes de qualquer script do site
  // executar — então window ainda reflete apenas os globals nativos do
  // browser para este frame/origem. Qualquer propriedade adicionada depois
  // (jwplayer, videojs, __NEXT_DATA__, etc.) é "global do site".
  //
  // ANTES: scanWindowGlobals criava um <iframe> descartável só para obter
  // essa lista via iframe.contentWindow. Cada criação de <iframe> faz o
  // browser reavaliar a CSP da página — em sites com 'upgrade-insecure-
  // requests' (TikTok), isso gerava o aviso "ignored when delivered in a
  // report-only policy" repetidamente. Capturar o snapshot aqui (sem
  // iframe) elimina esse efeito colateral por completo.
  const __idmNativeGlobals = new Set(Object.getOwnPropertyNames(window));

  // Detectar se estamos num iframe cross-origin.
  // Num iframe cross-origin, ORIGIN difere do top e postMessage(msg, ORIGIN)
  // pode falhar silenciosamente se a targetOrigin não bater com o receiver.
  // Usar "*" garante que o ISOLATED do mesmo frame sempre recebe a mensagem.
  // O page_inject.js (ISOLATED) adiciona __idmFromFrame antes de repassar ao top.
  const isXOriginFrame = (function() {
    try { return window !== window.top && window.top.location.origin !== ORIGIN; }
    catch (_) { return true; } // cross-origin: lança SecurityError
  })();
  const MSG_ORIGIN = isXOriginFrame ? "*" : ORIGIN;

  // ── Comunicação MAIN → ISOLATED ──────────────────────────────────────────
  function toContent(type, data) {
    window.postMessage({ __idmBridge: true, type, data }, MSG_ORIGIN);
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
    // Garantir que title reflita document.title corrente.
    // Em SPAs (TikTok, YouTube) o document.title já foi atualizado pela
    // navegação quando o interceptor dispara — mas info.title pode vir de
    // um closure anterior. Usar document.title como fallback/override
    // quando info.title não foi preenchido explicitamente.
    const title = info.title || document.title || "";
    const entry = { url, title, ...info };
    // Se info.title veio explicitamente, ele sobrescreve o title acima
    // via spread — garantir que usamos document.title quando não há title
    if (!info.title) entry.title = document.title || title;
    captured.set(key, entry);
    toContent("media", entry);
  }

  // Exportar lista para content.js (world ISOLATED) ler diretamente
  window.__idmGetMedia = () => [...captured.values()];

  // Limpar estado para nova navegação SPA.
  // Chamado pelo content.js via chrome.scripting.executeScript (world MAIN)
  // quando a URL muda (YouTube clicar em outro vídeo, TikTok scroll, etc.).
  // Sem isso, o guard captured.has(key) bloqueia re-emissão das mesmas keys
  // em novos vídeos que reutilizam o mesmo itag/path (ex: YouTube itag=137).
  window.__idmResetForNav = function() {
    captured.clear();
    parsedManifests.clear();
  };

  // Escutar sinais do content.js (ISOLATED → MAIN via postMessage)
  window.addEventListener("message", (e) => {
    if (!e.data?.__idmBridge) return;

    // resetForNav: limpar captured + parsedManifests para nova navegação SPA
    if (e.data.type === "resetForNav") {
      window.__idmResetForNav();
      // Re-instalar setter do ytInitialPlayerResponse — o YT Shorts pode
      // ter sobrescrito a property durante a navegação anterior
      window.__idmReinstallYTSetter?.(true);
      return;
    }

    // reprobeNow: re-probar players externos após navegação SPA.
    // NÃO re-lemos ytInitialPlayerResponse aqui — ele pode ainda ter o dado
    // do vídeo anterior (o YouTube Shorts atualiza de forma assíncrona).
    // O setter installYTSetter() captura automaticamente quando o YT
    // atualizar ytInitialPlayerResponse com os dados do novo short.
    if (e.data.type === "reprobeNow") {
      // Re-probar apenas players externos (JW, VideoJS, Kaltura, etc.)
      probeExternalPlayers();
      // Re-escanear scripts inline
      try { scanScripts(); } catch (_) {}
      return;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 1 — ytInitialPlayerResponse (YouTube)
  // YouTube embute TODAS as qualidades nesta variável antes de qualquer
  // request de rede — fonte mais completa e confiável para o YouTube.
  // ─────────────────────────────────────────────────────────────────────────

  function parseYT(data) {
    if (!data?.streamingData) return;
    const title = data.videoDetails?.title || document.title;

    // Extrair URL de um formato (pode estar cifrada em signatureCipher)
    function getUrl(f) {
      if (f.url) return f.url;
      try {
        return new URLSearchParams(f.signatureCipher || f.cipher || "").get("url") || "";
      } catch (_) { return ""; }
    }

    // ── Separar adaptiveFormats em vídeo e áudio ──────────────────────────
    const adaptive = data.streamingData.adaptiveFormats || [];

    // Streams de áudio disponíveis com suas URLs resolvidas
    const audioStreams = adaptive
      .filter(f => (f.mimeType || "").startsWith("audio"))
      .map(f => ({ ...f, _url: getUrl(f) }))
      .filter(f => f._url.startsWith("http"));

    // Escolher o melhor áudio por codec e bitrate:
    //   Preferência: mp4a (m4a) > opus > outros
    //   Dentro do mesmo codec: maior bitrate ganha
    function bestAudio(preferMp4a) {
      const codec = preferMp4a ? "mp4a" : "opus";
      const byCodec = audioStreams.filter(f =>
        (f.mimeType || "").includes(codec)
      );
      const pool = byCodec.length > 0 ? byCodec : audioStreams;
      if (!pool.length) return null;
      return pool.reduce((best, f) =>
        (f.audioSampleRate || f.bitrate || 0) > (best.audioSampleRate || best.bitrate || 0)
          ? f : best
      );
    }

    // ── Emitir formats[] — streams muxed (vídeo+áudio) ───────────────────
    // Qualidade baixa (360p, 720p max) mas completos — sem necessidade de mux
    (data.streamingData.formats || []).forEach(f => {
      const url = getUrl(f);
      if (!url.startsWith("http")) return;
      const mime  = f.mimeType || "";
      const isVid = mime.startsWith("video");
      const isAud = mime.startsWith("audio");
      if (!isVid && !isAud) return;
      const res   = f.height ? `${f.height}p` : "";
      const fps   = f.fps > 30 ? `${f.fps}fps` : "";
      const label = [res, fps].filter(Boolean).join(" ") || `itag${f.itag}`;
      emit(url, {
        type: isAud ? "audio" : "video",
        label, muxed: true,       // formato completo — vídeo e áudio juntos
        itag: String(f.itag || ""),
        height: f.height || 0, width: f.width || 0, bitrate: f.bitrate || 0,
        mime, title, site: "youtube"
      });
    });

    // ── Emitir adaptiveFormats[] — parear vídeo com o melhor áudio ────────
    // Cada stream de vídeo DASH (sem áudio) é pareado com o melhor áudio
    // disponível. O proxy faz mux de ambos com ffmpeg antes de entregar ao IDM.
    // O usuário vê resoluções completas (720p, 1080p, 1440p, 4K) no dropdown.
    adaptive
      .filter(f => (f.mimeType || "").startsWith("video"))
      .forEach(f => {
        const url = getUrl(f);
        if (!url.startsWith("http")) return;

        const mime = f.mimeType || "";
        // Preferir áudio mp4a para containers mp4/h264, opus para webm/vp9/av1
        const isMp4Container = mime.includes("mp4") || mime.includes("avc");
        const audio  = bestAudio(isMp4Container);

        const res    = f.height ? `${f.height}p` : "";
        const fps    = f.fps > 30 ? `${f.fps}fps` : "";
        const label  = [res, fps].filter(Boolean).join(" ") || `itag${f.itag}`;

        emit(url, {
          type:     "video",
          label,
          muxed:    false,          // requer mux pelo proxy
          audioUrl: audio?._url || null,  // URL do stream de áudio pareado
          itag:     String(f.itag || ""),
          height:   f.height  || 0,
          width:    f.width   || 0,
          bitrate:  f.bitrate || 0,
          mime, title, site: "youtube"
        });
      });

    // HLS/DASH manifest como fallback
    if (data.streamingData.hlsManifestUrl)
      emit(data.streamingData.hlsManifestUrl,
        { type: "hls", label: "HLS Stream", muxed: true, title, site: "youtube" });
    if (data.streamingData.dashManifestUrl)
      emit(data.streamingData.dashManifestUrl,
        { type: "dash", label: "DASH Stream", muxed: false, title, site: "youtube" });
  }

  // Interceptar setter de ytInitialPlayerResponse.
  // YouTube Shorts define essa variável a cada troca de vídeo — o setter
  // garante captura imediata sem depender de reprobeNow.
  // Protegido contra sobrescrita: se o YT tentar redefinir a property,
  // reinstalamos o setter preservando o novo valor.
  let _yt;
  function installYTSetter() {
    try {
      Object.defineProperty(window, "ytInitialPlayerResponse", {
        get() { return _yt; },
        set(v) {
          _yt = v;
          try { parseYT(v); } catch (_) {}
          // Disparar fetch com cliente ANDROID para formatos > 1080p
          // O setter é chamado na carga inicial da página (não apenas em Shorts scroll)
          try {
            const vid = v?.videoDetails?.videoId;
            if (vid && !window.__idmHiResFetched?.[vid]) {
              window.__idmHiResFetched = window.__idmHiResFetched || {};
              window.__idmHiResFetched[vid] = true;
              setTimeout(() => {
                origFetch.call(window,
                  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type":              "application/json",
                      "X-Youtube-Client-Name":    "3",
                      "X-Youtube-Client-Version": "17.31.35",
                    },
                    body: JSON.stringify({
                      videoId: vid,
                      context: {
                        client: {
                          clientName:        "ANDROID",
                          clientVersion:     "17.31.35",
                          androidSdkVersion: 30,
                          hl: "en", gl: "US",
                        }
                      }
                    })
                  }
                ).then(r => r.ok ? r.json() : null).then(hiResData => {
                  if (!hiResData?.streamingData) return;
                  const hiAdaptive = (hiResData.streamingData.adaptiveFormats || [])
                    .filter(f => (f.height || 0) > 1080 || (f.mimeType || "").startsWith("audio/"));
                  if (hiAdaptive.length > 0) {
                    parseYT({
                      videoDetails:  hiResData.videoDetails,
                      streamingData: { formats: [], adaptiveFormats: hiAdaptive }
                    });
                  }
                }).catch(() => {});
              }, 500);
            }
          } catch (_) {}
        },
        configurable: true,
        enumerable:   true
      });
    } catch (_) {}
  }
  installYTSetter();


  // Re-instalar o setter após resetForNav, pois o YouTube pode ter
  // redefinido a property com Object.defineProperty durante a navegação.
  // (O YouTube Shorts faz isso ao iniciar a sequência de troca de vídeo)
  window.__idmReinstallYTSetter = function(clearPrev) {
    const current = clearPrev ? null : window.ytInitialPlayerResponse;
    try { delete window.ytInitialPlayerResponse; } catch (_) {}
    _yt = null;
    installYTSetter();
    if (current) { _yt = current; }
  };

  function tryReadYT() {
    // Reinstalar setter caso o YT tenha sobrescrito com defineProperty
    window.__idmReinstallYTSetter?.();
    if (_yt) {
      try { parseYT(_yt); } catch (_) {}
    } else if (window.ytInitialPlayerResponse) {
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

  // Cache de objetos já varridos (global para JSON.parse monkey-patch)
  const _analyzedObjects = new WeakSet();

  // analyzeJsonObject: aceita WeakSet externo opcional (para scanWindowGlobals)
  function analyzeJsonObject(obj, depth, _visited) {
    if (depth > 12) return; // FC usa 20, mas 12 é suficiente e mais seguro
    if (!obj || typeof obj !== "object") return;
    const visited = _visited || _analyzedObjects;
    if (visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      if (obj.length === 0 || obj.length > 20000) return; // FC: limite 20000
      for (const item of obj) {
        if (item !== null && typeof item === "object") {
          analyzeJsonObject(item, depth + 1, visited);
        }
      }
      return;
    }

    // Tentar extrair mídia deste objeto
    extractMediaFromObject(obj);

    // Recursão — limitar número de chaves por objeto (FC: 10000)
    let keyCount = 0;
    for (const key of Object.keys(obj)) {
      if (++keyCount > 10000) break;
      const val = obj[key];
      if (val !== null && val !== obj && typeof val === "object") {
        analyzeJsonObject(val, depth + 1, visited);
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

    // Emitir se tiver URL válida:
    //   score >= 1: URL + pelo menos um metadado de mídia → emitir sempre
    //   score == 0: URL sem metadados → emitir apenas se URL é "forte"
    //     (extensão de mídia explícita ou CDN conhecido), evitando falsos positivos
    if (!mediaUrl) return;
    if (score < 1 && !looksLikeMediaUrl(mediaUrl)) return;

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

  // EXT_RE: extensões de arquivo de mídia completo (não segmentos)
  // .ts incluído pois players externos (JW, Wistia, Brightcove) servem
  // arquivos .ts únicos de alta qualidade, não apenas segmentos HLS.
  const EXT_RE = /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v|ts|mp3|m4a|aac|ogg|opus|flac|wav)(\?|#|$)/i;

  // SEG_RE: padrões de segmento HLS/DASH — NÃO são arquivos completos.
  // Nota: /\d+\.ts excluído porque players externos usam caminhos como
  // /media/12345.ts que parecem segmentos mas são arquivos únicos.
  // Usar critério mais estrito: só excluir se tiver padrão de segmentação
  // sequencial explícito (seg-N, chunk-N, part-N, sq=N) ou path /seg/N/.
  const SEG_RE = /\/(seg|chunk|frag|part)[-_]\d|\/seg\/\d+\/|[?&]sq=\d+|segment[=_]\d+/i;

  // M4S_RE: segmentos DASH .m4s sempre são fragmentos, não arquivos completos
  const M4S_RE = /\.m4s(\?|#|$)/i;

  const MIME_VIDEO_RE = /^(video\/(mp4|webm|x-matroska|mp2t|mpeg|ogg|quicktime|x-msvideo|3gpp|x-flv)|audio\/(mpeg|mp4|ogg|wav|flac|aac|webm|x-matroska))/i;
  const MIME_HLS_RE = /^(application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|x-mpegURL)|video\/mp2url)/i;
  const MIME_TO_EXT = {
    "video/mp4": "mp4", "video/webm": "webm", "video/x-matroska": "mkv",
    "video/mp2t": "ts",  "video/mpeg": "mpg",  "video/ogg": "ogv",
    "video/quicktime": "mov", "video/x-msvideo": "avi", "video/x-flv": "flv",
    "video/3gpp": "3gp",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg",
    "audio/wav": "wav",  "audio/flac": "flac", "audio/aac": "aac",
    "audio/webm": "webm", "audio/x-matroska": "mka",
  };

  const CDN_RE = [
    /cf-media\.hotmart\.com/i,
    /vimeocdn\.com\/.+(sep|chop)\//i,
    /vimeo\.com\/progressive_redirect/i,
    /usher\.twitchapps\.com/i,
    /video-edge[^.]*\.twitch\.tv/i,
    /proxy-\d+\.dailymotion\.com/i,
    /\.akamaized\.net\/.*(video|media)/i,
    /cloudfront\.net\/.*\.(mp4|m3u8|mpd|ts)/i,
    // JW Player CDN e plataformas de vídeo corporativas
    /cdn\.jwplayer\.com\/videos\//i,
    /content\.jwplatform\.com/i,
    /\.(brightcove|kaltura|wistia)\.com\/.*\.(mp4|ts|m3u8)/i,
  ];

  // Parâmetros de URL que indicam arquivo TS/vídeo (players externos)
  const TS_PARAM_RE = /[?&](type|format|container|ext)=(ts|mp4|video)/i;

  function isMediaUrl(url) {
    if (!url?.startsWith("http")) return false;
    if (url.includes("127.0.0.1") || url.includes("localhost")) return false;
    if (url.includes("googlevideo.com")) return false;
    const path = url.split("?")[0];
    // Descartar segmentos DASH .m4s sempre
    if (M4S_RE.test(path)) return false;
    // Descartar segmentos HLS explícitos (padrão sequencial)
    if (SEG_RE.test(url)) return false;
    // Aceitar por extensão conhecida
    if (EXT_RE.test(path)) return true;
    // Aceitar por CDN conhecido
    if (CDN_RE.some(r => r.test(url))) return true;
    // Aceitar por parâmetro indicando formato de vídeo
    if (TS_PARAM_RE.test(url)) return true;
    return false;
  }

  function classifyUrl(url) {
    const p   = url.split("?")[0].toLowerCase();
    const res = guessRes(url);

    if (p.endsWith(".m3u8"))  return { type: "hls",   label: "HLS Stream" };
    if (p.endsWith(".mpd"))   return { type: "dash",  label: "DASH Stream" };

    // .ts — distinguir arquivo completo de segmento HLS
    if (p.endsWith(".ts")) {
      // Segmento: URL tem padrão sequencial explícito
      if (SEG_RE.test(url)) return { type: "hls", label: "TS Segment" };
      // Arquivo completo: sem padrão de segmento
      return { type: "video", label: res || "TS Video", muxed: true };
    }

    // .mkv — sempre arquivo completo
    if (p.endsWith(".mkv"))   return { type: "video", label: res || "MKV Video", muxed: true };
    if (p.endsWith(".mp4") || p.endsWith(".m4v"))
                              return { type: "video", label: res || "MP4 Video", muxed: true };
    if (p.endsWith(".webm"))  return { type: "video", label: res || "WebM Video", muxed: true };
    if (p.endsWith(".mov"))   return { type: "video", label: res || "MOV Video", muxed: true };
    if (p.endsWith(".avi"))   return { type: "video", label: res || "AVI Video", muxed: true };

    if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/.test(p))
                              return { type: "audio", label: "Áudio" };

    if (/vimeo/.test(url))       return { type: "video", label: res || "Vimeo",       muxed: true };
    if (/hotmart/.test(url))     return { type: "video", label: res || "Hotmart",     muxed: true };
    if (/twitch/.test(url))      return { type: "video", label: res || "Twitch",      muxed: true };
    if (/dailymotion/.test(url)) return { type: "video", label: res || "Dailymotion", muxed: true };
    if (/jwplayer|jwplatform|brightcove|kaltura|wistia/.test(url))
                                 return { type: "video", label: res || "Player",      muxed: true };
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

        // Verificar se o endereço do stream é um arquivo completo (não outra playlist)
        // Isso ocorre quando o manifest master aponta para .mp4/.ts/.mkv diretos
        // em vez de sub-playlists .m3u8 (padrão HLS BYOD ou plataformas corporativas)
        const streamPath = absUrl.split("?")[0].toLowerCase();
        const isDirectStream = /\.(mp4|mkv|ts|webm|mov|avi|m4v)$/.test(streamPath) &&
                               !SEG_RE.test(absUrl);
        if (isDirectStream) {
          const h   = stream.resolution?.height || stream.bandwidth && Math.round(Math.sqrt(stream.bandwidth / 500)) || 0;
          const res = h ? h + "p" : (stream.resolution?.width ? stream.resolution.width + "w" : "");
          emit(absUrl, {
            type:    "video",
            label:   res || stream.name || streamPath.split(".").pop().toUpperCase(),
            height:  h,
            bitrate: stream.bandwidth || 0,
            muxed:   true,  // arquivo completo
          });
          continue; // não processar como sub-playlist HLS
        }

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
      // Media playlist simples: calcular duração e emitir com label informativo.
      let dur = result.duration;
      if (dur <= 0) {
        // Fallback: somar #EXTINF diretamente do body se o parser não acumulou
        for (const [, d] of body.matchAll(/#EXTINF:([\d.]+)/g)) dur += parseFloat(d) || 0;
      }
      const durStr   = dur > 0 ? formatDuration(dur) : "";
      const resInUrl = guessRes(manifestUrl);
      const isLive   = !body.includes("#EXT-X-ENDLIST") && (result.segments?.length || 0) > 0;
      const label    = isLive
        ? (resInUrl ? `LIVE ${resInUrl}` : "HLS Live")
        : (resInUrl ? `HLS ${resInUrl}`  : (durStr ? `HLS ${durStr}` : "HLS Stream"));

      // Se a URL é do proxy local, não emitir — a URL original será emitida
      // pelo branch que detectou os segmentos proxy no fetch interceptor
      if (!manifestUrl.includes("127.0.0.1")) {
        emit(manifestUrl, { type: "hls", label });
      }
    }
  }

  // Fallback de parsing via regex (usado se parser_m3u8.js não carregou)
  function parseLegacyM3U8(body, baseUrl) {
    // Master playlist: extrair qualidades
    let hasStreams = false;
    for (const [, w, h, u] of body.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=(\d+)x(\d+)[^\n]*\n(https?:[^\n]+)/gi)) {
      emit(u.trim(), { type: "hls", label: `${h}p`, height: +h, width: +w });
      hasStreams = true;
    }
    for (const [, u] of body.matchAll(/URI="(https?:[^"]+)"/g)) {
      if (isMediaUrl(u)) emit(u, classifyUrl(u));
    }
    // Media playlist: calcular duração e emitir o manifest
    if (!hasStreams && !baseUrl.includes("127.0.0.1")) {
      let dur = 0;
      for (const [, d] of body.matchAll(/#EXTINF:([\d.]+)/g)) dur += parseFloat(d) || 0;
      const durStr = dur > 0 ? formatDuration(dur) : "";
      const isLive = !body.includes("#EXT-X-ENDLIST");
      const label  = isLive ? "HLS Live" : (durStr ? `HLS ${durStr}` : "HLS Stream");
      emit(baseUrl, { type: "hls", label });
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

  // Padrões da API interna do TikTok — endpoints que retornam dados de vídeo
  const TIKTOK_API_RE = /\/api\/(post\/item_list|item\/detail|recommend\/item_list|feed|aweme\/v[12]\/feed)/i;

  // Parsear resposta JSON da API TikTok e emitir mídias encontradas
  function parseTikTokApiResponse(json) {
    try {
      // Normalizar: tanto itemList quanto aweme_list
      const items = json.itemList || json.aweme_list || json.item_list || [];
      for (const item of items) {
        const v = item.video || item.aweme_info?.video;
        if (!v) continue;
        // Título: preferir desc do item
        const title = item.desc || item.aweme_info?.desc || getTikTokTitle() || "";
        const urls = [
          v.downloadAddr || v.download_addr?.url_list?.[0],
          v.playAddr     || v.play_addr?.url_list?.[0],
          ...(v.bitrateInfo || v.bit_rate || []).map(b =>
            b.PlayAddr?.UrlList?.[0] || b.play_addr?.url_list?.[0]
          ).filter(Boolean)
        ].filter(u => u?.startsWith("http"));

        // Extrair videoId do item (aweme_id ou id do item)
        const videoId = String(item.aweme_id || item.aweme_info?.aweme_id ||
                                item.id || "");

        urls.forEach((url, i) => {
          emit(url, {
            type:     "video",
            label:    i === 0 ? "Original" : `Qualidade ${i + 1}`,
            title,
            site:     "tiktok",
            __videoId: videoId  // usado pelo filtro do content.js
          });
        });
      }
    } catch (_) {}
  }

  // fetch

  // extractProxyOriginalUrl — tenta extrair a URL original de uma URL do proxy local.
  // O proxy Go serve manifests em http://127.0.0.1:PORT/JOBID/FILE.m3u8.
  // Retorna null se não for URL do proxy.
  function extractProxyOriginalUrl(proxyUrl) {
    if (!proxyUrl || !proxyUrl.includes("127.0.0.1")) return null;
    try {
      // Verificar mapa de jobs registrado pelo proxy no MAIN world
      const jobs = window.__idmProxyJobs;
      if (jobs) {
        const parts = new URL(proxyUrl).pathname.split("/").filter(Boolean);
        if (parts.length >= 1 && jobs[parts[0]]) return jobs[parts[0]];
      }
    } catch (_) {}
    return null;
  }

    const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "";
    try {
      url = typeof input === "string" ? input
          : input instanceof Request  ? input.url
          : String(input);
    } catch (_) {}

    // Interceptar API interna do YouTube (/youtubei/v1/player)
    // O Shorts usa este endpoint ao trocar de vídeo via scroll.
    // Contém streamingData completo com formats + adaptiveFormats.
    if (location.hostname.includes("youtube.com") && url.includes("/youtubei/v1/player")) {
      return origFetch.apply(this, arguments).then(resp => {
        if (resp.ok) {
          resp.clone().json().then(data => {
            try {
              if (!data?.streamingData) return;

              const newId  = data?.videoDetails?.videoId || "";
              const prevId = window.__idmLastYtVideoId   || "";

              const videoChanged = newId && prevId && newId !== prevId;

              if (videoChanged) {
                // Limpar MAIN (captured) e notificar ISOLATED (pageMedia)
                for (const [k] of captured) {
                  if (k.startsWith("yt:")) captured.delete(k);
                }
                // Sinalizar ao content.js para limpar pageMedia do vídeo anterior
                toContent("clearYtMedia", { prevId, newId });
              }

              if (newId) window.__idmLastYtVideoId = newId;

              // Emitir formatos da resposta WEB (inclui muxed + até 1080p adaptive)
              parseYT(data);

              // ── Fetch extra com cliente ANDROID para formatos > 1080p ─────
              // O cliente WEB retorna AVC até 1080p. Para VP9/AV01 acima de 1080p
              // (itag 271=1440p, 313=2160p VP9, 272=2160p HDR, 337=2160p AV1, 401=1440p AV1)
              // é necessário usar o cliente ANDROID, que não exige n-param nas URLs
              // (as URLs retornadas já são válidas sem transformação nsig).
              if (newId && !window.__idmHiResFetched?.[newId]) {
                window.__idmHiResFetched = window.__idmHiResFetched || {};
                window.__idmHiResFetched[newId] = true;
                setTimeout(() => {
                  origFetch.call(window,
                    "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                    {
                      method: "POST",
                      headers: {
                        "Content-Type":              "application/json",
                        "X-Youtube-Client-Name":    "3",
                        "X-Youtube-Client-Version": "17.31.35",
                      },
                      body: JSON.stringify({
                        videoId: newId,
                        context: {
                          client: {
                            clientName:        "ANDROID",
                            clientVersion:     "17.31.35",
                            androidSdkVersion: 30,
                            hl: "en", gl: "US",
                          }
                        }
                      })
                    }
                  ).then(r => r.ok ? r.json() : null).then(hiResData => {
                    if (!hiResData?.streamingData) return;
                    // Emitir apenas formatos adaptativos > 1080p e áudio
                    // (os formatos até 1080p e muxed já foram emitidos pelo WEB)
                    const hiAdaptive = (hiResData.streamingData.adaptiveFormats || [])
                      .filter(f => (f.height || 0) > 1080 || (f.mimeType || "").startsWith("audio/"));
                    if (hiAdaptive.length > 0) {
                      parseYT({
                        videoDetails:  hiResData.videoDetails,
                        streamingData: {
                          formats:         [],
                          adaptiveFormats: hiAdaptive
                        }
                      });
                    }
                  }).catch(() => {});
                }, 300);
              }

              // Fallback: se adaptiveFormats vieram vazios mas há formats muxed
              const adaptive = data.streamingData.adaptiveFormats || [];
              if (adaptive.length === 0 && (data.streamingData.formats || []).length > 0) {
                function tryFallbackYT(attempts) {
                  if (attempts <= 0) return;
                  if (_yt && (!newId || _yt?.videoDetails?.videoId === newId)) {
                    for (const [k] of captured) {
                      if (k.startsWith("yt:")) captured.delete(k);
                    }
                    parseYT(_yt);
                  } else if (attempts > 1) {
                    setTimeout(() => tryFallbackYT(attempts - 1), 600);
                  }
                }
                setTimeout(() => tryFallbackYT(3), 400);
              }

            } catch (_) {}
          }).catch(() => {});
        }
        return resp;
      });
    }

    // Interceptar API interna do TikTok (scroll infinito)
    if (location.hostname.includes("tiktok.com") && TIKTOK_API_RE.test(url)) {
      return origFetch.apply(this, arguments).then(resp => {
        if (resp.ok) {
          resp.clone().json().then(parseTikTokApiResponse).catch(() => {});
        }
        return resp;
      });
    }

    if (isMediaUrl(url)) {
      const info = classifyUrl(url);
      if ((info.type === "hls" || info.type === "dash") && !parsedManifests.has(url)) {
        parsedManifests.add(url);
        return origFetch.apply(this, arguments).then(resp => {
          if (resp.ok) {
            try {
              resp.clone().text().then(body => {
                try {
                  if (info.type === "hls") {
                    // Detectar se este é um manifest proxy (segmentos apontando para 127.0.0.1).
                    // Ocorre quando o proxy Go reescreve o m3u8 antes de servir ao player no iframe.
                    // Nesse caso, extrair a URL REAL do primeiro segmento (?u=...) para usar
                    // como base no parse, obtendo assim o CDN real e duração correta.
                    const PROXY_SEG_RE = /http:\/\/127\.0\.0\.1:[^\s\/]+\/[^\s\/]+\/s\?u=([^\s\r\n]+)/;
                    const proxySegMatch = body.match(PROXY_SEG_RE);
                    if (proxySegMatch) {
                      try {
                        const realSegUrl = decodeURIComponent(proxySegMatch[1]);
                        // Reconstituir a URL do manifest original a partir do segmento real
                        // (remover filename e query do segmento para obter base do manifest)
                        const realBase = realSegUrl.replace(/\?.*$/, "").replace(/\/[^/]*$/, "/");
                        const origManifest = extractProxyOriginalUrl(url) || url;
                        // Emitir a URL ORIGINAL do manifest (CDN real), não a do proxy
                        parseAndEmitM3U8(body, origManifest || url);
                        return;
                      } catch (_) {}
                    }
                    parseAndEmitM3U8(body, url);
                  } else {
                    parseMPD(body);
                  }
                } catch (_) {}
              }).catch(() => {});
            } catch (_) {}
          }
          return resp;
        });
      }
      // Emitir URL original (não proxy) para manifests simples
      const emitUrl = extractProxyOriginalUrl(url) || url;
      emit(emitUrl, info);
    }

    // ── Captura por Content-Type HTTP (TS/MKV/MP4 sem extensão na URL) ────
    // Players genéricos (JW embed, iframe players, CMS de vídeo) frequentemente
    // servem arquivos de mídia em URLs sem extensão. Ex:
    //   GET /api/video/stream  → Content-Type: video/mp2t  (TS)
    //   GET /media/hd          → Content-Type: video/x-matroska (MKV)
    //   GET /content/play      → Content-Type: video/mp4
    //   GET /hls/index         → Content-Type: application/vnd.apple.mpegurl (M3U8)
    // Interceptamos a resposta e verificamos o Content-Type antes de qualquer
    // tentativa de ler o body — eficiente pois não lemos bytes de vídeo.
    // Só ativa para URLs que NÃO foram já classificadas pelo isMediaUrl acima.
    if (!url.includes("127.0.0.1") && !url.includes("localhost") &&
        !url.includes("googlevideo.com") && url.startsWith("http")) {
      return origFetch.apply(this, arguments).then(resp => {
        try {
          if (!resp.ok) return resp;
          const ct = (resp.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
          if (!ct) return resp;

          if (MIME_HLS_RE.test(ct) && !parsedManifests.has(url)) {
            // HLS ou DASH manifest servido sem extensão — parsear qualidades
            parsedManifests.add(url);
            const isDash = ct.includes("dash");
            resp.clone().text().then(body => {
              try {
                if (isDash) parseMPD(body);
                else        parseAndEmitM3U8(body, url);
              } catch (_) {}
            }).catch(() => {});
            // Emitir o manifest em si como fallback se parsing não encontrar streams
            emit(url, { type: isDash ? "dash" : "hls", label: isDash ? "DASH Stream" : "HLS Stream" });
          } else if (MIME_VIDEO_RE.test(ct)) {
            // Vídeo/áudio real (TS, MKV, MP4, etc.) servido sem extensão na URL
            // Não emitir se já foi capturado pelo isMediaUrl (extensão na URL)
            if (!isMediaUrl(url)) {
              const mimeBase = ct.split(";")[0].trim();
              const ext  = MIME_TO_EXT[mimeBase] || "";
              const isAudio = ct.startsWith("audio/");
              const res  = guessRes(url);
              // Montar label a partir da extensão real + resolução detectada
              const label = res ? `${res} (${ext || mimeBase})` : (ext ? ext.toUpperCase() : (isAudio ? "Áudio" : "Vídeo"));
              emit(url, {
                type:   isAudio ? "audio" : "video",
                label,
                muxed:  true,
                mime:   ct,
                site:   detectSiteFromUrl(url)
              });
            }
          }
        } catch (_) {}
        return resp;
      });
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

      // Detectar M3U8 pelo CONTEÚDO da resposta (não só pela URL)
      // e também analisar respostas JSON em busca de URLs de mídia
      this.addEventListener("readystatechange", function() {
        if (this.readyState !== 4) return;
        try {
          const resp = this.responseText;
          if (!resp) return;

          // M3U8 pelo conteúdo (sem extensão na URL)
          if ((resp.startsWith("#EXTM3U") ||
               resp.startsWith("data:application/vnd.apple.mpegurl;base64,")) &&
              !parsedManifests.has(this.__idmUrl)) {
            parsedManifests.add(this.__idmUrl);
            parseAndEmitM3U8(resp, this.__idmUrl);
            return;
          }

          // Verificar Content-Type do XHR para capturar TS/MKV sem extensão
          try {
            const ct = this.getResponseHeader?.("content-type") || "";
            if (ct && !isMediaUrl(this.__idmUrl)) {
              if (ct.includes("video/mp2t"))       emit(this.__idmUrl, { type: "video", label: "TS Video",  muxed: true });
              else if (ct.includes("x-matroska"))  emit(this.__idmUrl, { type: "video", label: "MKV Video", muxed: true });
              else if (ct.includes("video/mp4"))   emit(this.__idmUrl, { type: "video", label: "MP4 Video", muxed: true });
              else if (ct.includes("video/webm"))  emit(this.__idmUrl, { type: "video", label: "WebM",      muxed: true });
            }
          } catch (_) {}
        } catch (_) {}
      });
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

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 8a — Varredura de globals do window (herança direta do FC)
  //
  // O File Centipede usa esta técnica para capturar JW Player e outros:
  //   1. Criar um iframe oculto para obter a lista de globals NATIVOS
  //   2. Diff: globals do window - globals do iframe = adicionados pelo site
  //   3. Varrer esses globals custom com analyzeJsonObject
  //
  // Por que funciona para JW Player:
  //   - Após o load, window.jwplayer, window._jw, window.jwDefaults
  //     e outros objetos de configuração do JW estão expostos como globals
  //   - analyzeJsonObject já sabe extrair URLs com metadados desses objetos
  //   - Funciona para QUALQUER player que exponha config via window global
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 8b — Players externos via globals (JWPlayer, Brightcove,
  //                Kaltura, VideoJS, Plyr, Wistia, DailyMotion SDK)
  //
  // Inspirado no File Centipede content_injected.js:
  // Poleia globals conhecidos de players comerciais e extrai as URLs
  // de todas as qualidades disponíveis.
  //
  // Por que esta estratégia é necessária além do JSON.parse monkey-patch:
  //   - JWPlayer e Brightcove carregam o player via script externo e
  //     configuram via API JS após o load. O JSON.parse do config pode
  //     estar em cache (não passar pelo monkey-patch) ou ser passado
  //     como objeto literal (não serializado).
  //   - A API jwplayer().getPlaylist() expõe as qualidades *após* o
  //     setup, que é quando esta estratégia age (DOMContentLoaded).
  //   - Brightcove usa videojs internamente — podemos ler de videojs.players.
  //   - Kaltura expõe kWidget e o player via window.kWidget.
  //
  // A injeção em iframes (background.js webNavigation.onCommitted) garante
  // que este código rode no contexto do iframe, onde os globals existem.
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers para normalizar sources de players externos
  // ─────────────────────────────────────────────────────────────────────────

  // Normalizar URL de source: tratar // relativo, tokens opcionais, etc.
  function normalizeSourceUrl(raw) {
    if (!raw) return "";
    let url = raw.trim();
    if (url.startsWith("//")) url = location.protocol + url;
    if (!url.startsWith("http")) return "";
    return url;
  }

  // Classificar um source de player externo e emitir com prioridade correta.
  // Prioridade: arquivo direto (mp4/ts/mkv/webm) > HLS > DASH
  // Retorna true se emitiu arquivo direto (para skip do HLS depois)
  function emitExternalSource(rawUrl, meta) {
    const url = normalizeSourceUrl(rawUrl);
    if (!url) return false;

    const pl = url.split("?")[0].toLowerCase();
    const isHLS  = pl.endsWith(".m3u8") || (meta.type || "").includes("m3u8");
    const isDASH = pl.endsWith(".mpd")  || (meta.type || "").includes("mpd");
    const isAudio = /\.(mp3|m4a|aac|ogg|opus|flac)$/.test(pl) || (meta.type||"").startsWith("audio");
    const isTS    = pl.endsWith(".ts");
    const isMKV   = pl.endsWith(".mkv");
    const isDirect = !isHLS && !isDASH && (
      pl.endsWith(".mp4") || pl.endsWith(".webm") || pl.endsWith(".mov") ||
      isTS || isMKV || pl.endsWith(".avi") || pl.endsWith(".m4v") || isAudio
    );

    if (isDirect || (!isHLS && !isDASH && meta.type && !meta.type.includes("m3u8"))) {
      // Arquivo completo — emitir como vídeo/áudio diretamente
      const height = meta.height || parseInt((meta.label||"").match(/(\d{3,4})/)?.[1]||"0");
      const ext    = pl.split(".").pop().toUpperCase();
      const label  = meta.label || (height > 0 ? height + "p" : (isAudio ? "Áudio" : ext || "Vídeo"));
      emit(url, {
        type:    isAudio ? "audio" : "video",
        label,   height,
        bitrate: meta.bitrate || 0,
        mime:    meta.type    || "",
        muxed:   true,   // arquivo direto = vídeo+áudio juntos
        title:   meta.title || document.title,
        site:    meta.site  || "player"
      });
      return true; // é arquivo direto
    }

    // HLS: emitir e parsear o manifest para extrair qualidades reais
    if (isHLS && !parsedManifests.has(url)) {
      parsedManifests.add(url);
      emit(url, {
        type:  "hls",
        label: meta.label || "HLS Stream",
        title: meta.title || document.title,
        site:  meta.site  || "player"
      });
      // Buscar e parsear o manifest para obter qualidades individuais
      // (pode conter qualidades em .ts, .mp4, etc.)
      fetch(url, { credentials: "include" })
        .then(r => r.text())
        .then(body => parseAndEmitM3U8(body, url))
        .catch(() => {});
    }

    // DASH
    if (isDASH) {
      emit(url, {
        type:  "dash",
        label: meta.label || "DASH Stream",
        title: meta.title || document.title,
        site:  meta.site  || "player"
      });
    }

    return false; // não é arquivo direto
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Processar um item de playlist JW (ou VideoJS, Wistia, etc.)
  // Lógica unificada usada tanto no probe quanto nos event listeners.
  // ─────────────────────────────────────────────────────────────────────────

  // Classificar uma source pela URL e tipo MIME
  function classifySource(url, mimeType) {
    const p = url.split("?")[0].toLowerCase();
    if (p.endsWith(".m3u8") || (mimeType||"").includes("m3u8") ||
        (mimeType||"").includes("application/vnd.apple.mpegurl")) return "hls";
    if (p.endsWith(".mpd")  || (mimeType||"").includes("mpd")) return "dash";
    if (p.endsWith(".ts"))   return "ts";     // arquivo TS (pode ser completo ou segmento)
    if (p.endsWith(".mkv"))  return "mkv";
    if (p.endsWith(".mp4") || p.endsWith(".m4v")) return "mp4";
    if (p.endsWith(".webm")) return "webm";
    if (p.endsWith(".mov"))  return "mov";
    if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/.test(p)) return "audio";
    if ((mimeType||"").startsWith("video")) return "mp4";
    if ((mimeType||"").startsWith("audio")) return "audio";
    return "unknown";
  }

  function isDirectFile(kind) {
    return ["mp4","mkv","ts","webm","mov","audio"].includes(kind);
  }

  function processPlaylistItem(item, playerTitle, site) {
    const sources = item.sources || item.tracks || [];
    const title   = item.title || item.description || playerTitle || document.title;

    // Coletar todas as sources normalizadas
    const all = [];
    for (const s of sources) {
      const url = normalizeSourceUrl(s.file || s.src || s.url || "");
      if (!url) continue;
      const kind = classifySource(url, s.type || "");
      all.push({
        url, kind,
        type:    s.type    || "",
        label:   s.label   || s.res   || "",
        height:  s.height  || s.resolution || parseInt((s.label||"").match(/(\d{3,4})/)?.[1]||"0"),
        bitrate: s.bitrate || s.bandwidth  || 0,
        title, site
      });
    }

    // item.file de nível superior (quando sources está vazio)
    if (!all.length && (item.file || item.src)) {
      const url = normalizeSourceUrl(item.file || item.src || "");
      if (url) {
        const kind = classifySource(url, item.type || "");
        all.push({ url, kind, type: item.type || "", label: "", height: 0, bitrate: 0, title, site });
      }
    }

    if (!all.length) return;

    const directs   = all.filter(s => isDirectFile(s.kind));
    const manifests = all.filter(s => s.kind === "hls" || s.kind === "dash");

    // Emitir arquivos diretos (mp4, ts, mkv, webm, mov) primeiro — prioridade máxima
    directs.forEach(s => {
      const ext   = s.kind.toUpperCase();
      const label = s.label || (s.height > 0 ? `${s.height}p` : ext);
      emit(s.url, {
        type:    s.kind === "audio" ? "audio" : "video",
        label,   height: s.height, bitrate: s.bitrate,
        mime:    s.type, muxed: true,
        title:   s.title, site: s.site
      });
    });

    // Manifests: emitir e parsear para extrair qualidades reais
    // Sempre emitir manifests (mesmo quando há direto) — o usuário pode
    // querer o HLS de maior qualidade que o direto disponível
    for (const s of manifests) {
      const url = s.url;
      if (s.kind === "hls" && !parsedManifests.has(url)) {
        parsedManifests.add(url);
        emit(url, { type: "hls", label: s.label || "HLS Stream", title: s.title, site: s.site });
        // Parsear manifest para extrair qualidades individuais
        // Se o manifest retornar streams com .ts/.mp4, serão emitidos como vídeo diretamente
        fetch(url, { credentials: "include" })
          .then(r => r.ok ? r.text() : "")
          .then(body => { if (body) parseAndEmitM3U8(body, url); })
          .catch(() => {});
      }
      if (s.kind === "dash") {
        emit(url, { type: "dash", label: s.label || "DASH Stream", title: s.title, site: s.site });
      }
    }
  }

  function probeExternalPlayers() {
    // ── JWPlayer ──────────────────────────────────────────────────────────
    try {
      if (typeof window.jwplayer === "function") {
        const processJWPlayer = (jw) => {
          if (!jw || typeof jw.getPlaylist !== "function") return;

          const cfg   = typeof jw.getConfig === "function" ? (jw.getConfig() || {}) : {};
          const title = cfg.title || document.title;

          // Processar todos os itens da playlist
          (jw.getPlaylist() || []).forEach(item => processPlaylistItem(item, title, "jwplayer"));

          // getQualityLevels: qualidades do stream corrente (JW8+)
          // Retorna URLs diretas quando o player usa fontes MP4 multi-bitrate
          try {
            const levels = jw.getQualityLevels?.() || [];
            levels.forEach(q => {
              const url = normalizeSourceUrl(q.file || "");
              if (url) emitExternalSource(url, {
                label: q.label || (q.height ? q.height + "p" : ""),
                height: q.height || 0, bitrate: q.bitrate || 0,
                title, site: "jwplayer"
              });
            });
          } catch (_) {}
        };

        // Extrair sources das camadas internas do JW (além de getPlaylist)
        const extractJWDeep = (jw) => {
          if (!jw) return;

          // Camada B: getConfig().sources (sources resolvidas após ready)
          try {
            const cfg = jw.getConfig?.() || {};
            const cfgSources = cfg.sources || cfg.playlist?.[0]?.sources || [];
            if (cfgSources.length > 0) {
              processPlaylistItem(
                { sources: cfgSources, title: cfg.title },
                cfg.title || document.title,
                "jwplayer"
              );
            }
          } catch (_) {}

          // Camada B2: getPlaylistItem() — item atual com sources resolvidas
          try {
            const item = jw.getPlaylistItem?.();
            if (item) processPlaylistItem(item, document.title, "jwplayer");
          } catch (_) {}

          // Camada C: getQualityLevels() — quando o player está em modo multi-bitrate MP4
          // Cada level pode ter .file (URL direta) quando são arquivos MP4 distintos
          try {
            const levels = jw.getQualityLevels?.() || [];
            const title  = jw.getConfig?.()?.title || document.title;
            levels.forEach(q => {
              const url = normalizeSourceUrl(q.file || q.url || "");
              if (!url) return;
              const kind = classifySource(url, q.type || "");
              if (isDirectFile(kind)) {
                const label = q.label || (q.height ? q.height + "p" : "JW");
                emit(url, {
                  type: "video", label,
                  height: q.height || 0, bitrate: q.bitrate || 0,
                  muxed: true, title, site: "jwplayer"
                });
              }
            });
          } catch (_) {}

          // Camada D: estado interno não documentado
          // window.jwplayer._players contém instâncias com _model._attributes.sources
          try {
            const players = window.jwplayer._players || {};
            Object.values(players).forEach(p => {
              try {
                const attrs   = p._model?._attributes || p._model?.attributes || {};
                const sources = attrs.sources || attrs.playlist?.[0]?.sources || [];
                if (sources.length > 0) {
                  processPlaylistItem({ sources, title: attrs.title }, attrs.title || document.title, "jwplayer");
                }
              } catch (_) {}
            });
          } catch (_) {}
        };

        // Probe imediato
        processJWPlayer(window.jwplayer());
        extractJWDeep(window.jwplayer());

        // Registrar listeners para quando o JW terminar o setup ou mudar de item
        try {
          const jw = window.jwplayer();
          if (jw && typeof jw.on === "function" && !jw.__idmListening) {
            jw.__idmListening = true;

            // "ready": player inicializado — sources definitivas disponíveis
            jw.on("ready", () => {
              processJWPlayer(window.jwplayer());
              setTimeout(() => extractJWDeep(window.jwplayer()), 300);
            });

            // "firstFrame": primeiro frame exibido — player resolveu tokens e URLs
            // Este é o melhor momento para obter sources reais (após autenticação)
            jw.on("firstFrame", () => {
              setTimeout(() => extractJWDeep(window.jwplayer()), 100);
            });

            // "playlistItem": novo item carregado — sources mudam
            jw.on("playlistItem", () => {
              setTimeout(() => {
                processJWPlayer(window.jwplayer());
                extractJWDeep(window.jwplayer());
              }, 200);
            });

            // "levelsChanged": player detectou qualidades disponíveis
            jw.on("levelsChanged", () => {
              setTimeout(() => extractJWDeep(window.jwplayer()), 100);
            });
          }
        } catch (_) {}

        // getAllPlayers: processar todos os players (JW8+)
        if (typeof window.jwplayer.getAllPlayers === "function") {
          window.jwplayer.getAllPlayers().forEach(p => {
            try {
              processJWPlayer(p);
              extractJWDeep(p);
              if (p && typeof p.on === "function" && !p.__idmListening) {
                p.__idmListening = true;
                p.on("ready",        () => { processJWPlayer(p); setTimeout(() => extractJWDeep(p), 300); });
                p.on("firstFrame",   () => setTimeout(() => extractJWDeep(p), 100));
                p.on("playlistItem", () => setTimeout(() => { processJWPlayer(p); extractJWDeep(p); }, 200));
                p.on("levelsChanged",() => setTimeout(() => extractJWDeep(p), 100));
              }
            } catch (_) {}
          });
        }
      }
    } catch (_) {}

    // ── VideoJS (usado pelo Brightcove, Udemy, etc.) ───────────────────
    // videojs.players é um objeto chaveado por ID de player
    try {
      if (window.videojs && window.videojs.players) {
        Object.values(window.videojs.players).forEach(player => {
          if (!player) return;
          try {
            // player.src() retorna a source atual
            const src = player.src();
            if (src && typeof src === "string" && src.startsWith("http")) {
              emit(src, { type: typeFromPath(src), label: "VideoJS", site: "videojs" });
            }
            // player.currentSources() retorna todas as sources configuradas
            const sources = typeof player.currentSources === "function"
              ? (player.currentSources() || [])
              : [];
            sources.forEach(s => {
              if (s.src?.startsWith("http")) {
                emit(s.src, { type: typeFromPath(s.src), label: s.label || "VideoJS", site: "videojs" });
              }
            });
          } catch (_) {}
        });
      }
    } catch (_) {}

    // ── Wistia ────────────────────────────────────────────────────────
    // window.wistiaEmbeds ou window._wq (queue de players)
    try {
      if (window.Wistia) {
        const players = window.Wistia._E?.players || {};
        Object.values(players).forEach(player => {
          try {
            const assets = player.data?.media?.assets || [];
            assets.forEach(a => {
              if (!a.url?.startsWith("http")) return;
              const height = a.height || 0;
              const label  = height > 0 ? height + "p" : (a.type || "Wistia");
              emit(a.url, { type: typeFromPath(a.url), label, height, site: "wistia" });
            });
          } catch (_) {}
        });
      }
    } catch (_) {}

    // ── Dailymotion SDK ───────────────────────────────────────────────
    try {
      if (window.DM?.player) {
        const state = window.DM.player.getState?.();
        if (state?.video?.stream_h264_url) {
          emit(state.video.stream_h264_url, { type: "video", label: "DM HD", site: "dailymotion" });
        }
      }
    } catch (_) {}

    // ── Kaltura ───────────────────────────────────────────────────────
    // kWidget.embed() → player exposto em window.kWidget
    // kdp.sendNotification() e kdp.evaluate() permitem ler a URL
    try {
      if (window.kWidget) {
        // Tentar via kWidget.addReadyCallback ou via players já criados
        const players = window.kWidget.players || {};
        Object.values(players).forEach(player => {
          try {
            const src = player.evaluate?.("{mediaProxy.entry.dataUrl}");
            if (src?.startsWith("http")) {
              emit(src, { type: "video", label: "Kaltura", site: "kaltura" });
            }
            // Tentar via getSources (Kaltura HTML5 v2)
            const sources = player.sources || player.mediaElement?.getSources?.() || [];
            sources.forEach(s => {
              const u = s.src || s.url || s.file;
              if (u?.startsWith("http")) {
                emit(u, { type: typeFromPath(u), label: s.label || "Kaltura", site: "kaltura" });
              }
            });
          } catch (_) {}
        });
      }
    } catch (_) {}

    // ── Brightcove standalone ─────────────────────────────────────────
    // Brightcove usa videojs internamente — coberto acima.
    // Mas também expõe window.bc (Brightcove Player API v6+)
    try {
      if (window.bc) {
        const players = document.querySelectorAll("video-js[data-video-id], .vjs-tech");
        players.forEach(el => {
          const player = window.videojs?.getPlayer?.(el.id);
          if (!player) return;
          try {
            const src = player.src();
            if (src?.startsWith("http")) {
              emit(src, { type: typeFromPath(src), label: "Brightcove", site: "brightcove" });
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
  }
    // ── Hls.js (biblioteca usada por muitos players genéricos) ────────
    // Hls.js expõe window.Hls e instâncias ficam em hls.url / hls.levels
    // Muitos CMS de vídeo (Mux, Cloudflare Stream, etc.) usam Hls.js.
    try {
      if (typeof window.Hls === "function" && window.Hls.instances) {
        window.Hls.instances.forEach(hls => {
          try {
            const url = hls.url;
            if (url?.startsWith("http")) {
              // url é o manifest master → parsear para extrair qualidades
              if (!parsedManifests.has(url)) {
                parsedManifests.add(url);
                origFetch.call(window, url).then(r => r.text()).then(body => {
                  try { parseAndEmitM3U8(body, url); } catch (_) {}
                }).catch(() => {
                  emit(url, { type: "hls", label: "HLS Stream", site: "hlsjs" });
                });
              } else {
                emit(url, { type: "hls", label: "HLS Stream", site: "hlsjs" });
              }
            }
            // Levels = qualidades disponíveis no manifest já parseado pelo Hls.js
            const levels = hls.levels || [];
            levels.forEach((lv, i) => {
              const lvUrl = lv.url?.[0] || lv.uri;
              if (!lvUrl?.startsWith("http")) return;
              const h     = lv.height || lv.attrs?.RESOLUTION?.split("x")[1] || 0;
              const label = h ? `${h}p` : (lv.name || `Quality ${i + 1}`);
              emit(lvUrl, { type: "hls", label, height: +h || 0, bandwidth: lv.bitrate || 0, site: "hlsjs" });
            });
          } catch (_) {}
        });
      }
    } catch (_) {}

    // ── dash.js (DASH streaming library) ─────────────────────────────
    // window.dashjs expõe MediaPlayer instances via dashjs.MediaPlayer().create()
    // Instâncias ativas ficam em window.__dashjs_instances__ (convenção) ou
    // podemos inspecionar via dashjs.debug
    try {
      // Tentar via globals injetados por alguns players
      const dashInstances = window.__dashjs_instances__ || [];
      dashInstances.forEach(player => {
        try {
          const src = player.getSource?.();
          if (src?.startsWith("http")) {
            emit(src, { type: "dash", label: "DASH Stream", site: "dashjs" });
          }
          // Bitrate list
          const bitrates = player.getBitrateInfoListFor?.("video") || [];
          bitrates.forEach(b => {
            const h     = b.height || 0;
            const label = h ? `${h}p` : `${Math.round((b.bitrate || 0) / 1000)}kbps`;
            // dash.js não expõe URLs individuais por qualidade — só o manifest
            // Emitir apenas o manifest uma vez (já feito acima)
            void label;
          });
        } catch (_) {}
      });
    } catch (_) {}

    // ── Flowplayer ────────────────────────────────────────────────────
    // Flowplayer expõe window.flowplayer e instâncias via flowplayer.instances
    try {
      if (window.flowplayer) {
        const instances = window.flowplayer.instances || [];
        instances.forEach(fp => {
          try {
            const src = fp.video?.src || fp.opts?.src;
            if (src?.startsWith("http")) {
              const t = typeFromPath(src);
              emit(src, { type: t, label: t === "hls" ? "Flowplayer HLS" : "Flowplayer", site: "flowplayer" });
            }
            // Multiple sources (qualidades)
            const sources = fp.video?.sources || fp.opts?.sources || [];
            sources.forEach(s => {
              const u = s.src || s.file || s.url;
              if (!u?.startsWith("http")) return;
              const t = typeFromPath(u);
              const h = s.height || parseInt((s.label || "").match(/(\d{3,4})/)?.[1] || "0");
              emit(u, { type: t, label: s.label || (h ? h + "p" : "Flowplayer"), height: h, site: "flowplayer" });
            });
          } catch (_) {}
        });
      }
    } catch (_) {}

    // ── Plyr ──────────────────────────────────────────────────────────
    // window.Plyr — instâncias ficam em elementos <video> com .__plyr
    try {
      document.querySelectorAll("video[id], video[class]").forEach(el => {
        const plyr = el.__plyr || el._plyr;
        if (!plyr) return;
        try {
          const src = plyr.source?.sources?.[0]?.src || plyr.media?.currentSrc;
          if (src?.startsWith("http")) {
            const t = typeFromPath(src);
            emit(src, { type: t, label: t === "hls" ? "Plyr HLS" : "Plyr", site: "plyr" });
          }
          // Todas as sources configuradas
          const sources = plyr.source?.sources || [];
          sources.forEach(s => {
            if (!s.src?.startsWith("http")) return;
            const t = typeFromPath(s.src);
            emit(s.src, { type: t, label: s.label || s.size ? `${s.size}p` : "Plyr", site: "plyr" });
          });
        } catch (_) {}
      });
    } catch (_) {}



  // Auxiliar para probeExternalPlayers
  function typeFromPath(url) {
    const p = (url || "").split("?")[0].toLowerCase();
    if (p.includes(".m3u8")) return "hls";
    if (p.includes(".mpd"))  return "dash";
    if (/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/.test(p)) return "audio";
    return "video";
  }


  // Extrair título real do vídeo TikTok a partir do DOM.
  // TikTok não atualiza document.title com o título do vídeo.
  // O título está no atributo alt da thumbnail do player ativo,
  // ou em elementos de descrição específicos do TikTok.
  function getTikTokTitle() {
    // Seletores em ordem de confiabilidade:

    // 1. Thumbnail do player ativo: <picture><img alt="TITULO"></picture>
    //    O player principal do TikTok sempre tem uma <picture> com img alt.
    const playerImgs = document.querySelectorAll(
      '[class*="DivVideoContainer"] picture img[alt],' +
      '[class*="video-player"] picture img[alt],' +
      '[class*="VideoPlayer"] picture img[alt],' +
      'xg-video-container picture img[alt],' +
      '[data-e2e="video-player"] picture img[alt],' +
      // Seletor mais amplo: qualquer picture>img com alt dentro de um container de vídeo
      'video ~ * picture img[alt],' +
      'video + picture img[alt]'
    );
    for (const img of playerImgs) {
      const alt = img.getAttribute("alt");
      if (alt && alt.length > 3 && !alt.toLowerCase().includes("tiktok")) {
        return alt;
      }
    }

    // 2. Descrição do vídeo (modo web desktop)
    const desc = document.querySelector(
      '[data-e2e="browse-video-desc"],' +
      '[data-e2e="video-desc"],' +
      '[class*="SpanUniqueId"],' +
      'h1[class*="tiktok"],' +
      '[class*="DivDesc"] span'
    );
    if (desc?.textContent?.trim()) return desc.textContent.trim();

    // 3. __NEXT_DATA__ (primeira carga da página)
    try {
      const nd = window.__NEXT_DATA__?.props?.pageProps;
      const d  = nd?.itemInfo?.itemStruct?.desc ||
                 nd?.videoData?.itemInfos?.text;
      if (d) return d;
    } catch (_) {}

    // 4. SIGI_STATE (estrutura alternativa do TikTok)
    try {
      const ss = window.__SIGI_STATE__?.ItemModule;
      if (ss) {
        const first = Object.values(ss)[0];
        if (first?.desc) return first.desc;
      }
    } catch (_) {}

    return "";
  }

  // ── TikTok ────────────────────────────────────────────────────────────
  // Captura mídias TikTok via __NEXT_DATA__ / __SIGI_STATE__ e via
  // intercepção de fetch (estratégia 4 captura chamadas à API interna).
  // O título usa getTikTokTitle() que lê o DOM do player, não document.title.

  function probeTikTok() {
    const isTikTok = location.hostname.includes("tiktok.com");
    if (!isTikTok) return;

    const title = getTikTokTitle();

    // Via __NEXT_DATA__ (primeira carga)
    try {
      const videoData = window.__NEXT_DATA__?.props?.pageProps?.itemInfo?.itemStruct?.video;
      if (videoData) {
        const urls = [
          videoData.downloadAddr,
          videoData.playAddr,
          ...(videoData.bitrateInfo || []).map(b => b.PlayAddr?.UrlList?.[0]).filter(Boolean)
        ].filter(u => u?.startsWith("http"));
        const itemId = String(
          window.__NEXT_DATA__?.props?.pageProps?.itemInfo?.itemStruct?.id || ""
        );
        urls.forEach((url, i) => {
          emit(url, {
            type:      "video",
            label:     i === 0 ? "Original" : `Qualidade ${i}`,
            title:     title || undefined,
            site:      "tiktok",
            __videoId: itemId
          });
        });
      }
    } catch (_) {}

    // Via __SIGI_STATE__ (estrutura alternativa)
    try {
      const itemModule = window.__SIGI_STATE__?.ItemModule;
      if (itemModule) {
        Object.values(itemModule).forEach(item => {
          const v = item?.video;
          if (!v) return;
          const itemTitle = item.desc || title || "";
          const urls = [v.downloadAddr, v.playAddr,
            ...(v.bitrateInfo || []).map(b => b.PlayAddr?.UrlList?.[0]).filter(Boolean)
          ].filter(u => u?.startsWith("http"));
          const sigiId = String(item.id || item.aweme_id || "");
          urls.forEach(url => {
            emit(url, {
              type: "video", label: "TikTok", title: itemTitle,
              site: "tiktok", __videoId: sigiId
            });
          });
        });
      }
    } catch (_) {}
  }

  probeTikTok();

  // Disparar em vários momentos — players completam setup em momentos distintos
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(probeExternalPlayers, 500);
    setTimeout(probeExternalPlayers, 1500);
  });
  window.addEventListener("load", () => {
    setTimeout(probeExternalPlayers, 1000);
    setTimeout(probeExternalPlayers, 3000);
    // Varredura de globals após load — APENAS no frame principal.
    // Globals de configuração de player (jwplayer, videojs, bc, etc.)
    // são expostos em window.top — iframes de tracking/ads/embeds não
    // costumam conter essa informação, mas cada um deles dispara seu
    // próprio evento "load" e, sem essa guarda, executava
    // scanWindowGlobals() independentemente (ver nota abaixo sobre o
    // guard __idmGlobalsScanned ser por-frame).
    if (window === window.top) {
      setTimeout(scanWindowGlobals, 200);
    }
  });
  setTimeout(probeExternalPlayers, 4000);

  if (window !== window.top) {
    setTimeout(probeExternalPlayers, 200);
    setTimeout(probeExternalPlayers, 800);
    setTimeout(probeExternalPlayers, 2000);
    // scanWindowGlobals NÃO é chamada em iframes — ver guard acima
    // (window === window.top). Em páginas com dezenas de iframes
    // (TikTok: ads, analytics, embeds de terceiros), cada "load" de
    // iframe disparava scanWindowGlobals, que criava um <iframe>
    // descartável para detectar globals nativos — cada criação de
    // iframe reavalia a CSP da página e gera o aviso
    // "upgrade-insecure-requests is ignored when delivered in a
    // report-only policy", repetido uma vez por iframe.
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 10 — Varredura de globals de window (método do File Centipede)
  //
  // Detecta globals criados pelo site/player comparando window com um iframe
  // virgem. Os globals "extras" são exatamente os objetos criados pelo player
  // (jwplayer, videojs, bc, kWidget, etc.) e qualquer SDK de terceiro.
  //
  // Vantagem crítica sobre probeExternalPlayers:
  //   - Não depende de saber o nome do player antecipadamente
  //   - Captura QUALQUER player que exponha dados em globals de window
  //   - Captura configs em cache que nunca passaram por fetch/XHR
  //   - Funciona para JW Player quando a config foi inline (sem request)
  // ─────────────────────────────────────────────────────────────────────────

  // Guard de execução única por documento. Antes, scanWindowGlobals podia
  // ser chamada até 5x pela mesma página (load 600/2500ms da estratégia
  // 8b removida, load 200ms da estratégia 10, e load 100ms do iframe) —
  // cada execução cria/remove um <iframe> e percorre recursivamente
  // (profundidade 10) TODOS os globals de window. Em sites com muitos
  // SDKs/iframes (TikTok), isso causava o aviso de CSP repetido
  // (cada <iframe> criado herda/avalia a CSP da página) e travamentos
  // perceptíveis na thread principal.
  let __idmGlobalsScanned = false;

  function scanWindowGlobals() {
    if (__idmGlobalsScanned) return;
    __idmGlobalsScanned = true;

    try {
      if (!WeakSet) return;

      // nativeGlobals: snapshot capturado em document_start (topo do
      // arquivo), antes do site adicionar seus próprios globals.
      // Substitui o antigo método de criar/remover um <iframe> — ver
      // comentário em __idmNativeGlobals.
      const nativeGlobals = __idmNativeGlobals;

      // Globals presentes em window mas NÃO no snapshot inicial
      // = globals criados pelo site/player durante o carregamento da página
      const siteGlobals = Object.getOwnPropertyNames(window).filter(
        k => !nativeGlobals.has(k)
      );

      const visited = new WeakSet();

      // Orçamento de tempo: abortar a varredura se ultrapassar 50ms
      // acumulados. Sites com centenas de globals (TikTok, páginas com
      // muitos SDKs de analytics/ads) podiam levar a varredura recursiva
      // (profundidade 10) a consumir vários ms de thread principal por
      // global — multiplicado por centenas de globals, isso é perceptível.
      // 50ms é suficiente para capturar configs de player típicas (que
      // ficam nos primeiros globals customizados) sem bloquear a página.
      const deadline = (typeof performance !== "undefined" ? performance.now() : Date.now()) + 50;
      const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

      for (const key of siteGlobals) {
        if (now() > deadline) break;

        let val;
        try { val = window[key]; } catch (_) { continue; }
        if (!val || val === window || val === document) continue;

        // Pular strings longas, funções puras sem props interessantes
        if (typeof val === "string")   continue;
        if (typeof val === "number")   continue;
        if (typeof val === "boolean")  continue;

        // Analisar objeto/array recursivamente com o analisador heurístico
        try {
          analyzeGlobalObject(val, 0, visited);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Versão especializada do analyzeJsonObject para globals:
  // Mais agressiva em profundidade (10 vs 8) porque globals de players
  // têm estrutura mais aninhada (jwplayer().getPlaylist()[0].sources[0].file)
  function analyzeGlobalObject(obj, depth, visited) {
    if (depth > 10) return;
    if (!obj || typeof obj !== "object") return;
    try { if (visited.has(obj)) return; visited.add(obj); } catch (_) { return; }

    if (Array.isArray(obj)) {
      if (obj.length > 500) return; // evitar arrays de segmentos
      for (const item of obj) {
        if (item && typeof item === "object") analyzeGlobalObject(item, depth + 1, visited);
      }
      return;
    }

    // Tentar extrair mídia deste objeto (mesmo código de extractMediaFromObject)
    extractMediaFromObject(obj);

    // Recursão nos valores objeto
    const keys = Object.keys(obj);
    if (keys.length > 200) return; // objeto muito grande = não é config de player
    for (const key of keys) {
      let child;
      try { child = obj[key]; } catch (_) { continue; }
      if (child && typeof child === "object" && child !== window && child !== document) {
        analyzeGlobalObject(child, depth + 1, visited);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ESTRATÉGIA 9 — MediaSource / MSE (players que usam streaming adaptativo)
  //
  // Players que usam MSE (Media Source Extensions) não fazem fetch
  // visível de um único arquivo .mp4 — eles carregam segmentos via
  // addSourceBuffer e appendBuffer. Não é possível interceptar o
  // conteúdo binário útilmente. O que fazemos aqui é:
  //
  //   1. Interceptar MediaSource.open para saber quando um player MSE inicia.
  //   2. Marcar o <video> como "MSE ativo" para que probeExternalPlayers
  //      saiba que as fontes virão via API do player, não via src.
  //
  // A interceptação real das URLs de stream MSE já é feita pelas
  // estratégias de fetch/XHR (estratégia 4) e manifest M3U8 (estratégia 5).
  // ─────────────────────────────────────────────────────────────────────────

  try {
    const origAddSB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function(mime) {
      // Disparar probe de players externos quando MSE começa a ser usado
      // Delay pequeno para o player ter tempo de configurar suas APIs
      setTimeout(probeExternalPlayers, 200);
      return origAddSB.apply(this, arguments);
    };
  } catch (_) {}


})();
