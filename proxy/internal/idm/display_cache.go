package idm

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Detecção do servidor gráfico — com cache persistente
//
// PROBLEMA
// ─────────
// Quando o bridge inicia via systemd (sem sessão gráfica ativa), as variáveis
// WAYLAND_DISPLAY, XDG_SESSION_TYPE e DISPLAY estão vazias ou incorretas.
// Isso fazia o bridge detectar X11 mesmo em sessões Wayland, obrigando a
// um restart manual para corrigir.
//
// SOLUÇÃO
// ────────
// Cache em ~/.config/idm-bridge/display-server.conf que persiste a última
// detecção bem-sucedida. Na inicialização:
//   1. Tentar detectar ao vivo (funciona quando há sessão gráfica).
//   2. Se a detecção ao vivo retornar algo confiável → salvar no cache e usar.
//   3. Se não → carregar do cache (detecção da última sessão conhecida).
//
// O cache é invalidado automaticamente quando a detecção ao vivo retornar
// um resultado DIFERENTE do cache (ex: usuário mudou de X11 para Wayland).
// Isso garante que a mudança de servidor gráfico seja detectada na próxima
// inicialização com sessão ativa.
// ─────────────────────────────────────────────────────────────────────────────

// displayCachePath retorna o caminho do arquivo de cache do servidor gráfico.
func displayCachePath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "idm-bridge", "display-server.conf")
}

// saveDisplayCache persiste o servidor gráfico e valor de display detectados.
// Formato do arquivo (simples, legível):
//
//	server=wayland
//	display=wayland-0
//	xdisplay=:0
func saveDisplayCache(ds DisplayServer, display, xdisplay string) {
	path := displayCachePath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return
	}
	// Incluir timestamp da última detecção confirmada.
	// watchDisplayServer usa isso para saber quando o cache foi gerado
	// com sessão gráfica ativa (ts não-zero = detectado ao vivo).
	content := fmt.Sprintf("server=%s\ndisplay=%s\nxdisplay=%s\nts=%d\n",
		ds.String(), display, xdisplay, time.Now().Unix())
	_ = os.WriteFile(path, []byte(content), 0644)
	log.Printf("[DISPLAY] Cache salvo: server=%s display=%s xdisplay=%s\n",
		ds.String(), display, xdisplay)
}

// loadDisplayCache lê o cache persistido. Retorna DisplayUnknown se não existir.
func loadDisplayCache() (ds DisplayServer, display, xdisplay string) {
	data, err := os.ReadFile(displayCachePath())
	if err != nil {
		return DisplayUnknown, "", ""
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	vals := map[string]string{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if idx := strings.IndexByte(line, '='); idx > 0 {
			vals[line[:idx]] = line[idx+1:]
		}
	}
	switch strings.ToLower(vals["server"]) {
	case "wayland":
		ds = DisplayWayland
	case "x11":
		ds = DisplayX11
	default:
		return DisplayUnknown, "", ""
	}
	return ds, vals["display"], vals["xdisplay"]
}
