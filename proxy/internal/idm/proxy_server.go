package idm

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Proxy reverso
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) startReverseProxy() error {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("não foi possível abrir porta para proxy: %w", err)
	}
	l.proxyPort = listener.Addr().(*net.TCPAddr).Port
	listener.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/", l.handleProxyRequest)

	l.proxyServer = &http.Server{
		Addr:         fmt.Sprintf("127.0.0.1:%d", l.proxyPort),
		Handler:      mux,
		ReadTimeout:  0,
		WriteTimeout: 0,
	}

	go func() {
		if err := l.proxyServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[PROXY] Erro: %v\n", err)
		}
	}()

	log.Printf("[PROXY] Proxy reverso iniciado na porta %d\n", l.proxyPort)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// handleProxyRequest — roteador principal do proxy reverso
//
// Rotas:
//   GET /{jobID}           — request original do IDM (manifest ou arquivo)
//   GET /{jobID}/s?u=URL   — segmento HLS/DASH proxiado com contexto do job
//
// Para manifests HLS (.m3u8), o proxy reescreve todos os URLs de segmentos
// para apontar para /{jobID}/s?u=... antes de entregar ao IDM.
// Isso garante que TODOS os segmentos passem pelo proxy com os headers
// corretos (cookies, Origin, Referer, UA) — sem isso os segmentos vão
// diretamente ao CDN sem autenticação e recebem 403.
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) handleProxyRequest(w http.ResponseWriter, r *http.Request) {
	// ── Roteamento: /{jobID} ou /{jobID}/s ──────────────────────────────────
	rawPath := strings.TrimPrefix(r.URL.Path, "/")
	parts   := strings.SplitN(rawPath, "/", 2)
	jobID   := parts[0]
	subPath := ""
	if len(parts) > 1 {
		subPath = parts[1]
	}

	l.mu.RLock()
	entry, ok := l.jobs[jobID]
	l.mu.RUnlock()
	if !ok {
		http.Error(w, "token inválido", http.StatusBadRequest)
		return
	}

	job := entry.job

	// ── Determinar URL alvo ──────────────────────────────────────────────────
	var targetURL string
	isSegment := false

	if subPath == "s" {
		// Request de segmento HLS/DASH — URL real codificada no query param
		targetURL = r.URL.Query().Get("u")
		if targetURL == "" {
			http.Error(w, "parâmetro 'u' ausente", http.StatusBadRequest)
			return
		}
		isSegment = true
		log.Printf("[SEG:%s] %s\n", jobID, targetURL)
	} else {
		// Request original do IDM — URL do job
		targetURL = job.URL
		if r.URL.RawQuery != "" {
			sep := "?"
			if strings.Contains(targetURL, "?") {
				sep = "&"
			}
			targetURL += sep + r.URL.RawQuery
		}

		// ── YouTube n-parameter transform ────────────────────────────────
		// URLs do googlevideo.com contêm parâmetro 'n' que precisa ser
		// transformado pelo nsig do player YouTube. Sem isso: 403 ou ~50KB/s.
		//
		// Quando o goja resolve o 'n' → retorna a URL original transformada.
		// Quando o yt-dlp é acionado → baixa+mergea em arquivo local e
		// retorna URL http://127.0.0.1:<port>/<token>/merged para servir
		// o .mp4 completo ao IDM (um único arquivo com vídeo+áudio).
		if strings.Contains(targetURL, "googlevideo.com") {
			// Se temos streams DASH separados (audioUrl presente), fazer mux
			// com ffmpeg ANTES de tentar transformar o 'n'.
			// A extensão enviou: vídeo DASH (sem áudio) + áudio DASH separado.
			// O resultado é um único .mp4 com ambos, servido localmente.
			if job.AudioUrl != "" {
				if mergedURL := l.dashMergeAndServe(targetURL, job.AudioUrl, job); mergedURL != "" {
					log.Printf("[DASH] Streams mergeados via ffmpeg para job %s\n", jobID)
					targetURL = mergedURL
					l.mu.Lock()
					if e, ok := l.jobs[jobID]; ok { e.job.URL = mergedURL }
					l.mu.Unlock()
				} else {
					// Merge falhou — transformar apenas o 'n' do vídeo e continuar
					// O IDM vai baixar só o vídeo sem áudio (melhor que nada)
					log.Printf("[DASH] Merge falhou para job %s — baixando só vídeo\n", jobID)
					targetURL = l.transformYouTubeURL(targetURL, job.Referrer)
				}
			} else {
				transformed := l.transformYouTubeURL(targetURL, job.Referrer)
				if transformed != targetURL {
					log.Printf("[YOUTUBE] URL transformada para job %s\n", jobID)
					targetURL = transformed
					l.mu.Lock()
					if e, ok := l.jobs[jobID]; ok { e.job.URL = transformed }
					l.mu.Unlock()
				}
			
			}
		}

		log.Printf("[PROXY:%s] %s\n", jobID, targetURL)
	}

	// ── Servir arquivo local (yt-dlp merge) ─────────────────────────────────
	// Quando o yt-dlp baixou e mergeou o vídeo localmente, a URL do job
	// fica como "file:///tmp/idm-ytmerge-xxx/VIDEOID.mp4". Servir
	// diretamente sem passar pelo proxy HTTP externo.
	if strings.HasPrefix(targetURL, "file://") {
		filePath := strings.TrimPrefix(targetURL, "file://")
		f, openErr := os.Open(filePath)
		if openErr != nil {
			http.Error(w, fmt.Sprintf("arquivo mergeado não encontrado: %v", openErr), http.StatusNotFound)
			return
		}
		defer f.Close()

		stat, statErr := f.Stat()
		if statErr != nil {
			http.Error(w, "erro ao ler arquivo mergeado", http.StatusInternalServerError)
			return
		}

		filename := job.Filename
		if filename == "" {
			filename = filepath.Base(filePath)
		}

		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(filename)))

		rangeHdr := r.Header.Get("Range")
		if rangeHdr != "" {
			// http.ServeContent cuida de Range, Content-Range e 206 automaticamente
			http.ServeContent(w, r, filename, stat.ModTime(), f)
		} else {
			w.WriteHeader(http.StatusOK)
			buf := make([]byte, 256*1024)
			written, _ := io.CopyBuffer(w, f, buf)
			log.Printf("[YTDLP] ✓ Arquivo local servido: %d bytes | %s\n", written, filename)
		}

		// Remover arquivo temporário após 5min (tempo para IDM concluir o download)
		go func(dir string) {
			time.Sleep(5 * time.Minute)
			if strings.Contains(dir, "idm-ytmerge-") {
				os.RemoveAll(dir)
				log.Printf("[YTDLP] Temp removido: %s\n", dir)
			}
		}(filepath.Dir(filePath))
		return
	}

	// ── Executar request com retry em 416 ────────────────────────────────────
	rangeHeader := r.Header.Get("Range")
	resp, err := l.doProxyFetch(r.Method, targetURL, job, isSegment, rangeHeader)
	if err != nil {
		http.Error(w, fmt.Sprintf("erro ao buscar: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// ── Log diagnóstico em erro ──────────────────────────────────────────────
	if resp.StatusCode >= 400 || l.verbose {
		l.logRequestDiag(jobID, targetURL, job, isSegment, rangeHeader, resp)
	}

	// ── Reescrita de manifests HLS ───────────────────────────────────────────
	// Manifests são pequenos (< 100KB) e precisam de reescrita de URLs —
	// ReadAll é seguro aqui. Para tudo mais: streaming direto (io.Copy).
	ct := strings.ToLower(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])
	isHLS := strings.Contains(ct, "mpegurl") ||
		strings.Contains(ct, "x-mpegurl") ||
		strings.HasSuffix(strings.Split(targetURL, "?")[0], ".m3u8")

	if isHLS && !isSegment && resp.StatusCode < 400 {
		body, readErr := io.ReadAll(resp.Body)
		if readErr == nil {
			rewritten := l.rewriteM3U8(string(body), targetURL, jobID)
			l.writeResponse(w, resp, []byte(rewritten), job, targetURL)
			return
		}
	}

	// ── Erro do CDN (4xx/5xx) ────────────────────────────────────────────────
	// Drenar o body do CDN para liberar a conexão TCP de volta ao pool,
	// e retornar mensagem de erro legível ao IDM.
	if resp.StatusCode >= 400 {
		io.Copy(io.Discard, resp.Body)
		errorMsg := fmt.Sprintf(
			"IDM Bridge: CDN retornou HTTP %d\n\nURL: %s\nArquivo: %s\n\nDicas:\n"+
			"  - 403 YouTube: URL expirou, recarregue a pagina\n"+
			"  - 403 outros: cookies expirados ou IP bloqueado\n"+
			"  - 416: Range invalido, tente novamente",
			resp.StatusCode, targetURL, job.Filename,
		)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(resp.StatusCode)
		fmt.Fprint(w, errorMsg)
		log.Printf("[PROXY] ✗ CDN %d | %s\n", resp.StatusCode, targetURL)
		return
	}

	// ── Streaming direto para arquivos e segmentos ────────────────────────────
	// io.CopyBuffer com buffer fixo de 256KB — uso de memória constante.
	l.streamResponse(w, resp, job, targetURL)
}

// ─────────────────────────────────────────────────────────────────────────────
// doProxyFetch — executa o request HTTP com todos os headers corretos.
// Retry automático em 416 Range Not Satisfiable:
//   se o CDN rejeitar o Range (arquivo mudou, range inválido), tentar sem Range.
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) doProxyFetch(method, targetURL string, job DownloadJob, isSegment bool, rangeHeader string) (*http.Response, error) {
	resp, err := l.executeRequest(method, targetURL, job, isSegment, rangeHeader)
	if err != nil {
		return nil, err
	}

	// 416 Range Not Satisfiable — tentar sem Range header
	if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		resp.Body.Close()
		log.Printf("[PROXY] 416 para %s — retentando sem Range\n", targetURL)
		resp, err = l.executeRequest(method, targetURL, job, isSegment, "")
		if err != nil {
			return nil, err
		}
	}

	return resp, nil
}

// executeRequest constrói e executa um request HTTP com o contexto completo do job.
// Reutiliza l.httpTransport para connection pooling — crítico para HLS.
func (l *Launcher) executeRequest(method, targetURL string, job DownloadJob, isSegment bool, rangeHeader string) (*http.Response, error) {
	proxyReq, err := http.NewRequest(method, targetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("request inválido: %w", err)
	}

	l.applyHeaders(proxyReq, job, isSegment, rangeHeader)

	client := &http.Client{
		Timeout:   0,
		Transport: l.httpTransport, // Transport compartilhado: connection pooling + sem auto-gzip
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 15 {
				return fmt.Errorf("loop de redirecionamentos")
			}
			l.applyHeaders(req, job, isSegment, rangeHeader)
			return nil
		},
	}

	return client.Do(proxyReq)
}

// ─────────────────────────────────────────────────────────────────────────────
