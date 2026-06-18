package idm

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// NewLauncher
// ─────────────────────────────────────────────────────────────────────────────

func NewLauncher(winePrefix, idmPath string, verbose bool) (*Launcher, error) {
	wineBin, err := findWine()
	if err != nil {
		return nil, err
	}

	// detectDisplayServer retorna os 3 valores necessários:
	//   ds       = DisplayWayland ou DisplayX11
	//   display  = WAYLAND_DISPLAY ou DISPLAY conforme o servidor
	//   xdisplay = DISPLAY do XWayland, necessário para o Wine em sessões Wayland
	// Não usamos os.Getenv("DISPLAY") pois o bridge pode ter sido iniciado
	// via systemd/cron antes da sessão gráfica, sem herdar as variáveis de ambiente.
	ds, display, xdisplay := detectDisplayServer()

	// Transport compartilhado: connection pooling + sem auto-descompressão.
	// MaxIdleConnsPerHost alto para HLS (muitos segmentos para o mesmo CDN).
	transport := &http.Transport{
		// Desabilitar descompressão automática — o Go remove Content-Encoding
		// mas não ajusta Content-Length, causando divergência que o IDM detecta.
		// Com DisableCompression:true, o stream passa byte-a-byte sem modificação.
		DisableCompression: true,
		// Connection pooling agressivo para HLS (centenas de segmentos)
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 20,
		IdleConnTimeout:     60 * time.Second,
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
		xdisplay:      xdisplay,
		jobs:          make(map[string]*jobEntry),
		httpTransport: transport,
		restartCh:     make(chan DisplayServer, 1),
	}

	if err := l.startReverseProxy(); err != nil {
		return nil, fmt.Errorf("falha ao iniciar proxy reverso: %w", err)
	}

	go l.cleanupLoop()
	go l.watchDisplayServer()
	go l.watchLoginEvent() // detecta sessão gráfica quando bridge sobe antes da GUI

	log.Printf("[LAUNCHER] Servidor gráfico: %s | Display: %s | XDisplay: %s\n",
		ds, display, xdisplay)
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
