package idm

import (
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
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
	HlsKeys    []map[string]string
	// Campos de qualidade YouTube
	AudioUrl    string // URL direta do stream de áudio DASH para mux direto
	Itag        string // itag do stream de vídeo selecionado (ex: "313")
	AudioItag   string // itag do stream de áudio a mergear (ex: "140")
	Height      int    // altura em pixels (ex: 2160)
	NeedsMerge  bool   // true = vídeo adaptativo YT, precisa merge com áudio
	VideoID     string // ID do vídeo YouTube para o yt-dlp
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
	display       string // valor de WAYLAND_DISPLAY quando Wayland, ou DISPLAY quando X11
	xdisplay      string // valor de DISPLAY (XWayland) — usado pelo Wine em sessões Wayland

	proxyPort   int
	proxyServer *http.Server

	// restartCh recebe o sinal quando o bridge deve se reiniciar devido a
	// mudança de servidor gráfico detectada no logon.
	// Envia o DisplayServer novo para que o main.go possa logar o motivo.
	restartCh chan DisplayServer

	// loginWatchActive evita múltiplos goroutines de monitoramento de logon.
	loginWatchActive bool

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
