package idm

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// ─────────────────────────────────────────────────────────────────────────────
// rewriteM3U8 — reescreve URLs de segmentos num manifest HLS para passarem
// pelo proxy, garantindo propagação de cookies e headers de autenticação.
//
// Trata:
//   - Linhas de URL após #EXTINF (segmentos de vídeo/áudio)
//   - URI="..." em #EXT-X-KEY (chaves de criptografia AES-128)
//   - URI="..." em #EXT-X-MAP (segmento de inicialização fMP4)
//   - URI="..." em #EXT-X-MEDIA (streams alternativos)
//   - URLs absolutas e relativas (relativas são resolvidas contra o manifest)
// ─────────────────────────────────────────────────────────────────────────────

var uriAttrRe = regexp.MustCompile(`URI="([^"]+)"`)

func (l *Launcher) rewriteM3U8(content, manifestURL, jobID string) string {
	lines := strings.Split(content, "\n")
	result := make([]string, 0, len(lines))
	nextIsSegURL := false

	for _, line := range lines {
		trimmed := strings.TrimRight(line, "\r")

		if nextIsSegURL && trimmed != "" && !strings.HasPrefix(trimmed, "#") {
			// Linha de URL de segmento após #EXTINF
			abs := resolveSegmentURL(trimmed, manifestURL)
			if abs != "" {
				trimmed = l.segmentProxyURL(abs, jobID)
			}
			nextIsSegURL = false

		} else if strings.HasPrefix(trimmed, "#EXTINF:") {
			nextIsSegURL = true

		} else if strings.ContainsAny(trimmed, "#") &&
			(strings.HasPrefix(trimmed, "#EXT-X-KEY") ||
				strings.HasPrefix(trimmed, "#EXT-X-MAP") ||
				strings.HasPrefix(trimmed, "#EXT-X-MEDIA")) {
			// Reescrever URI="..." dentro das tags de metadados
			trimmed = uriAttrRe.ReplaceAllStringFunc(trimmed, func(match string) string {
				sub := uriAttrRe.FindStringSubmatch(match)
				if len(sub) < 2 {
					return match
				}
				abs := resolveSegmentURL(sub[1], manifestURL)
				if abs == "" {
					return match
				}
				return `URI="` + l.segmentProxyURL(abs, jobID) + `"`
			})
		}

		result = append(result, trimmed)
	}

	log.Printf("[M3U8:%s] manifest reescrito com %d linhas\n", jobID, len(result))
	return strings.Join(result, "\n")
}

// segmentProxyURL gera a URL do proxy para um segmento.
// Formato: http://127.0.0.1:{PORT}/{jobID}/s?u={encodedSegmentURL}
func (l *Launcher) segmentProxyURL(segURL, jobID string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/%s/s?u=%s",
		l.proxyPort, jobID, url.QueryEscape(segURL))
}

// resolveSegmentURL resolve uma URL de segmento (absoluta ou relativa)
// contra a URL base do manifest.
func resolveSegmentURL(ref, base string) string {
	if ref == "" {
		return ""
	}
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return ref
	}
	refURL, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return baseURL.ResolveReference(refURL).String()
}

// writeResponse — para respostas em memória (manifests M3U8 reescritos).
// NÃO usar para arquivos grandes: usa body []byte em memória.
func (l *Launcher) writeResponse(w http.ResponseWriter, resp *http.Response, body []byte, job DownloadJob, targetURL string) {
	filename := job.Filename
	if filename == "" {
		filename = filenameFromURL(targetURL)
		if filename == "" {
			filename = filenameFromURL(job.URL)
		}
	}

	l.copyHeaders(w, resp, filename)
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(body)))
	w.WriteHeader(resp.StatusCode)
	w.Write(body)

	log.Printf("[M3U8] %d | %d bytes | %s\n", resp.StatusCode, len(body), filename)
}

// streamResponse — streaming direto CDN → IDM sem carregar na memória.
//
// PROBLEMA ANTERIOR (causa do 502):
//   io.ReadAll() lia o vídeo inteiro (até GB) antes de escrever.
//   Para arquivos grandes: OOM ou WriteTimeout de 15s → 502 Bad Gateway.
//
// SOLUÇÃO:
//   io.CopyBuffer() com buffer fixo de 256KB faz pipe direto entre
//   a conexão TCP do CDN e a conexão TCP do IDM.
//   Uso de memória: constante ~256KB independente do tamanho do arquivo.
//   Content-Length e outros headers são repassados diretamente do CDN.
func (l *Launcher) streamResponse(w http.ResponseWriter, resp *http.Response, job DownloadJob, targetURL string) {
	filename := job.Filename
	if filename == "" {
		filename = filenameFromURL(targetURL)
		if filename == "" {
			filename = filenameFromURL(job.URL)
		}
	}

	// Detectar HTML em vez de arquivo esperado (sessão expirada / bloqueio WAF).
	// Lê apenas os primeiros 512 bytes para checar, depois reconstrói o stream.
	ct := strings.ToLower(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])
	expectedExt := strings.ToLower(fileExtension(filename))
	if isBinaryExtension(expectedExt) && resp.StatusCode < 400 &&
		(strings.Contains(ct, "text/html") || strings.Contains(ct, "application/xhtml")) {

		snip := make([]byte, 512)
		n, _ := io.ReadFull(resp.Body, snip)
		if n > 0 {
			snipLow := strings.ToLower(string(snip[:n]))
			if strings.Contains(snipLow, "<html") || strings.Contains(snipLow, "<!doctype") {
				log.Printf("[PROXY] ✗ BLOQUEADO: esperava %s mas recebeu HTML (HTTP %d)\n", filename, resp.StatusCode)
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.WriteHeader(http.StatusMisdirectedRequest)
				fmt.Fprintf(w, "IDM Bridge: download bloqueado.\n\nArquivo esperado: %s\nTipo recebido: %s\nCausa: sessão expirada ou cookies insuficientes.", filename, ct)
				return
			}
			// Não é HTML: reconstrói o stream com os bytes já lidos
			resp.Body = io.NopCloser(io.MultiReader(
				strings.NewReader(string(snip[:n])),
				resp.Body,
			))
		}
	}

	l.copyHeaders(w, resp, filename)
	w.WriteHeader(resp.StatusCode)

	// Streaming com buffer fixo — uso de memória constante
	buf := make([]byte, 256*1024) // 256 KB
	written, err := io.CopyBuffer(w, resp.Body, buf)
	if err != nil && l.verbose {
		log.Printf("[PROXY] Stream interrompido após %d bytes: %v\n", written, err)
	} else if resp.StatusCode >= 400 {
		log.Printf("[PROXY] ✗ HTTP %d | %d bytes | %s\n", resp.StatusCode, written, filename)
	} else {
		log.Printf("[PROXY] ✓ HTTP %d | %d bytes | %s\n", resp.StatusCode, written, filename)
	}
}

// copyHeaders copia os headers da resposta do CDN para o writer,
// preservando Content-Length original (não recalculado) e removendo
// headers de encoding que o Go já desfez automaticamente.
func (l *Launcher) copyHeaders(w http.ResponseWriter, resp *http.Response, filename string) {
	ct := strings.ToLower(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])

	skip := map[string]bool{
		"Content-Encoding":  true, // Go descomprime automaticamente
		"Transfer-Encoding": true, // Go usa chunked internamente
	}
	for k, vv := range resp.Header {
		if skip[k] {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}

	if resp.Header.Get("Content-Disposition") == "" && filename != "" {
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(filename)))
	}
	if (ct == "" || ct == "application/octet-stream") && filename != "" {
		if inferred := mimeByExtension(filename); inferred != "" {
			w.Header().Set("Content-Type", inferred)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// logRequestDiag — log diagnóstico para erros 4xx/5xx.
// Mostra exatamente o que o proxy enviou vs o que o CDN respondeu.
// Essencial para comparar com o que o browser envia (suspeita de header diff).
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) logRequestDiag(jobID, targetURL string, job DownloadJob, isSegment bool, rangeHeader string, resp *http.Response) {
	if resp.StatusCode < 400 && !l.verbose {
		return
	}

	log.Printf("[DIAG:%s] ══════════════════════════════════════════════════\n", jobID)
	log.Printf("[DIAG:%s] URL     : %s\n", jobID, targetURL)
	log.Printf("[DIAG:%s] Status  : %d %s\n", jobID, resp.StatusCode, resp.Status)
	log.Printf("[DIAG:%s] Segment : %v | Stream: %v\n", jobID, isSegment, job.RequestType == "stream")

	// Dicas de diagnóstico por tipo de CDN/erro
	if strings.Contains(targetURL, "googlevideo.com") && resp.StatusCode == 403 {
		log.Printf("[DIAG:%s] ⚠ YouTube 403: URL expirou (TTL ~6h) ou parâmetro n não decodificado\n", jobID)
		log.Printf("[DIAG:%s]   Solução: recarregue a página do YouTube e tente novamente\n", jobID)
	} else if strings.Contains(targetURL, "hotmart.com") && resp.StatusCode == 403 {
		log.Printf("[DIAG:%s] ⚠ Hotmart 403: cookies de sessão insuficientes ou expirados\n", jobID)
	} else if resp.StatusCode == 403 {
		log.Printf("[DIAG:%s] ⚠ 403: verificar Origin, Referer e Cookies no bloco abaixo\n", jobID)
	} else if resp.StatusCode == 416 {
		log.Printf("[DIAG:%s] ⚠ 416: Range inválido (retry sem Range já executado)\n", jobID)
	} else if resp.StatusCode == 502 {
		log.Printf("[DIAG:%s] ⚠ 502: CDN upstream indisponível\n", jobID)
	}
	log.Printf("[DIAG:%s] ── Headers enviados ───────────────────────────────\n", jobID)

	// Reconstruir os headers que foram enviados (applyHeaders)
	tmpReq, _ := http.NewRequest("GET", targetURL, nil)
	if tmpReq != nil {
		l.applyHeaders(tmpReq, job, isSegment, rangeHeader)
		for k, vv := range tmpReq.Header {
			for _, v := range vv {
				if k == "Cookie" && len(v) > 80 {
					v = v[:80] + "...[" + fmt.Sprintf("%d", len(v)) + " chars]"
				}
				log.Printf("[DIAG:%s]   %s: %s\n", jobID, k, v)
			}
		}
	}

	log.Printf("[DIAG:%s] ── Headers recebidos ──────────────────────────────\n", jobID)
	for k, vv := range resp.Header {
		for _, v := range vv {
			log.Printf("[DIAG:%s]   %s: %s\n", jobID, k, v)
		}
	}
	log.Printf("[DIAG:%s] ══════════════════════════════════════════════════\n", jobID)
}

// min helper para Go < 1.21
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
