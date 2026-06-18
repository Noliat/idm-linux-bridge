package idm

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// probeDisplayServer faz a detecção ao vivo do servidor gráfico.
//
// Estratégia em camadas (cada camada é mais cara mas cobre casos anteriores):
//
//  1. Variáveis de ambiente (instantâneo — funciona se o processo herdou env da sessão)
//  2. Sockets em XDG_RUNTIME_DIR (funciona mesmo sem env — o socket existe se Wayland está ativo)
//  3. loginctl show-session — consulta o logind para descobrir o tipo da sessão
//     ativa do usuário. Funciona mesmo quando o bridge sobe via systemd sem
//     herdar o ambiente gráfico.
//  4. /proc/<pid>/environ — lê o ambiente do processo da sessão gráfica para
//     extrair WAYLAND_DISPLAY / DISPLAY quando nada mais funcionou.
//
// Retorna (DisplayUnknown, "", "") se não conseguir determinar com confiança.
func probeDisplayServer() (ds DisplayServer, display, xdisplay string) {
	uid  := os.Getuid()
	xdgRuntime := os.Getenv("XDG_RUNTIME_DIR")
	if xdgRuntime == "" {
		xdgRuntime = fmt.Sprintf("/run/user/%d", uid)
	}

	// ── Camada 1: variáveis de ambiente (presentes quando herdado da sessão) ──
	sessionType := strings.ToLower(os.Getenv("XDG_SESSION_TYPE"))
	wdisplayEnv := os.Getenv("WAYLAND_DISPLAY")
	xdispEnv    := os.Getenv("DISPLAY")

	// ── Camada 2: existência do socket Wayland ────────────────────────────────
	// O socket existe independente das variáveis de ambiente.
	// Verificamos wayland-0 e wayland-1 (alguns compositors usam wayland-1).
	waylandDisplay := wdisplayEnv
	if waylandDisplay == "" {
		for _, candidate := range []string{"wayland-0", "wayland-1"} {
			if _, err := os.Stat(filepath.Join(xdgRuntime, candidate)); err == nil {
				waylandDisplay = candidate
				break
			}
		}
	}
	waylandSocket := filepath.Join(xdgRuntime, waylandDisplay)
	waylandOk := waylandDisplay != "" && func() bool {
		_, err := os.Stat(waylandSocket)
		return err == nil
	}()

	// Se XDG_SESSION_TYPE=wayland está no env, confirmar mesmo sem socket
	if sessionType == "wayland" {
		waylandOk = true
		if waylandDisplay == "" {
			waylandDisplay = "wayland-0"
		}
	}

	x11Ok := xdispEnv != ""

	// Resultado rápido se as variáveis estão disponíveis
	if (waylandOk || x11Ok) && sessionType != "" {
		if sessionType == "x11" && x11Ok {
			return DisplayX11, xdispEnv, xdispEnv
		}
		if (sessionType == "wayland" || waylandOk) {
			xd := xdispEnv
			if xd == "" { xd = ":0" }
			return DisplayWayland, waylandDisplay, xd
		}
	}

	// ── Camada 3: loginctl — funciona mesmo sem env gráfico ──────────────────
	// loginctl show-session <ID> -p Type retorna "Type=wayland" ou "Type=x11"
	// Obter sessão do usuário atual: loginctl list-sessions --no-pager
	if lType, lDisplay, lXDisplay := probeViaLoginctl(uid, xdgRuntime, waylandDisplay); lType != DisplayUnknown {
		return lType, lDisplay, lXDisplay
	}

	// ── Camada 4: /proc/<pid>/environ da sessão gráfica ───────────────────────
	// Procurar processo do compositor (mutter, kwin_wayland, sway, weston,
	// gnome-shell, plasmashell) e extrair seu ambiente.
	if pType, pDisplay, pXDisplay := probeViaCompositorEnv(uid, xdgRuntime); pType != DisplayUnknown {
		return pType, pDisplay, pXDisplay
	}

	// Resultado com o que temos mesmo sem sessionType
	if waylandOk {
		xd := xdispEnv
		if xd == "" { xd = ":0" }
		return DisplayWayland, waylandDisplay, xd
	}
	if x11Ok {
		return DisplayX11, xdispEnv, xdispEnv
	}

	return DisplayUnknown, "", ""
}

// probeViaLoginctl consulta o systemd-logind para descobrir o tipo de sessão
// gráfica ativa do usuário, sem depender de variáveis de ambiente.
func probeViaLoginctl(uid int, xdgRuntime, knownWaylandDisplay string) (DisplayServer, string, string) {
	// Listar sessões do usuário atual
	out, err := exec.Command("loginctl", "list-sessions", "--no-pager", "--no-legend").Output()
	if err != nil {
		return DisplayUnknown, "", ""
	}
	uidStr := fmt.Sprintf("%d", uid)
	var sessionIDs []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		fields := strings.Fields(line)
		// Formato: SESSION_ID UID USER SEAT TTY
		if len(fields) >= 2 && fields[1] == uidStr {
			sessionIDs = append(sessionIDs, fields[0])
		}
	}

	for _, sid := range sessionIDs {
		// Obter propriedades da sessão
		props, err := exec.Command("loginctl", "show-session", sid, "--no-pager").Output()
		if err != nil {
			continue
		}
		vals := parseLoginctlProps(string(props))

		sType  := strings.ToLower(vals["Type"])
		state  := strings.ToLower(vals["State"])
		class  := strings.ToLower(vals["Class"])
		active := vals["Active"]

		// Ignorar sessões TTY, inativas, ou não-gráficas
		if class == "greeter" || sType == "tty" || state == "closing" {
			continue
		}
		if active != "yes" && state != "active" && state != "online" {
			continue
		}

		switch sType {
		case "wayland":
			wDisp := knownWaylandDisplay
			if wDisp == "" {
				wDisp = "wayland-0"
			}
			// Confirmar socket
			if _, err := os.Stat(filepath.Join(xdgRuntime, wDisp)); err != nil {
				// Tentar wayland-1
				if _, err2 := os.Stat(filepath.Join(xdgRuntime, "wayland-1")); err2 == nil {
					wDisp = "wayland-1"
				}
			}
			// Tentar obter DISPLAY (XWayland) do ambiente do líder da sessão
			xd := ":0"
			if leader := vals["Leader"]; leader != "" {
				if envMap := readProcEnviron(leader); envMap != nil {
					if d := envMap["DISPLAY"]; d != "" {
						xd = d
					}
				}
			}
			log.Printf("[DISPLAY] loginctl: sessão %s é Wayland (state=%s, display=%s, xdisplay=%s)\n",
				sid, state, wDisp, xd)
			return DisplayWayland, wDisp, xd

		case "x11", "mir":
			xd := ":0"
			if leader := vals["Leader"]; leader != "" {
				if envMap := readProcEnviron(leader); envMap != nil {
					if d := envMap["DISPLAY"]; d != "" {
						xd = d
					}
				}
			}
			log.Printf("[DISPLAY] loginctl: sessão %s é X11 (state=%s, display=%s)\n",
				sid, state, xd)
			return DisplayX11, xd, xd
		}
	}
	return DisplayUnknown, "", ""
}

// parseLoginctlProps converte saída de "loginctl show-session" em mapa key=value.
func parseLoginctlProps(output string) map[string]string {
	m := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		if idx := strings.IndexByte(line, '='); idx > 0 {
			m[line[:idx]] = strings.TrimSpace(line[idx+1:])
		}
	}
	return m
}

// probeViaCompositorEnv procura processos de compositor Wayland ou servidor X11
// no /proc e lê seu ambiente para extrair WAYLAND_DISPLAY / DISPLAY.
func probeViaCompositorEnv(uid int, xdgRuntime string) (DisplayServer, string, string) {
	// Processos de compositor Wayland conhecidos
	waylandCompositors := []string{
		"mutter", "kwin_wayland", "sway", "weston", "gnome-shell",
		"plasmashell", "river", "wayfire", "labwc", "hyprland",
		"xdg-desktop-por", // xdg-desktop-portal (indica sessão Wayland)
	}
	// Servidores X11
	x11Servers := []string{"Xorg", "X", "Xwayland"}

	entries, err := os.ReadDir("/proc")
	if err != nil {
		return DisplayUnknown, "", ""
	}

	uidStr := fmt.Sprintf("%d", uid)

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid := entry.Name()
		if pid == "self" || pid == "thread-self" {
			continue
		}
		// Verificar se é numérico
		allDigit := true
		for _, c := range pid {
			if c < '0' || c > '9' { allDigit = false; break }
		}
		if !allDigit { continue }

		// Verificar se pertence ao uid correto
		statusPath := filepath.Join("/proc", pid, "status")
		statusData, err := os.ReadFile(statusPath)
		if err != nil { continue }
		if !strings.Contains(string(statusData), "Uid:	"+uidStr) { continue }

		// Ler nome do processo
		commPath := filepath.Join("/proc", pid, "comm")
		commData, _ := os.ReadFile(commPath)
		comm := strings.TrimSpace(string(commData))

		// Verificar se é compositor Wayland
		for _, name := range waylandCompositors {
			if strings.HasPrefix(comm, name) || strings.Contains(comm, name) {
				if envMap := readProcEnviron(pid); envMap != nil {
					wDisp := envMap["WAYLAND_DISPLAY"]
					if wDisp == "" { wDisp = "wayland-0" }
					xd := envMap["DISPLAY"]
					if xd == "" { xd = ":0" }
					// Verificar se o socket existe
					if _, err := os.Stat(filepath.Join(xdgRuntime, wDisp)); err == nil {
						log.Printf("[DISPLAY] probeEnv: %s (pid %s) → Wayland (%s, xdisplay=%s)\n",
							comm, pid, wDisp, xd)
						return DisplayWayland, wDisp, xd
					}
				}
				break
			}
		}

		// Verificar se é servidor X11
		for _, name := range x11Servers {
			if comm == name {
				if envMap := readProcEnviron(pid); envMap != nil {
					xd := envMap["DISPLAY"]
					if xd == "" { xd = ":0" }
					log.Printf("[DISPLAY] probeEnv: %s (pid %s) → X11 (%s)\n", comm, pid, xd)
					return DisplayX11, xd, xd
				}
				break
			}
		}
	}
	return DisplayUnknown, "", ""
}

// readProcEnviron lê /proc/<pid>/environ e retorna um mapa de variáveis.
// Retorna nil se o arquivo não puder ser lido (permissão, processo morreu, etc.).
func readProcEnviron(pid string) map[string]string {
	data, err := os.ReadFile(filepath.Join("/proc", pid, "environ"))
	if err != nil {
		return nil
	}
	m := make(map[string]string)
	for _, entry := range strings.Split(string(data), "\x00") {
		if idx := strings.IndexByte(entry, '='); idx > 0 {
			m[entry[:idx]] = entry[idx+1:]
		}
	}
	return m
}

// detectDisplayServer determina o servidor gráfico com cache persistente.
//
// Algoritmo:
//  1. Tentar detecção ao vivo (probeDisplayServer) — inclui loginctl e /proc.
//  2. Se encontrou algo confiável:
//     a. Comparar com cache — se mudou (ex: usuário trocou X11→Wayland), logar.
//     b. Salvar no cache e retornar o resultado ao vivo.
//  3. Se a detecção falhou (bridge subiu antes da sessão gráfica):
//     a. Usar o cache da última sessão conhecida.
//     b. Sem cache: fallback Wayland (mais comum em sistemas modernos).
//     c. Agendar re-sondagem em background — quando a sessão gráfica aparecer
//        (socket Wayland ou DISPLAY disponível), atualizar o Launcher.
// Retorna (DisplayServer, display, xdisplay) onde:
//   display  = WAYLAND_DISPLAY (ex: "wayland-0") ou DISPLAY (ex: ":1") conforme o servidor
//   xdisplay = DISPLAY do XWayland (ex: ":0") — sempre necessário para o Wine
//
// O xdisplay é preservado no retorno para que NewLauncher não precise
// fazer os.Getenv("DISPLAY") (que falha quando o bridge sobe via systemd).
func detectDisplayServer() (DisplayServer, string, string) {
	liveDS, liveDisplay, liveXDisplay := probeDisplayServer()

	if liveDS != DisplayUnknown {
		cachedDS, _, _ := loadDisplayCache()
		if cachedDS != DisplayUnknown && cachedDS != liveDS {
			log.Printf("[DISPLAY] ⚡ Servidor gráfico mudou: %s → %s\n",
				cachedDS, liveDS)
		}
		saveDisplayCache(liveDS, liveDisplay, liveXDisplay)

		if liveDS == DisplayWayland {
			log.Printf("[DISPLAY] Wayland detectado (socket: %s, xdisplay: %s) — salvo\n",
				liveDisplay, liveXDisplay)
			return DisplayWayland, liveDisplay, liveXDisplay
		}
		log.Printf("[DISPLAY] X11 detectado (%s) — salvo\n", liveDisplay)
		return DisplayX11, liveDisplay, liveDisplay
	}

	// Detecção ao vivo falhou (sem sessão gráfica ainda) — tentar cache
	cachedDS, cachedDisplay, cachedXDisplay := loadDisplayCache()
	if cachedDS != DisplayUnknown {
		log.Printf("[DISPLAY] Sem sessão gráfica ativa — usando cache: %s (display=%s, xdisplay=%s)\n",
			cachedDS, cachedDisplay, cachedXDisplay)
		return cachedDS, cachedDisplay, cachedXDisplay
	}

	// Sem cache e sem detecção — fallback seguro: Wayland moderno
	// watchDisplayServer() corrigirá assim que a sessão gráfica aparecer.
	log.Printf("[DISPLAY] Nenhum servidor detectado e sem cache — fallback Wayland/wayland-0\n")
	return DisplayWayland, "wayland-0", ":0"
}
