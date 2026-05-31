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
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

// DisplayServer representa o servidor gráfico em uso no sistema.
type DisplayServer int

const (
	DisplayUnknown DisplayServer = iota
	DisplayX11
	DisplayWayland
)

func (d DisplayServer) String() string {
	switch d {
	case DisplayX11:
		return "X11"
	case DisplayWayland:
		return "Wayland"
	default:
		return "desconhecido"
	}
}

// FileCategory mapeia extensões de arquivo para as categorias padrão do IDM.
type FileCategory struct {
	Name    string // nome da categoria no IDM
	Folder  string // subpasta sugerida (usada no /p flag)
}

// DownloadJob representa um trabalho de download a ser enviado ao IDM.
type DownloadJob struct {
	URL       string
	Filename  string
	Cookies   string
	Referrer  string
	UserAgent string
	Headers   map[string]string
	// Silent: false (padrão) = abre janela IDM para confirmar/editar
	//         true           = inicia download direto sem interação
	Silent bool
	// RequestType: "stream" (vídeo/áudio embutido) ou "download" (arquivo direto).
	// Determina quais Sec-Fetch-* e Accept headers o proxy usa.
	//   "stream":   Sec-Fetch-Mode: no-cors, Sec-Fetch-Site: cross-site
	//               Accept: */* (sem navigate — CDN rejeita navigate em streams)
	//   "download": Sec-Fetch-Mode: navigate, Sec-Fetch-User: ?1
	//               Accept: */* com Upgrade-Insecure-Requests: 1
	RequestType string
	// MediaOrigin: Origin do CDN de mídia (ex: "https://cf-media.hotmart.com").
	// CDNs de vídeo (Cloudflare Stream, Akamai, Vimeo) validam este header
	// contra a lista de domínios permitidos — sem ele retornam 403.
	MediaOrigin string
	HlsKeys []map[string]string
}

// jobEntry armazena o job enquanto o IDM faz a requisição ao proxy.
type jobEntry struct {
	job       DownloadJob
	createdAt time.Time
}

// Launcher gerencia o ambiente Wine, o proxy reverso e o lançamento do IDM.
type Launcher struct {
	winePrefix    string
	idmPath       string
	wineBin       string
	verbose       bool
	displayServer DisplayServer
	display       string // valor de DISPLAY ou WAYLAND_DISPLAY

	proxyPort   int
	proxyServer *http.Server

	mu   sync.RWMutex
	jobs map[string]*jobEntry

	// httpTransport é compartilhado entre todos os requests do proxy.
	// Compartilhar o Transport é crítico para:
	//   1. Reutilização de conexões TCP/TLS (connection pooling) — sem isso,
	//      cada segmento HLS abre um novo handshake TCP+TLS, causando rate
	//      limiting e "connection refused" em CDNs com limite por IP.
	//   2. DisableCompression:true — sem isso, o Go descomprime gzip
	//      automaticamente mas não ajusta Content-Length. O IDM recebe
	//      Content-Length prometendo N bytes comprimidos mas recebe M bytes
	//      descomprimidos → detecta divergência → fecha conexão → 502.
	httpTransport *http.Transport
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeamento de categorias de arquivo (extensão → categoria IDM)
// ─────────────────────────────────────────────────────────────────────────────

var categoryMap = map[string]FileCategory{
	// Vídeos
	".mp4":  {"Videos", "Videos"}, ".mkv": {"Videos", "Videos"},
	".avi":  {"Videos", "Videos"}, ".mov": {"Videos", "Videos"},
	".wmv":  {"Videos", "Videos"}, ".flv": {"Videos", "Videos"},
	".webm": {"Videos", "Videos"}, ".m4v": {"Videos", "Videos"},
	".ts":   {"Videos", "Videos"}, ".mpeg": {"Videos", "Videos"},
	".mpg":  {"Videos", "Videos"}, ".3gp": {"Videos", "Videos"},
	".m3u8": {"Videos", "Videos"}, ".f4v": {"Videos", "Videos"},

	// Músicas
	".mp3":  {"Music", "Music"}, ".ogg": {"Music", "Music"},
	".flac": {"Music", "Music"}, ".wav": {"Music", "Music"},
	".aac":  {"Music", "Music"}, ".m4a": {"Music", "Music"},
	".opus": {"Music", "Music"}, ".wma": {"Music", "Music"},
	".mid":  {"Music", "Music"}, ".midi": {"Music", "Music"},

	// Documentos
	".pdf":  {"Documents", "Documents"}, ".doc": {"Documents", "Documents"},
	".docx": {"Documents", "Documents"}, ".xls": {"Documents", "Documents"},
	".xlsx": {"Documents", "Documents"}, ".ppt": {"Documents", "Documents"},
	".pptx": {"Documents", "Documents"}, ".txt": {"Documents", "Documents"},
	".odt":  {"Documents", "Documents"}, ".rtf": {"Documents", "Documents"},
	".csv":  {"Documents", "Documents"}, ".epub": {"Documents", "Documents"},
	".mobi": {"Documents", "Documents"}, ".djvu": {"Documents", "Documents"},

	// Programas / Instaladores
	".exe":     {"Programs", "Programs"}, ".msi": {"Programs", "Programs"},
	".deb":     {"Programs", "Programs"}, ".rpm": {"Programs", "Programs"},
	".apk":     {"Programs", "Programs"}, ".dmg": {"Programs", "Programs"},
	".pkg":     {"Programs", "Programs"}, ".appimage": {"Programs", "Programs"},
	".flatpak": {"Programs", "Programs"}, ".snap": {"Programs", "Programs"},
	".crx":     {"Programs", "Programs"}, ".xpi": {"Programs", "Programs"},

	// Compactados
	".zip": {"Compressed", "Compressed"}, ".rar": {"Compressed", "Compressed"},
	".7z":  {"Compressed", "Compressed"}, ".tar": {"Compressed", "Compressed"},
	".gz":  {"Compressed", "Compressed"}, ".bz2": {"Compressed", "Compressed"},
	".xz":  {"Compressed", "Compressed"}, ".zst": {"Compressed", "Compressed"},
	".iso": {"Compressed", "Compressed"}, ".img": {"Compressed", "Compressed"},
	".z":   {"Compressed", "Compressed"}, ".lz":  {"Compressed", "Compressed"},
	".cab": {"Compressed", "Compressed"}, ".arj": {"Compressed", "Compressed"},

	// Torrents (tratamento especial)
	".torrent": {"Torrents", "Torrents"},
}

// categoryOf retorna a categoria IDM para um nome de arquivo.
// Se não reconhecida, retorna a categoria General.
func categoryOf(filename string) FileCategory {
	ext := strings.ToLower(filepath.Ext(filename))
	if cat, ok := categoryMap[ext]; ok {
		return cat
	}
	return FileCategory{"General", "General"}
}

// ─────────────────────────────────────────────────────────────────────────────
// Detecção do servidor gráfico
// ─────────────────────────────────────────────────────────────────────────────

// detectDisplayServer determina qual servidor gráfico está em uso e retorna
// o DisplayServer ativo junto com o valor da variável de display correspondente.
//
// Prioridade:
//  1. Se WAYLAND_DISPLAY estiver definido e o socket existir → Wayland
//  2. Se XDG_SESSION_TYPE == "wayland" → Wayland
//  3. Se DISPLAY estiver definido → X11
//  4. Fallback: tentar :0 (X11)
func detectDisplayServer() (DisplayServer, string) {
	// ── Verificar Wayland ────────────────────────────────────────
	wdisplay := os.Getenv("WAYLAND_DISPLAY")
	if wdisplay == "" {
		wdisplay = "wayland-0" // padrão do Wayland
	}

	// Verificar se o socket Wayland existe
	xdgRuntime := os.Getenv("XDG_RUNTIME_DIR")
	if xdgRuntime == "" {
		xdgRuntime = fmt.Sprintf("/run/user/%d", os.Getuid())
	}

	waylandSocket := filepath.Join(xdgRuntime, wdisplay)
	waylandOk := false
	if _, err := os.Stat(waylandSocket); err == nil {
		waylandOk = true
	}

	// XDG_SESSION_TYPE pode indicar Wayland mesmo sem socket visível
	sessionType := strings.ToLower(os.Getenv("XDG_SESSION_TYPE"))
	if sessionType == "wayland" {
		waylandOk = true
	}

	// ── Verificar X11 ────────────────────────────────────────────
	xdisplay := os.Getenv("DISPLAY")
	x11Ok := xdisplay != ""

	// ── Decidir qual usar ────────────────────────────────────────
	// Se ambos disponíveis, preferir o padrão da sessão atual.
	// XDG_SESSION_TYPE é a fonte mais confiável.
	if waylandOk && x11Ok {
		if sessionType == "x11" {
			log.Printf("[DISPLAY] Ambos disponíveis, sessão é X11 → usando X11 (%s)\n", xdisplay)
			return DisplayX11, xdisplay
		}
		// Padrão: preferir Wayland quando disponível
		log.Printf("[DISPLAY] Ambos disponíveis, preferindo Wayland (%s)\n", wdisplay)
		return DisplayWayland, wdisplay
	}

	if waylandOk {
		log.Printf("[DISPLAY] Wayland detectado (%s)\n", wdisplay)
		return DisplayWayland, wdisplay
	}

	if x11Ok {
		log.Printf("[DISPLAY] X11 detectado (%s)\n", xdisplay)
		return DisplayX11, xdisplay
	}

	// Fallback: tentar :0 (sessão X11 sem DISPLAY exportado)
	log.Printf("[DISPLAY] Nenhum servidor detectado, usando fallback DISPLAY=:0\n")
	return DisplayX11, ":0"
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificar se IDM já está rodando
// ─────────────────────────────────────────────────────────────────────────────

// isIDMRunning verifica se já existe um processo IDMan.exe rodando no Wine.
// Se sim, não precisamos criar uma nova instância — apenas enviar a URL.
func isIDMRunning() bool {
	// Verificar via wineserver/processos Wine ativos
	candidates := [][]string{
		{"pgrep", "-fi", "IDMan.exe"},
		{"pgrep", "-fi", "idman.exe"},
		{"pidof", "IDMan.exe"},
	}
	for _, args := range candidates {
		cmd := exec.Command(args[0], args[1:]...)
		if out, err := cmd.Output(); err == nil && len(strings.TrimSpace(string(out))) > 0 {
			return true
		}
	}
	// Verificar via winedbg/wineserver
	cmd := exec.Command("wineserver", "-l")
	if out, err := cmd.Output(); err == nil {
		return strings.Contains(strings.ToLower(string(out)), "idman")
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────────────
// NewLauncher
// ─────────────────────────────────────────────────────────────────────────────

func NewLauncher(winePrefix, idmPath string, verbose bool) (*Launcher, error) {
	wineBin, err := findWine()
	if err != nil {
		return nil, err
	}

	ds, display := detectDisplayServer()

	// Transport compartilhado: connection pooling + sem auto-descompressão.
	// MaxIdleConnsPerHost alto para HLS (muitos segmentos para o mesmo CDN).
	transport := &http.Transport{
		// Desabilitar descompressão automática — o Go remove Content-Encoding
		// mas não ajusta Content-Length, causando divergência que o IDM detecta.
		// Com DisableCompression:true, o stream passa byte-a-byte sem modificação.
		DisableCompression: true,
		// Connection pooling agressivo para HLS (centenas de segmentos)
		MaxIdleConns:        200,
		MaxIdleConnsPerHost: 50,
		IdleConnTimeout:     90 * time.Second,
		// Timeouts de conexão — sem deadline de leitura (stream pode ser lento)
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}

	l := &Launcher{
		winePrefix:    winePrefix,
		idmPath:       idmPath,
		wineBin:       wineBin,
		verbose:       verbose,
		displayServer: ds,
		display:       display,
		jobs:          make(map[string]*jobEntry),
		httpTransport: transport,
	}

	if err := l.startReverseProxy(); err != nil {
		return nil, fmt.Errorf("falha ao iniciar proxy reverso: %w", err)
	}

	go l.cleanupLoop()

	log.Printf("[LAUNCHER] Servidor gráfico: %s | Display: %s\n", ds, display)
	return l, nil
}

// IsIDMAvailable verifica se o IDMan.exe existe no prefixo Wine.
func (l *Launcher) IsIDMAvailable() bool {
	_, err := os.Stat(l.idmPath)
	return err == nil
}

// ProxyPort retorna a porta do proxy reverso embutido.
func (l *Launcher) ProxyPort() int {
	return l.proxyPort
}

// ─────────────────────────────────────────────────────────────────────────────
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
		log.Printf("[PROXY:%s] %s\n", jobID, targetURL)
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

	// ── Streaming direto para arquivos e segmentos ────────────────────────────
	// PROBLEMA ANTERIOR: io.ReadAll() carregava o arquivo inteiro na RAM antes
	// de escrever. Para vídeos de 1-2GB isso causava OOM ou timeout → 502.
	// SOLUÇÃO: io.Copy() faz streaming direto CDN → IDM com buffer fixo de 256KB,
	// sem carregar nada na memória. Content-Length e headers são passados
	// diretamente do CDN sem recálculo.
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

	switch {
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

	if job.Cookies != "" {
		req.Header.Set("Cookie", job.Cookies)
	}
	if job.Referrer != "" {
		req.Header.Set("Referer", job.Referrer)
	}

	// Origin — crítico para CDNs de vídeo (Cloudflare Stream, Akamai, Vimeo):
	//   Segmento/stream: usar MediaOrigin (domínio do CDN) se disponível,
	//                    senão derivar do Referer da página original.
	//   Download direto: derivar do Referer.
	if job.MediaOrigin != "" {
		req.Header.Set("Origin", job.MediaOrigin)
	} else if job.Referrer != "" {
		if u, err := url.Parse(job.Referrer); err == nil {
			req.Header.Set("Origin", fmt.Sprintf("%s://%s", u.Scheme, u.Host))
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
	} else {
		log.Printf("[PROXY] ✓ %d HTTP %d | %d bytes | %s\n",
			resp.StatusCode, resp.StatusCode, written, filename)
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

// ─────────────────────────────────────────────────────────────────────────────
// Launch — registra job e lança IDM
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) Launch(job DownloadJob) (string, error) {
	jobID := uuid.New().String()[:8]

	l.mu.Lock()
	l.jobs[jobID] = &jobEntry{job: job, createdAt: time.Now()}
	l.mu.Unlock()

	proxyURL := fmt.Sprintf("http://127.0.0.1:%d/%s", l.proxyPort, jobID)

	if l.verbose {
		log.Printf("[IDM:%s] URL real:  %s\n", jobID, job.URL)
		log.Printf("[IDM:%s] URL proxy: %s\n", jobID, proxyURL)
	}

	if err := l.launchIDM(proxyURL, job, jobID); err != nil {
		l.mu.Lock()
		delete(l.jobs, jobID)
		l.mu.Unlock()
		return "", err
	}

	return jobID, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// launchIDM — orquestra o lançamento do IDM
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) launchIDM(proxyURL string, job DownloadJob, jobID string) error {
	// Detectar categoria e compor nome de arquivo adequado
	filename := job.Filename
	if filename == "" {
		filename = filenameFromURL(job.URL)
	}
	cat := categoryOf(filename)

	// ── Verificar se IDM já está rodando ────────────────────────
	// Se sim, apenas enviar a URL — o IDM existente abre a janela de download.
	// Se não, iniciar uma nova instância.
	alreadyRunning := isIDMRunning()

	args := []string{l.idmPath, "/d", proxyURL}

	if job.Silent {
		args = append(args, "/n") // sem janela de confirmação
	}
	// /n ausente → IDM abre janela "Download File" com nome/pasta/categoria pré-preenchidos

	// Flags de nome de arquivo do IDM:
	//   /f <nome>  — nome do arquivo (sem caminho)
	//   /p <pasta> — pasta de destino
	//
	// PROBLEMA ANTERIOR: o código usava "/p filename", mas /p é pasta de destino,
	// não nome do arquivo. O IDM interpretava o nome (ex: "Como_baixar.mp4") como
	// um diretório e usava o jobID da URL proxy (ex: "abdaeja6") como nome,
	// resultando em: Como_baixar.mp4bdaeja6
	//
	// CORREÇÃO: usar /f para nome do arquivo.
	// Garantir que filename contenha apenas o nome base, sem barras.
	if filename != "" {
		// filepath.Base remove qualquer caminho acidental que possa ter vindo
		// do título da página ou da URL (ex: "pasta/video.mp4" → "video.mp4")
		baseName := filepath.Base(sanitizeFilename(filename))
		args = append(args, "/f", baseName)
	}

	// Informar a categoria ao IDM via flag /c (seleciona a pasta correta)
	// O IDM usa o nome da categoria para mapear para a pasta configurada
	if cat.Name != "General" {
		args = append(args, "/c", cat.Name)
	}

	if l.verbose {
		mode := "interativo"
		if job.Silent {
			mode = "silencioso"
		}
		log.Printf("[IDM:%s] Arquivo: %s | Categoria: %s | Modo: %s\n", jobID, filename, cat.Name, mode)
		log.Printf("[IDM:%s] IDM já rodando: %v\n", jobID, alreadyRunning)
		log.Printf("[IDM:%s] Comando: wine %s\n", jobID, strings.Join(args, " "))
	}

	cmd := exec.Command(l.wineBin, args...)
	cmd.Env = l.buildEnv(alreadyRunning)

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

// ─────────────────────────────────────────────────────────────────────────────
// buildEnv — variáveis de ambiente para o Wine
// ─────────────────────────────────────────────────────────────────────────────

func (l *Launcher) buildEnv(idmAlreadyRunning bool) []string {
	env := os.Environ()

	// Prefixo Wine
	env = append(env, fmt.Sprintf("WINEPREFIX=%s", l.winePrefix))

	// Silenciar debug do Wine (reduz ruído nos logs)
	env = append(env, "WINEDEBUG=-all")

	// ── Configurar display de acordo com o servidor gráfico ──────
	switch l.displayServer {

	case DisplayWayland:
		// Wine com Wayland: usar XWayland como ponte
		// DISPLAY aponta para o XWayland embutido no compositor Wayland
		xwaylandDisplay := os.Getenv("DISPLAY")
		if xwaylandDisplay == "" {
			// Tentar display comum do XWayland
			xwaylandDisplay = ":0"
		}
		env = append(env,
			fmt.Sprintf("DISPLAY=%s", xwaylandDisplay),
			fmt.Sprintf("WAYLAND_DISPLAY=%s", l.display),
			// Forçar Wine a usar XWayland em vez do backend Wayland nativo
			// (mais estável para aplicações Windows via Wine)
			"WINE_WAYLAND_PREFER_DISPLAY=xwayland",
		)
		log.Printf("[DISPLAY] Wine via XWayland (%s) em sessão Wayland (%s)\n", xwaylandDisplay, l.display)

	case DisplayX11:
		env = append(env, fmt.Sprintf("DISPLAY=%s", l.display))

	default:
		// Fallback: tentar :0
		env = append(env, "DISPLAY=:0")
	}

	// ── Se IDM já está rodando, sinalizar para não reiniciar ─────
	// O Wine/IDM detecta que já há uma instância e apenas envia
	// a URL para a janela principal existente
	if idmAlreadyRunning {
		env = append(env, "IDM_BRIDGE_EXISTING=1")
	}

	// Desabilitar composição desnecessária (melhora desempenho no Wine)
	env = append(env, "WINEDLLOVERRIDES=winemenubuilder.exe=d")

	return env
}

// ─────────────────────────────────────────────────────────────────────────────
// cleanupLoop — remove jobs expirados
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Funções auxiliares
// ─────────────────────────────────────────────────────────────────────────────

func isBinaryExtension(ext string) bool {
	binaryExts := map[string]bool{
		".iso": true, ".img": true, ".bin": true,
		".zip": true, ".rar": true, ".7z":  true, ".tar": true,
		".gz":  true, ".bz2": true, ".xz":  true, ".zst": true,
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

func mimeByExtension(filename string) string {
	ext := strings.ToLower(fileExtension(filename))
	mimes := map[string]string{
		".mp4": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
		".mov": "video/quicktime", ".wmv": "video/x-ms-wmv", ".webm": "video/webm",
		".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
		".aac": "audio/aac", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
		".zip": "application/zip", ".rar": "application/x-rar-compressed",
		".7z":  "application/x-7z-compressed", ".tar": "application/x-tar",
		".gz":  "application/gzip", ".bz2": "application/x-bzip2",
		".pdf": "application/pdf",
		".exe": "application/x-msdownload", ".msi": "application/x-msi",
		".deb": "application/vnd.debian.binary-package", ".rpm": "application/x-rpm",
		".apk": "application/vnd.android.package-archive",
		".iso": "application/x-iso9660-image",
		".torrent": "application/x-bittorrent",
	}
	if m, ok := mimes[ext]; ok {
		return m
	}
	return "application/octet-stream"
}

func filenameFromURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	parts := strings.Split(u.Path, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			name, _ := url.PathUnescape(parts[i])
			return strings.SplitN(name, "?", 2)[0]
		}
	}
	return ""
}

func fileExtension(filename string) string {
	base := filepath.Base(filename)
	if strings.HasPrefix(base, ".") && strings.Count(base, ".") == 1 {
		return ""
	}
	idx := strings.LastIndex(base, ".")
	if idx <= 0 {
		return ""
	}
	return base[idx:]
}

func sanitizeFilename(name string) string {
	r := strings.NewReplacer(`"`, "", `\`, "", `/`, "", `:`, "", `*`, "", `?`, "", `<`, "", `>`, "", `|`, "")
	name = r.Replace(strings.TrimSpace(name))
	if len(name) > 200 {
		ext := fileExtension(name)
		name = name[:200-len(ext)] + ext
	}
	return name
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

