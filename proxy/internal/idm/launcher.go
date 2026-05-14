package idm

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DownloadJob representa um trabalho de download a ser enviado ao IDM.
type DownloadJob struct {
	URL       string
	Filename  string
	Cookies   string
	Referrer  string
	UserAgent string
	Headers   map[string]string
}

// jobEntry armazena o job em espera enquanto o IDM faz a requisição.
type jobEntry struct {
	job       DownloadJob
	createdAt time.Time
}

// Launcher gerencia o lançamento do IDM via Wine e o proxy reverso de headers.
type Launcher struct {
	winePrefix  string
	idmPath     string
	wineBin     string
	verbose     bool

	// Proxy reverso local: o IDM aponta para cá, e nós injetamos os headers certos
	proxyPort   int
	proxyServer *http.Server

	mu   sync.RWMutex
	jobs map[string]*jobEntry // token → job (para correlacionar requisição do IDM)
}

// NewLauncher cria e inicializa o launcher com o proxy reverso embutido.
func NewLauncher(winePrefix, idmPath string, verbose bool) (*Launcher, error) {
	wineBin, err := findWine()
	if err != nil {
		return nil, err
	}

	l := &Launcher{
		winePrefix: winePrefix,
		idmPath:    idmPath,
		wineBin:    wineBin,
		verbose:    verbose,
		jobs:       make(map[string]*jobEntry),
	}

	// Iniciar proxy reverso em porta aleatória livre
	if err := l.startReverseProxy(); err != nil {
		return nil, fmt.Errorf("falha ao iniciar proxy reverso: %w", err)
	}

	// Limpar jobs expirados a cada minuto
	go l.cleanupLoop()

	return l, nil
}

// IsIDMAvailable verifica se o IDMan.exe existe no prefixo Wine.
func (l *Launcher) IsIDMAvailable() bool {
	_, err := os.Stat(l.idmPath)
	return err == nil
}

// ─────────────────────────────────────────────────────────────
// Proxy reverso — o coração da solução para o 403
// ─────────────────────────────────────────────────────────────
//
// Fluxo:
//   1. Bridge recebe job da extensão → registra token → monta URL proxy
//   2. Bridge lança IDM com a URL do proxy (ex: http://127.0.0.1:PORT/TOKEN)
//   3. IDM faz GET para o proxy
//   4. Proxy recupera o job pelo token, injeta cookies/headers/UA/referrer
//   5. Proxy faz a requisição real ao servidor de origem com headers corretos
//   6. Proxy transmite a resposta de volta ao IDM via streaming
//   7. IDM recebe o arquivo como se tivesse baixado diretamente
//
// Resultado: o servidor de origem vê uma requisição legítima com
// todos os headers do navegador → sem 403.

func (l *Launcher) startReverseProxy() error {
	// Encontrar porta livre
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
		ReadTimeout:  0, // sem timeout — downloads podem demorar horas
		WriteTimeout: 0,
	}

	go func() {
		if err := l.proxyServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[PROXY] Erro: %v\n", err)
		}
	}()

	log.Printf("[PROXY] Proxy reverso de headers iniciado na porta %d\n", l.proxyPort)
	return nil
}

// handleProxyRequest processa requisições do IDM, injeta headers e repassa ao servidor real.
func (l *Launcher) handleProxyRequest(w http.ResponseWriter, r *http.Request) {
	// Token é o primeiro segmento do path: /TOKEN
	token := strings.TrimPrefix(r.URL.Path, "/")
	token = strings.SplitN(token, "/", 2)[0]

	l.mu.RLock()
	entry, ok := l.jobs[token]
	l.mu.RUnlock()

	if !ok {
		if l.verbose {
			log.Printf("[PROXY] Token desconhecido: %s\n", token)
		}
		http.Error(w, "token inválido", http.StatusBadRequest)
		return
	}

	job := entry.job

	log.Printf("[PROXY] IDM solicitou: %s\n", job.URL)

	// ── Montar URL de destino preservando Range queries do IDM ──

	targetURL := job.URL
	if r.URL.RawQuery != "" {
		sep := "?"
		if strings.Contains(targetURL, "?") {
			sep = "&"
		}
		targetURL += sep + r.URL.RawQuery
	}

	// ── Criar requisição para o servidor real ────────────────

	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		log.Printf("[PROXY] Erro ao criar requisição: %v\n", err)
		http.Error(w, "erro interno", http.StatusInternalServerError)
		return
	}

	// ── Injetar headers corretos ──────────────────────────────

	ua := job.UserAgent
	if ua == "" {
		ua = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
			"(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
	}
	proxyReq.Header.Set("User-Agent", ua)

	if job.Cookies != "" {
		proxyReq.Header.Set("Cookie", job.Cookies)
	}
	if job.Referrer != "" {
		proxyReq.Header.Set("Referer", job.Referrer)
	}

	// Accept correto para binários — NÃO usar "text/html" que causa o bug
	proxyReq.Header.Set("Accept", "application/octet-stream, */*;q=0.9")
	proxyReq.Header.Set("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
	proxyReq.Header.Set("Accept-Encoding", "identity") // sem gzip — IDM recebe bytes crus
	proxyReq.Header.Set("Connection", "keep-alive")

	// Sec-Fetch correto para download de arquivo (não "document")
	proxyReq.Header.Set("Sec-Fetch-Dest", "empty")
	proxyReq.Header.Set("Sec-Fetch-Mode", "cors")
	proxyReq.Header.Set("Sec-Fetch-Site", "same-site")

	// Preservar Range — essencial para download multi-parte do IDM
	if rng := r.Header.Get("Range"); rng != "" {
		proxyReq.Header.Set("Range", rng)
	}

	// Headers customizados do job (Authorization, X-Auth-Token, etc.)
	for k, v := range job.Headers {
		proxyReq.Header.Set(k, v)
	}

	// ── Executar requisição real ──────────────────────────────

	client := &http.Client{
		Timeout: 0, // sem timeout global — downloads podem demorar horas
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Propagar cookies e UA em cada redirecionamento
			req.Header.Set("User-Agent", ua)
			if job.Cookies != "" {
				req.Header.Set("Cookie", job.Cookies)
			}
			if len(via) >= 15 {
				return fmt.Errorf("loop de redirecionamentos detectado (>15)")
			}
			return nil
		},
	}

	resp, err := client.Do(proxyReq)
	if err != nil {
		log.Printf("[PROXY] Erro na requisição: %v\n", err)
		http.Error(w, fmt.Sprintf("erro ao buscar arquivo: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	log.Printf("[PROXY] Resposta: HTTP %d | Content-Type: %s | Content-Length: %s\n",
		resp.StatusCode,
		resp.Header.Get("Content-Type"),
		resp.Header.Get("Content-Length"),
	)

	// ── Extrair Content-Type real da resposta ────────────────────
	ct := strings.ToLower(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0])
	ct = strings.TrimSpace(ct)

	// Extensão esperada (baseada no filename do job ou da URL)
	filename := job.Filename
	if filename == "" {
		filename = filenameFromURL(job.URL)
	}
	expectedExt := strings.ToLower(fileExtension(filename))

	// ── BLOQUEIO: servidor retornou tipo incompatível ─────────────
	//
	// Se o job esperava um binário (.iso, .mp4, .zip, etc.) mas o servidor
	// retornou text/html ou text/xml com HTTP 200, é uma página de
	// login/erro mascarada — NÃO repassar ao IDM.
	//
	// Ler os primeiros 512 bytes do body para confirmar se é realmente
	// HTML (evitar falso positivo em servidores que declaram tipo errado).

	isTextResponse := strings.Contains(ct, "text/html") ||
		strings.Contains(ct, "text/xml") ||
		strings.Contains(ct, "application/xhtml")

	isBinaryExpected := isBinaryExtension(expectedExt)

	if isTextResponse && isBinaryExpected && resp.StatusCode < 400 {
		// Ler amostra para confirmar que é HTML de verdade
		sample := make([]byte, 512)
		n, _ := io.ReadFull(resp.Body, sample)
		snippet := strings.ToLower(string(sample[:n]))

		looksLikeHTML := strings.Contains(snippet, "<html") ||
			strings.Contains(snippet, "<!doctype") ||
			strings.Contains(snippet, "<head") ||
			strings.Contains(snippet, "<body")

		if looksLikeHTML || n < 100 {
			// É HTML de verdade — bloquear e logar claramente
			log.Printf("[PROXY] ✗ BLOQUEADO: esperava %s (%s) mas servidor retornou %s (HTTP %d)\n",
				filename, expectedExt, ct, resp.StatusCode)
			log.Printf("[PROXY]   URL: %s\n", job.URL)
			log.Printf("[PROXY]   Causa provável: sessão expirada, cookies insuficientes ou URL inválida.\n")
			log.Printf("[PROXY]   Amostra recebida: %.120s\n", snippet)

			// Retornar 421 (Misdirected Request) ao IDM — ele exibe erro sem salvar nada
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusMisdirectedRequest) // 421
			fmt.Fprintf(w,
				"IDM Bridge: download bloqueado.\n\n"+
					"Arquivo esperado : %s (%s)\n"+
					"Tipo recebido    : %s\n"+
					"HTTP Status      : %d\n"+
					"URL              : %s\n\n"+
					"O servidor retornou uma página HTML em vez do arquivo binário.\n"+
					"Causa provável   : sessão expirada ou cookies insuficientes.\n"+
					"Solução          : faça login novamente no site e tente o download outra vez.",
				filename, expectedExt, ct, resp.StatusCode, job.URL,
			)
			return
		}

		// Não parece HTML — pode ser um arquivo com Content-Type errado declarado pelo servidor.
		// Prosseguir com stream, mas logar aviso.
		log.Printf("[PROXY] ⚠ Content-Type declarado como %s mas body não parece HTML — prosseguindo.\n", ct)

		// Montar leitor que devolve os bytes já lidos + o resto do body
		resp.Body = io.NopCloser(io.MultiReader(
			strings.NewReader(string(sample[:n])),
			resp.Body,
		))
	}

	// ── Filename e Content-Disposition garantidos ─────────────────
	//
	// Usar sempre o filename original do job (com extensão correta),
	// pois o tipo da resposta já foi validado acima.

	serverDisp := resp.Header.Get("Content-Disposition")
	if serverDisp == "" {
		w.Header().Set("Content-Disposition",
			fmt.Sprintf(`attachment; filename="%s"`, sanitizeFilename(filename)))
	} else {
		w.Header().Set("Content-Disposition",
			rewriteDispositionFilename(serverDisp, filename))
	}

	// ── Content-Type: se veio vago, inferir pelo filename ────────
	if ct == "" || ct == "application/octet-stream" {
		if inferred := mimeByExtension(filename); inferred != "" {
			w.Header().Set("Content-Type", inferred)
		}
	}

	log.Printf("[PROXY] ✓ Entregando ao IDM: %s | Tipo: %s | HTTP %d\n",
		filename, ct, resp.StatusCode)

	// ── Copiar headers da resposta original ──────────────────

	skipHeaders := map[string]bool{
		"Content-Encoding": true, // já pedimos identity, não deve vir comprimido
		"Transfer-Encoding": true, // Go cuida disso
	}

	for k, vv := range resp.Header {
		if skipHeaders[k] {
			continue
		}
		for _, v := range vv {
			w.Header().Add(k, v)
		}
	}

	w.WriteHeader(resp.StatusCode)

	// ── Stream do arquivo para o IDM ─────────────────────────

	buf := make([]byte, 128*1024) // 128KB por chunk — bom equilíbrio velocidade/memória
	written, err := io.CopyBuffer(w, resp.Body, buf)
	if err != nil && l.verbose {
		log.Printf("[PROXY] Stream interrompido após %d bytes: %v\n", written, err)
	} else {
		log.Printf("[PROXY] ✓ %d bytes transmitidos para o IDM | %s\n", written, filenameFromURL(job.URL))
	}
}

// ─────────────────────────────────────────────────────────────
// Launch — registra job e lança IDM
// ─────────────────────────────────────────────────────────────

func (l *Launcher) Launch(job DownloadJob) (string, error) {
	jobID := uuid.New().String()[:8]

	// Registrar job no mapa para o proxy reverso usar
	l.mu.Lock()
	l.jobs[jobID] = &jobEntry{job: job, createdAt: time.Now()}
	l.mu.Unlock()

	// URL que o IDM vai acessar — aponta para nosso proxy reverso
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d/%s", l.proxyPort, jobID)

	if l.verbose {
		log.Printf("[IDM:%s] URL real: %s\n", jobID, job.URL)
		log.Printf("[IDM:%s] URL proxy: %s\n", jobID, proxyURL)
	}

	// Lançar IDM apontando para o proxy (não para a URL real)
	if err := l.launchIDM(proxyURL, job, jobID); err != nil {
		l.mu.Lock()
		delete(l.jobs, jobID)
		l.mu.Unlock()
		return "", err
	}

	return jobID, nil
}

// launchIDM lança o IDM com a URL do proxy e os parâmetros corretos.
func (l *Launcher) launchIDM(proxyURL string, job DownloadJob, jobID string) error {
	args := []string{
		l.idmPath,
		"/d", proxyURL, // aponta para o proxy reverso, não para a URL real
		"/n",           // sem diálogo de confirmação
	}

	// Nome do arquivo — usar o original para o IDM salvar com o nome certo
	if job.Filename != "" {
		args = append(args, "/p", job.Filename)
	}

	if l.verbose {
		log.Printf("[IDM:%s] Lançando: wine %s\n", jobID, strings.Join(args, " "))
	}

	cmd := exec.Command(l.wineBin, args...)
	cmd.Env = l.buildEnv()

	if l.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("falha ao iniciar IDM via Wine: %w", err)
	}

	go func() {
		if err := cmd.Wait(); err != nil && l.verbose {
			log.Printf("[IDM:%s] Processo encerrado: %v\n", jobID, err)
		}
	}()

	return nil
}

// buildEnv constrói variáveis de ambiente para o Wine (sem dados sensíveis).
func (l *Launcher) buildEnv() []string {
	env := os.Environ()
	env = append(env,
		fmt.Sprintf("WINEPREFIX=%s", l.winePrefix),
		"WINEDEBUG=-all",    // suprimir output de debug do Wine
		"DISPLAY=:0",        // garantir display X11
	)
	return env
}

// cleanupLoop remove jobs expirados do mapa (após 2 horas).
func (l *Launcher) cleanupLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-2 * time.Hour)
		l.mu.Lock()
		for token, entry := range l.jobs {
			if entry.createdAt.Before(cutoff) {
				delete(l.jobs, token)
				if l.verbose {
					log.Printf("[PROXY] Job expirado removido: %s\n", token)
				}
			}
		}
		l.mu.Unlock()
	}
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

func linuxToWinePath(linuxPath, winePrefix string) string {
	driveC := filepath.Join(winePrefix, "drive_c")
	rel := strings.TrimPrefix(linuxPath, driveC)
	rel = strings.ReplaceAll(rel, "/", "\\")
	return "C:" + rel
}

func findWine() (string, error) {
	candidates := []string{"wine", "wine64", "/usr/bin/wine", "/usr/local/bin/wine"}
	for _, c := range candidates {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("wine não encontrado. Instale com: sudo apt install wine")
}

// ProxyPort retorna a porta do proxy reverso embutido.
func (l *Launcher) ProxyPort() int {
	return l.proxyPort
}

// urlDomain extrai o domínio de uma URL para logging.
func urlDomain(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return u.Host
}

// filenameFromURL extrai o nome do arquivo a partir de uma URL.
func filenameFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			name, _ := url.PathUnescape(parts[i])
			// Remover parâmetros que possam ter ficado no nome
			name = strings.SplitN(name, "?", 2)[0]
			return name
		}
	}
	return ""
}

// sanitizeFilename remove caracteres inválidos do nome do arquivo.
func sanitizeFilename(name string) string {
	replacer := strings.NewReplacer(
		`"`, "", `\`, "", `/`, "", `:`, "",
		`*`, "", `?`, "", `<`, "", `>`, "", `|`, "",
	)
	name = replacer.Replace(name)
	name = strings.TrimSpace(name)
	if len(name) > 200 {
		ext := ""
		if idx := strings.LastIndex(name, "."); idx > 0 {
			ext = name[idx:]
		}
		name = name[:200-len(ext)] + ext
	}
	return name
}

// isBinaryExtension retorna true se a extensão corresponde a um arquivo binário
// que nunca deveria ser entregue como text/html.
func isBinaryExtension(ext string) bool {
	binaryExts := map[string]bool{
		".iso": true, ".img": true, ".bin": true,
		".zip": true, ".rar": true, ".7z": true, ".tar": true,
		".gz": true, ".bz2": true, ".xz": true, ".zst": true,
		".mp4": true, ".mkv": true, ".avi": true, ".mov": true,
		".wmv": true, ".flv": true, ".webm": true, ".m4v": true,
		".mp3": true, ".flac": true, ".wav": true, ".aac": true,
		".ogg": true, ".m4a": true, ".opus": true,
		".exe": true, ".msi": true, ".deb": true, ".rpm": true,
		".apk": true, ".dmg": true, ".pkg": true,
		".pdf": true, ".docx": true, ".xlsx": true, ".pptx": true,
		".torrent": true,
	}
	return binaryExts[ext]
}

// mimeByExtension retorna o MIME type baseado na extensão do arquivo.
func mimeByExtension(filename string) string {
	if filename == "" {
		return ""
	}
	ext := strings.ToLower(fileExtension(filename))
	mimes := map[string]string{
		".mp4": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
		".mov": "video/quicktime", ".wmv": "video/x-ms-wmv", ".flv": "video/x-flv",
		".webm": "video/webm", ".m4v": "video/x-m4v", ".ts": "video/mp2t",
		".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
		".aac": "audio/aac", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".opus": "audio/opus",
		".zip": "application/zip", ".rar": "application/x-rar-compressed",
		".7z": "application/x-7z-compressed", ".tar": "application/x-tar",
		".gz": "application/gzip", ".bz2": "application/x-bzip2", ".xz": "application/x-xz",
		".pdf": "application/pdf",
		".doc": "application/msword",
		".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls": "application/vnd.ms-excel",
		".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt": "application/vnd.ms-powerpoint",
		".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		".exe": "application/x-msdownload", ".msi": "application/x-msi",
		".deb": "application/vnd.debian.binary-package", ".rpm": "application/x-rpm",
		".apk": "application/vnd.android.package-archive",
		".iso": "application/x-iso9660-image", ".dmg": "application/x-apple-diskimage",
		".torrent": "application/x-bittorrent",
		".html": "text/html", ".htm": "text/html",
		".json": "application/json", ".xml": "text/xml", ".csv": "text/csv",
	}
	if mime, ok := mimes[ext]; ok {
		return mime
	}
	return "application/octet-stream"
}

// extByMimeType retorna a extensão canônica para um MIME type.
// É o inverso de mimeByExtension.
func extByMimeType(mime string) string {
	mime = strings.ToLower(strings.TrimSpace(mime))
	mimes := map[string]string{
		"video/mp4": ".mp4", "video/x-matroska": ".mkv", "video/x-msvideo": ".avi",
		"video/quicktime": ".mov", "video/x-ms-wmv": ".wmv", "video/x-flv": ".flv",
		"video/webm": ".webm", "video/mp2t": ".ts", "video/x-m4v": ".m4v",
		"audio/mpeg": ".mp3", "audio/flac": ".flac", "audio/wav": ".wav",
		"audio/aac": ".aac", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/opus": ".opus",
		"application/zip": ".zip", "application/x-rar-compressed": ".rar",
		"application/x-7z-compressed": ".7z", "application/x-tar": ".tar",
		"application/gzip": ".gz", "application/x-bzip2": ".bz2", "application/x-xz": ".xz",
		"application/pdf": ".pdf",
		"application/msword": ".doc",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
		"application/vnd.ms-excel": ".xls",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
		"application/vnd.ms-powerpoint": ".ppt",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
		"application/x-msdownload": ".exe", "application/x-msi": ".msi",
		"application/vnd.debian.binary-package": ".deb", "application/x-rpm": ".rpm",
		"application/vnd.android.package-archive": ".apk",
		"application/x-iso9660-image": ".iso", "application/x-apple-diskimage": ".dmg",
		"application/x-bittorrent": ".torrent",
		// Tipos de texto — serão renomeados para a extensão correta
		"text/html": ".html", "text/xml": ".xml", "text/plain": ".txt",
		"text/csv": ".csv", "application/json": ".json",
		// octet-stream é genérico — não forçar extensão, deixar a atual
		"application/octet-stream": "",
	}
	if ext, ok := mimes[mime]; ok {
		return ext
	}
	// Para video/* e audio/* genéricos, retornar extensão base
	if strings.HasPrefix(mime, "video/") {
		return ".video"
	}
	if strings.HasPrefix(mime, "audio/") {
		return ".audio"
	}
	return ""
}

// fileExtension retorna a extensão de um filename incluindo o ponto (ex: ".iso").
// Retorna "" se não houver extensão.
func fileExtension(filename string) string {
	// Pegar apenas o basename (sem diretório)
	base := filepath.Base(filename)
	// Ignorar arquivos que começam com ponto (arquivos ocultos Unix)
	if strings.HasPrefix(base, ".") && strings.Count(base, ".") == 1 {
		return ""
	}
	idx := strings.LastIndex(base, ".")
	if idx <= 0 {
		return ""
	}
	return base[idx:]
}

// rewriteDispositionFilename substitui o filename dentro de um header Content-Disposition.
func rewriteDispositionFilename(disp, newFilename string) string {
	// Remover filename= e filename*= existentes
	re := `filename\*?=(?:UTF-8'')?["']?[^"';\r\n]+["']?`
	// Substituição simples sem regex — percorrer partes separadas por ;
	parts := strings.Split(disp, ";")
	var kept []string
	for _, p := range parts {
		trimmed := strings.TrimSpace(strings.ToLower(p))
		if strings.HasPrefix(trimmed, "filename") {
			continue // remover filename antigo
		}
		kept = append(kept, p)
	}
	_ = re // evitar erro de import não usado
	result := strings.Join(kept, ";")
	if !strings.HasPrefix(strings.TrimSpace(strings.ToLower(result)), "attachment") {
		result = "attachment;" + result
	}
	return result + fmt.Sprintf(` filename="%s"`, sanitizeFilename(newFilename))
}
