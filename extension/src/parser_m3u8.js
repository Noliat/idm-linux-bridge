// parser_m3u8.js — world: MAIN, document_start
// Parser HLS M3U8 com extração de múltiplas qualidades e metadados.
//
// Herança do File Centipede: estrutura do parser_m3u8.js original,
// estendido com suporte a:
//   - Segmentos de chave AES-128 (#EXT-X-KEY)
//   - Streams de áudio e vídeo separados (#EXT-X-MEDIA)
//   - Resolução, bitrate e framerate por stream (#EXT-X-STREAM-INF)
//   - Múltiplos renditions em playlists master
//   - Emissão via window.__idmM3u8Parse() para o interceptor.js

(function () {
  "use strict";

  if (window.__idmM3u8Parser) return;
  window.__idmM3u8Parser = true;

  // ── Helpers de string ──────────────────────────────────────────────────────

  function isSpace(c) {
    return c === " " || c === "\t" || c === "\r" || c === "\n";
  }

  // ── Parser principal ───────────────────────────────────────────────────────

  class M3U8Parser {
    constructor() {
      this.buf = "";
      this.pos = 0;
    }

    skipLine() {
      while (this.pos < this.buf.length && this.buf[this.pos] !== "\n") this.pos++;
    }

    skipSpace() {
      while (this.pos < this.buf.length) {
        const c = this.buf[this.pos];
        if (c !== " " && c !== "\t") break;
        this.pos++;
      }
    }

    skipAllSpace() {
      while (this.pos < this.buf.length && isSpace(this.buf[this.pos])) this.pos++;
    }

    // Lê um token até delimitador — suporta strings entre aspas
    parseToken() {
      this.skipSpace();
      let quoted = false;
      if (this.pos < this.buf.length && this.buf[this.pos] === '"') {
        this.pos++;
        quoted = true;
      }
      const start = this.pos;
      while (this.pos < this.buf.length) {
        const c = this.buf[this.pos];
        if (quoted) {
          if (c === '"') {
            const val = this.buf.slice(start, this.pos);
            this.pos++;
            return val;
          }
        } else {
          if (c === ":" || c === "," || c === "=" || c === "&" || isSpace(c)) break;
        }
        this.pos++;
      }
      const val = this.buf.slice(start, this.pos);
      return val.length > 0 ? val : false;
    }

    // Lê atributos key=value,key=value,...
    parseAttributes() {
      const attrs = {};
      let count = 0;
      this.pos++; // pular ':'
      while (this.pos < this.buf.length) {
        const c = this.buf[this.pos];
        if (c === "\r" || c === "\n") break;
        if (c === "," || c === "&") { this.pos++; continue; }

        const key = this.parseToken();
        if (key === false) break;

        if (this.buf[this.pos] === "=") {
          this.pos++;
          const val = this.parseToken();
          if (val !== false) { attrs[key] = val; count++; }
        } else if (c === "\r" || c === "\n") {
          // valor sem chave
          if (count === 0) return key;
          attrs[""] = key;
          break;
        } else {
          this.pos++;
        }
      }
      return attrs;
    }

    // Lê a URL na linha seguinte ao tag
    parseAddress(result) {
      this.skipAllSpace();
      if (this.pos >= this.buf.length || this.buf[this.pos] === "#") return false;
      const start = this.pos;
      while (this.pos < this.buf.length) {
        const c = this.buf[this.pos];
        if (c === "\r" || c === "\n") break;
        this.pos++;
      }
      const addr = this.buf.slice(start, this.pos).trim();
      if (!addr) return false;
      result.address = addr;
      return true;
    }

    /**
     * parse(content, baseUrl?)
     *
     * Retorna um objeto com:
     *   isMaster   {boolean}  — true se for playlist master (múltiplas qualidades)
     *   streams    {Array}    — qualidades de vídeo (apenas em master)
     *   segments   {Array}    — segmentos (apenas em media playlist)
     *   audios     {Array}    — streams de áudio alternativos (#EXT-X-MEDIA)
     *   keys       {Array}    — chaves de criptografia (#EXT-X-KEY)
     *   duration   {number}   — duração total em segundos (media playlist)
     *   url        {string}   — URL base passada como parâmetro
     */
    parse(content, baseUrl) {
      this.buf = content;
      this.pos = 0;

      if (!content.trimStart().startsWith("#EXTM3U")) return false;

      const result = {
        isMaster:  false,
        streams:   [],
        segments:  [],
        audios:    [],
        keys:      [],
        duration:  0,
        url:       baseUrl || ""
      };

      while (this.pos < this.buf.length) {
        const c = this.buf[this.pos];
        if (c === "\r" || c === "\n" || isSpace(c)) { this.pos++; continue; }
        if (c !== "#") { this.skipLine(); continue; }

        this.pos++; // pular '#'
        const tag = this.parseToken();
        if (tag === false || !tag.startsWith("EXT")) { this.skipLine(); continue; }

        if (this.buf[this.pos] !== ":") { this.skipLine(); continue; }

        const attrs = this.parseAttributes();
        if (attrs === false) continue;

        // ── Tags de playlist master ──────────────────────────────────
        if (tag === "EXT-X-STREAM-INF") {
          // Cada stream tem a URL na próxima linha
          const stream = {
            type:       "stream",
            attrs,
            address:    "",
            bandwidth:  parseInt(attrs.BANDWIDTH || "0"),
            resolution: attrs.RESOLUTION || "",
            frameRate:  parseFloat(attrs["FRAME-RATE"] || "0"),
            codecs:     attrs.CODECS || "",
            audio:      attrs.AUDIO || ""  // referência ao grupo de áudio
          };
          if (this.parseAddress(stream)) {
            result.isMaster = true;
            result.streams.push(stream);
          }
        }

        // ── Streams de áudio separados ──────────────────────────────
        else if (tag === "EXT-X-MEDIA") {
          if (attrs.TYPE === "AUDIO" && attrs.URI) {
            result.audios.push({
              groupId:  attrs["GROUP-ID"] || "",
              name:     attrs.NAME || "",
              language: attrs.LANGUAGE || "",
              url:      attrs.URI
            });
          }
        }

        // ── Chave de criptografia AES-128 ────────────────────────────
        // Herança do File Centipede: capturar URI da chave para
        // incluir no payload de download — necessário para descriptografar
        // streams HLS criptografados.
        else if (tag === "EXT-X-KEY") {
          if (attrs.METHOD && attrs.METHOD !== "NONE" && attrs.URI) {
            result.keys.push({
              method:  attrs.METHOD,     // "AES-128" ou "SAMPLE-AES"
              uri:     attrs.URI,
              iv:      attrs.IV || "",   // vetor de inicialização (hex)
              keyFormat: attrs.KEYFORMAT || "identity"
            });
          }
        }

        // ── Segmentos de media playlist ──────────────────────────────
        else if (tag === "EXTINF") {
          const seg = { type: "Segment", attrs, address: "" };
          // Duração está em attrs[""] para segmentos simples
          const dur = parseFloat(typeof attrs === "string" ? attrs
                               : (attrs[""] || "0"));
          if (!isNaN(dur)) result.duration += dur;
          this.parseAddress(seg);
          result.segments.push(seg);
        }

        else {
          this.skipLine();
        }
      }

      return result;
    }
  }

  // Expor o parser para o interceptor.js usar
  window.__idmM3u8Parser = new M3U8Parser();

})();
