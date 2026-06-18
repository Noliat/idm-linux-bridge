package idm

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

//
// O parâmetro 'n' nas URLs do googlevideo.com é um token de throttling.
// O valor raw na URL NÃO é o valor final — precisa ser transformado pela
// função nsig do player YouTube. Sem essa transformação:
//   • ~30% das requests recebem 403 (depende do servidor de borda)
//   • ~70% recebem throttling severo (~50KB/s)
//
// Veja youtube_nsig.go para a implementação completa.
// ─────────────────────────────────────────────────────────────────────────────

// transformYouTubeURL resolve o parâmetro 'n' (nsig) das URLs do YouTube.
//
// Cadeia de métodos em ordem de prioridade:
//
//  Método 1 — Go + goja (nativo, ~1-5ms):
//    Extrai a função nsig do base.js e a executa via goja.
//    Transforma apenas o parâmetro 'n' na URL original — a URL já
//    contém o stream correto (muxed ou o formato que a extensão capturou).
//    É o caminho preferencial: zero overhead de disco.
//
//  Método 2 — yt-dlp download+merge (~30-120s dependendo da conexão):
//    Quando o goja falha, usa yt-dlp para baixar vídeo+áudio e mergear
//    em um único .mp4 via ffmpeg (que o yt-dlp chama internamente).
//    O arquivo mergeado é gravado em diretório temporário e servido ao
//    IDM via o próprio proxy reverso — o IDM recebe um único arquivo mp4
//    completo, sem streams separados.
//
//    IMPORTANTE: yt-dlp precisa do ffmpeg instalado para o merge.
//    Instalar: sudo apt install ffmpeg
//
//  Fallback final — remover 'n':
//    Funciona para ~40% dos casos onde o servidor de borda não valida 'n'.
func (l *Launcher) transformYouTubeURL(rawURL string, referrer string, job ...DownloadJob) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	if q.Get("n") == "" {
		return rawURL
	}

	// ── Método 1: Go + goja (nsig nativo) ────────────────────────────────
	if resolved, err := ResolveNParam(rawURL, referrer); err == nil && resolved != rawURL {
		log.Printf("[YOUTUBE] n-param transformado via goja (nsig nativo)\n")
		return resolved
	} else if err != nil {
		log.Printf("[NSIG] Método 1 falhou: %v — tentando yt-dlp\n", err)
	}

	// ── Método 2: yt-dlp download+merge em arquivo local ─────────────────
	//
	// Quando o goja falha, o yt-dlp é acionado para baixar e mergear
	// vídeo+áudio em um único .mp4 usando ffmpeg internamente.
	//
	// Fluxo:
	//   1. yt-dlp baixa bestvideo e bestaudio separadamente (streams DASH)
	//   2. ffmpeg mergea em <tmpdir>/<videoID>.mp4 (via --merge-output-format)
	//   3. O arquivo mergeado é servido pelo proxy via rota especial /ytmerge/
	//   4. O IDM recebe a URL do proxy local — baixa um único arquivo mp4
	//   5. Após o IDM baixar, o arquivo temporário é removido
	// Extrair job do variadic (pode ser vazio se chamado sem job context)
	var djob DownloadJob
	if len(job) > 0 {
		djob = job[0]
	}
	if localURL := l.ytdlpMergeAndServe(rawURL, referrer, djob); localURL != "" {
		return localURL
	}

	// Fallback final: remover n
	return l.removeNParam(rawURL)
}

// ytMergeCache mapeia videoID → caminho do arquivo mergeado em disco.
// Evita re-download se o mesmo vídeo for solicitado novamente enquanto
// o arquivo ainda está presente.
var ytMergeCache = struct {
	sync.Mutex
	m map[string]string // videoID → filepath
}{m: make(map[string]string)}

// ytmergeJobs rastreia downloads yt-dlp em andamento para evitar
// iniciar o mesmo download duas vezes (ex: IDM tentando Range requests
// concorrentes na mesma URL).
var ytmergeJobs = struct {
	sync.Mutex
	m map[string]chan struct{} // videoID → canal fechado quando pronto
}{m: make(map[string]chan struct{})}

// buildYtdlpFormatSelector monta o seletor de formato do yt-dlp baseado no
// itag/height solicitado pelo usuário. Isso garante que ao usar o fallback
// yt-dlp, a qualidade selecionada no dropdown seja respeitada.
//
// Precedência:
//  1. itag+audioItag explícitos → seletor exato (mais preciso)
//  2. Apenas height → bestvideo[height=N]+bestaudio  
//  3. Nenhum → bestvideo+bestaudio/best (comportamento original)
func buildYtdlpFormatSelector(job DownloadJob) string {
	// Caso 1: itags explícitos fornecidos pela extensão
	if job.Itag != "" && job.AudioItag != "" {
		// Ex: "313+140" → VP9 2160p + AAC 128k
		return job.Itag + "+" + job.AudioItag
	}
	if job.Itag != "" {
		// Apenas itag de vídeo — usar melhor áudio disponível
		return job.Itag + "+bestaudio/bestvideo+bestaudio/best"
	}

	// Caso 2: altura especificada (sem itag)
	if job.Height > 0 {
		h := job.Height
		// Seletor com fallbacks encadeados:
		//   bestvideo[height=N]+bestaudio  → qualidade exata
		//   bestvideo[height<=N]+bestaudio → abaixo se exata não disponível
		//   bestvideo+bestaudio/best       → fallback final
		return fmt.Sprintf(
			"bestvideo[height=%d]+bestaudio/bestvideo[height<=%d]+bestaudio/bestvideo+bestaudio/best",
			h, h,
		)
	}

	// Caso 3: sem informação → melhor disponível (comportamento original)
	return "bestvideo+bestaudio/best"
}

// ytdlpMergeAndServe baixa e mergea o vídeo com yt-dlp+ffmpeg,
// registra o arquivo no proxy e retorna a URL local para o IDM usar.
// Retorna "" se yt-dlp não estiver disponível ou se falhar.
func (l *Launcher) ytdlpMergeAndServe(rawURL, referrer string, job DownloadJob) string {
	ytdlp, err := exec.LookPath("yt-dlp")
	if err != nil {
		return "" // yt-dlp não instalado
	}

	videoID := extractYouTubeVideoID(referrer)
	if videoID == "" {
		// Tentar extrair da própria URL CDN — parâmetro 'docid' ou 'id'
		u, _ := url.Parse(rawURL)
		videoID = u.Query().Get("docid")
		if videoID == "" {
			videoID = u.Query().Get("id")
		}
	}
	if videoID == "" {
		log.Printf("[YTDLP] Não foi possível determinar o video ID\n")
		return ""
	}

	// ── Verificar cache de arquivo mergeado ───────────────────────────────
	ytMergeCache.Lock()
	cachedPath, cached := ytMergeCache.m[videoID]
	ytMergeCache.Unlock()

	if cached {
		if _, statErr := os.Stat(cachedPath); statErr == nil {
			// Arquivo ainda existe — registrar no proxy e retornar URL
			return l.registerMergedFile(cachedPath, videoID)
		}
		// Arquivo foi removido — limpar cache e re-download
		ytMergeCache.Lock()
		delete(ytMergeCache.m, videoID)
		ytMergeCache.Unlock()
	}

	// ── Singleflight: evitar downloads paralelos do mesmo vídeo ──────────
	ytmergeJobs.Lock()
	if ch, inProgress := ytmergeJobs.m[videoID]; inProgress {
		ytmergeJobs.Unlock()
		// Aguardar o download em andamento completar
		log.Printf("[YTDLP] Aguardando download em andamento para %s\n", videoID)
		<-ch
		// Re-verificar cache após conclusão
		ytMergeCache.Lock()
		p, ok := ytMergeCache.m[videoID]
		ytMergeCache.Unlock()
		if ok {
			return l.registerMergedFile(p, videoID)
		}
		return ""
	}
	// Registrar canal de conclusão
	done := make(chan struct{})
	ytmergeJobs.m[videoID] = done
	ytmergeJobs.Unlock()

	defer func() {
		ytmergeJobs.Lock()
		delete(ytmergeJobs.m, videoID)
		ytmergeJobs.Unlock()
		close(done)
	}()

	// ── Download + merge via yt-dlp ───────────────────────────────────────
	tmpDir, err := os.MkdirTemp("", "idm-ytmerge-*")
	if err != nil {
		log.Printf("[YTDLP] Falha ao criar diretório temporário: %v\n", err)
		return ""
	}
	// Não remover tmpDir aqui — será removido após o IDM terminar o download

	outTemplate := filepath.Join(tmpDir, videoID+".%(ext)s")
	watchURL := "https://www.youtube.com/watch?v=" + videoID

	// Timeout generoso: vídeos grandes em conexões lentas podem demorar vários minutos.
	// O contexto é do processo yt-dlp — não do request HTTP do IDM.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	log.Printf("[YTDLP] Iniciando download+merge para %s → %s\n", videoID, tmpDir)

	// Selecionar o formato correto baseado no itag/height solicitado.
	// Se itags específicos foram passados, usamos "videoItag+audioItag".
	// Senão, montamos seletor por altura (ex: "bestvideo[height=1080]+bestaudio/best").
	// Fallback final: "bestvideo+bestaudio/best".
	formatSelector := buildYtdlpFormatSelector(job)

	cmd := exec.CommandContext(ctx, ytdlp,
		"--no-playlist",
		"--no-warnings",
		"--quiet",
		"--progress",
		"-f", formatSelector,
		"--merge-output-format", "mp4",
		"-o", outTemplate,
		watchURL,
	)
	cmd.Stdout = os.Stderr // redirecionar progresso para stderr do processo
	cmd.Stderr = os.Stderr

	if err := cmd.Run(); err != nil {
		log.Printf("[YTDLP] Falha no download+merge: %v\n", err)
		os.RemoveAll(tmpDir)
		return ""
	}

	// Localizar o arquivo .mp4 gerado
	outPath := filepath.Join(tmpDir, videoID+".mp4")
	if _, statErr := os.Stat(outPath); statErr != nil {
		// yt-dlp pode ter usado extensão diferente — procurar no diretório
		entries, _ := os.ReadDir(tmpDir)
		for _, e := range entries {
			if !e.IsDir() {
				outPath = filepath.Join(tmpDir, e.Name())
				break
			}
		}
		if _, statErr2 := os.Stat(outPath); statErr2 != nil {
			log.Printf("[YTDLP] Arquivo de saída não encontrado em %s\n", tmpDir)
			os.RemoveAll(tmpDir)
			return ""
		}
	}

	log.Printf("[YTDLP] ✓ Merge concluído: %s\n", outPath)

	// Registrar no cache
	ytMergeCache.Lock()
	ytMergeCache.m[videoID] = outPath
	ytMergeCache.Unlock()

	return l.registerMergedFile(outPath, videoID)
}

// registerMergedFile registra um arquivo local no proxy reverso e retorna
// a URL http://127.0.0.1:<port>/<token>/merged que o IDM usará para baixar.
//
// O proxy serve o arquivo diretamente via io.Copy — o IDM recebe um
// único arquivo mp4 completo com Content-Length correto.
// Após a conclusão do download, o arquivo temporário é removido.
func (l *Launcher) registerMergedFile(filePath, videoID string) string {
	token := videoID + "-merged"

	// Criar um job especial que aponta para o arquivo local
	job := DownloadJob{
		URL:      "file://" + filePath, // marcador interno
		Filename: videoID + ".mp4",
		Silent:   false,
	}

	l.mu.Lock()
	l.jobs[token] = &jobEntry{job: job, createdAt: time.Now()}
	l.mu.Unlock()

	proxyURL := fmt.Sprintf("http://127.0.0.1:%d/%s", l.proxyPort, token)
	log.Printf("[YTDLP] Arquivo mergeado disponível em: %s\n", proxyURL)
	return proxyURL
}

// extractYouTubeVideoID extrai o ID do vídeo de uma URL do YouTube.
// Suporta: watch?v=ID, youtu.be/ID, shorts/ID, embed/ID
func extractYouTubeVideoID(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	// youtube.com/watch?v=ID
	if v := u.Query().Get("v"); v != "" {
		return v
	}
	// youtu.be/ID ou /shorts/ID ou /embed/ID
	path := strings.TrimPrefix(u.Path, "/")
	parts := strings.SplitN(path, "/", 2)
	switch parts[0] {
	case "shorts", "embed", "v", "e":
		if len(parts) > 1 && parts[1] != "" {
			return strings.Split(parts[1], "?")[0]
		}
	default:
		// youtu.be/ID — o host é youtu.be
		if strings.Contains(u.Host, "youtu.be") && path != "" {
			return strings.Split(path, "?")[0]
		}
	}
	return ""
}

// removeNParam remove o parâmetro 'n' da URL como último recurso.
// Funciona para ~40% dos casos onde o servidor de borda não valida 'n'.
func (l *Launcher) removeNParam(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	q := u.Query()
	if q.Get("n") != "" {
		q.Del("n")
		u.RawQuery = q.Encode()
		log.Printf("[YOUTUBE] Parâmetro n removido (fallback final)\n")
	}
	return u.String()
}

// applyHeaders injeta todos os headers necessários no request.
// Centralizar aqui garante consistência entre request inicial, retry e redirects.
//
// Perfis de headers por tipo:
//
//   isSegment=true (segmento HLS/DASH):
//     Simula fetch() do player JS — Sec-Fetch-Mode: cors, Dest: empty
//     O Origin é o do CDN de mídia (ou derivado do Referer da página)
//
//   job.RequestType=="stream" (manifest ou stream não-HLS):
//     Sec-Fetch-Mode: no-cors, Dest: empty — como player fazendo XHR
//
//   default (arquivo direto, download):
//     Sec-Fetch-Mode: navigate, Dest: document, User: ?1
//     Simula clique do usuário num link de download
func (l *Launcher) applyHeaders(req *http.Request, job DownloadJob, isSegment bool, rangeHeader string) {
	ua := job.UserAgent
	if ua == "" {
		ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
	}

	req.Header.Set("User-Agent", ua)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Accept-Language", "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7")
	req.Header.Set("Connection", "keep-alive")

	// Accept-Encoding para streams de vídeo/áudio: identity (sem compressão).
	// Com DisableCompression:true no Transport, o Go não descomprime — o stream
	// passa direto ao IDM. Se o CDN enviar gzip, o IDM recebe dados comprimidos
	// sem saber disso. Pedir "identity" garante que o CDN não comprima o stream.
	// Para manifests HLS (texto pequeno) e outros tipos: deixar o CDN decidir.
	if isSegment || job.RequestType == "stream" {
		req.Header.Set("Accept-Encoding", "identity")
	}

	// ── Client Hints (Sec-Ch-Ua) ─────────────────────────────────────────────
	// WAFs modernos (Cloudflare, Akamai, Bunny, Imperva) verificam esses headers
	// como parte do "bot score" junto com o TLS fingerprint.
	// Um request sem Sec-Ch-Ua vindos de um UA Chrome gera inconsistência:
	// "UA diz Chrome 125, mas não tem Client Hints" → tratado como bot/scraper.
	//
	// Os valores abaixo correspondem ao Chrome 125 (mesmo UA que estamos usando).
	// Sec-Ch-Ua: lista de browsers no formato GREASE + major version
	// Sec-Ch-Ua-Mobile: ?0 = desktop, ?1 = mobile
	// Sec-Ch-Ua-Platform: sistema operacional (Windows para consistência com UA)
	req.Header.Set("Sec-Ch-Ua",          `"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"`)
	req.Header.Set("Sec-Ch-Ua-Mobile",   "?0")
	req.Header.Set("Sec-Ch-Ua-Platform", `"Windows"`)

	// Detectar YouTube para perfil de headers específico.
	// YouTube's CDN (googlevideo.com) valida:
	//   - Sec-Fetch-Mode: cors  (não no-cors — o player usa fetch() em cors mode)
	//   - Origin: https://www.youtube.com  (não o domínio do CDN)
	//   - Accept-Language com pt ou en  (já configurado acima)
	isYouTube := strings.Contains(req.URL.Host, "googlevideo.com")

	switch {
	case isYouTube:
		// YouTube CDN: o player usa fetch() em cors mode com Origin do site principal
		req.Header.Set("Sec-Fetch-Dest", "empty")
		req.Header.Set("Sec-Fetch-Mode", "cors")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Origin", "https://www.youtube.com")
		req.Header.Set("Referer", "https://www.youtube.com/")

	case isSegment:
		// Segmento HLS/DASH: fetch() cross-origin do player
		req.Header.Set("Sec-Fetch-Dest", "empty")
		req.Header.Set("Sec-Fetch-Mode", "cors")
		req.Header.Set("Sec-Fetch-Site", "cross-site")

	case job.RequestType == "stream":
		// Manifest/stream: XHR do player (no-cors)
		req.Header.Set("Sec-Fetch-Dest", "empty")
		req.Header.Set("Sec-Fetch-Mode", "no-cors")
		req.Header.Set("Sec-Fetch-Site", "cross-site")

	default:
		// Download direto: navegação iniciada pelo usuário
		req.Header.Set("Sec-Fetch-Dest", "document")
		req.Header.Set("Sec-Fetch-Mode", "navigate")
		req.Header.Set("Sec-Fetch-Site", "cross-site")
		req.Header.Set("Sec-Fetch-User", "?1")
		req.Header.Set("Upgrade-Insecure-Requests", "1")
	}

	if job.Cookies != "" && !isYouTube {
		// YouTube não usa cookies para autenticar downloads de vídeo —
		// a autenticação está na assinatura da URL (sig, expire, ip).
		// Enviar cookies do browser pode causar conflito com os parâmetros de auth.
		req.Header.Set("Cookie", job.Cookies)
	} else if job.Cookies != "" {
		// Para outros sites, sempre enviar cookies
		req.Header.Set("Cookie", job.Cookies)
	}

	if !isYouTube {
		// Referrer e Origin para não-YouTube
		if job.Referrer != "" {
			req.Header.Set("Referer", job.Referrer)
		}
		if job.MediaOrigin != "" {
			req.Header.Set("Origin", job.MediaOrigin)
		} else if job.Referrer != "" {
			if u, err := url.Parse(job.Referrer); err == nil {
				req.Header.Set("Origin", fmt.Sprintf("%s://%s", u.Scheme, u.Host))
			}
		}
	}

	// Range: forwarded do IDM para suporte a retomada e download em paralelo.
	// Omitido quando rangeHeader == "" (retry após 416 ou request sem Range).
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}

	// Headers extras da extensão (Authorization, tokens, etc.)
	// X-IDM-Request-Type é header interno — removido antes de enviar ao CDN.
	delete(job.Headers, "X-IDM-Request-Type")
	for k, v := range job.Headers {
		req.Header.Set(k, v)
	}
}
