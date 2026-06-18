package idm

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// watchDisplayServer monitora a sessão gráfica em background com dois objetivos:
//
//  1. Atualização suave (display/xdisplay mudam, mesmo servidor):
//     Atualiza l.display e l.xdisplay sem reiniciar. Cobre casos como
//     mudança de socket Wayland (wayland-0 → wayland-1) ou XWayland.
//
//  2. Reinício necessário (tipo de servidor muda: X11 ↔ Wayland):
//     Quando o tipo de servidor gráfico do sistema difere do que o bridge
//     foi iniciado com, sinaliza restartCh para que o processo se reinicie.
//     O systemd (modo boot) ou o wrapper (modo login) relançam o bridge
//     com o ambiente gráfico correto.
//
// Comportamento em logon:
//   - Bridge pode ter subido com cache antigo (ex: Wayland no cache, mas o
//     usuário fez login numa sessão X11 desta vez).
//   - Ao detectar o logon (sessão gráfica disponível), compara o servidor
//     vivo com o que foi usado no início do processo.
//   - Se diferente: salva no cache e sinaliza reinício.
func (l *Launcher) watchDisplayServer() {
	fastInterval := 5 * time.Second
	slowInterval := 30 * time.Second
	deadline     := time.Now().Add(2 * time.Minute)

	// Servidor com que este processo foi iniciado — referência para detectar discrepância.
	l.mu.RLock()
	startDS := l.displayServer
	l.mu.RUnlock()

	// wasUnknown: bridge subiu sem sessão gráfica (cache ou fallback).
	// Neste caso, a primeira detecção bem-sucedida SEMPRE verifica discrepância.
	wasUnknown := startDS == DisplayUnknown

	ticker := time.NewTicker(fastInterval)
	defer ticker.Stop()

	for range ticker.C {
		if time.Now().After(deadline) {
			ticker.Reset(slowInterval)
			deadline = time.Now().Add(24 * time.Hour)
		}

		liveDS, liveDisplay, liveXDisplay := probeDisplayServer()
		if liveDS == DisplayUnknown {
			continue // sessão gráfica ainda não disponível
		}

		// Sessão gráfica detectada — salvar no cache imediatamente.
		// Isso garante que o próximo boot use o servidor correto.
		saveDisplayCache(liveDS, liveDisplay, liveXDisplay)

		l.mu.Lock()
		dsChanged  := l.displayServer != liveDS
		envChanged := l.display != liveDisplay || l.xdisplay != liveXDisplay
		l.mu.Unlock()

		if dsChanged || wasUnknown && l.displayServer != liveDS {
			// Tipo de servidor diferente do que o processo foi iniciado com.
			// Variáveis de ambiente do Wine (DISPLAY/WAYLAND_DISPLAY) já foram
			// configuradas incorretamente no início — não há como corrigi-las
			// sem reiniciar o processo. Sinalizar reinício.
			l.mu.Lock()
			old := l.displayServer
			l.mu.Unlock()
			log.Printf("[DISPLAY] ⚡ Discrepância detectada no logon: iniciado com %s, sistema usa %s — sinalizando reinício\n",
				old, liveDS)
			// Enviar sem bloquear (buffer de 1); se já foi enviado, ignorar
			select {
			case l.restartCh <- liveDS:
			default:
			}
			return // goroutine encerra; o processo vai reiniciar
		}

		if envChanged {
			// Mesmo servidor, mas display/xdisplay mudaram (ex: novo socket Wayland).
			// Atualização suave — sem reinício necessário.
			l.mu.Lock()
			log.Printf("[DISPLAY] ⚡ Atualização em runtime: %s (%s, xdisplay=%s) → %s (%s, xdisplay=%s)\n",
				l.displayServer, l.display, l.xdisplay, liveDS, liveDisplay, liveXDisplay)
			l.displayServer = liveDS
			l.display       = liveDisplay
			l.xdisplay      = liveXDisplay
			l.mu.Unlock()
		}
		// Servidor e display iguais — nada a fazer neste tick.
	}
}

// watchLoginEvent monitora logons e logoffs do usuário de forma contínua,
// garantindo que o bridge sempre use o servidor gráfico correto.
//
// Responsabilidades:
//
//  1. Atualizar o cache persistente no momento do logon.
//     Assim, qualquer reinício posterior do bridge já lê o valor correto.
//
//  2. Detectar discrepância no logon.
//     Se o bridge subiu com X11 (do cache) mas o usuário logou em Wayland
//     (ou vice-versa), sinalizar reinício via restartCh. O systemd (modo
//     boot) ou o script de autostart (modo login) relançam o processo com
//     o ambiente gráfico correto desde o início.
//
//  3. Funcionar em múltiplos ciclos de logout/login.
//     O goroutine NÃO termina após o primeiro logon. Ele monitora a
//     transição none→active continuamente, então troca de sessão (X11→
//     Wayland ou vice-versa) entre logons são detectadas corretamente.
//
// Indicadores de sessão gráfica ativa (em ordem de confiabilidade):
//
//   a. loginctl show-user — lista sessões com Type=x11 ou Type=wayland.
//      É a fonte mais confiável, mas requer D-Bus ativo.
//
//   b. Sockets de sessão em $XDG_RUNTIME_DIR:
//      - wayland-N  → sessão Wayland (N pode ser 0, 1, 2…)
//      - bus         → D-Bus da sessão (presente em X11 e Wayland)
//
//   c. /tmp/.X11-unix/XN → sockets do Xorg (N = 0, 1, 2…)
//
//   d. /proc/<pid>/environ de processos wine/Xorg — fonte existente em
//      probeDisplayServer(), chamada quando os indicadores acima confirmam
//      que há sessão, para obter os valores exatos de DISPLAY/WAYLAND_DISPLAY.
func (l *Launcher) watchLoginEvent() {
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		runtimeDir = fmt.Sprintf("/run/user/%d", os.Getuid())
	}

	// Aguardar o bridge ter iniciado completamente antes de começar a monitorar.
	// Isso evita falsos positivos na primeira checagem quando o bridge sobe
	// junto com a sessão gráfica (modo login) — a sessão pode ainda não ter
	// os sockets todos criados.
	time.Sleep(3 * time.Second)

	var (
		lastSessionState string // "none" | "active"
		retryProbe       int    // tentativas restantes quando a sessão é detectada mas ainda não identificável
	)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		currentState := detectSessionState(runtimeDir)

		// ── Transição none → active: logon aconteceu ────────────────────────
		if lastSessionState == "none" && currentState == "active" {
			log.Printf("[LOGIN] Sessão gráfica detectada — verificando discrepância de servidor gráfico\n")

			// Dar tempo extra para o compositor/Xorg criarem seus sockets
			// e exportarem as variáveis de ambiente completas.
			time.Sleep(1500 * time.Millisecond)

			l.handleLoginTransition()
			retryProbe = 0
		}

		// ── Sessão já ativa mas probe anterior falhou (retentativas) ────────
		if currentState == "active" && retryProbe > 0 {
			retryProbe--
			liveDS, liveDisplay, liveXDisplay := probeDisplayServer()
			if liveDS != DisplayUnknown {
				saveDisplayCache(liveDS, liveDisplay, liveXDisplay)
				l.applyDisplayUpdate(liveDS, liveDisplay, liveXDisplay)
				retryProbe = 0
			}
		}

		// ── Transição active → none: logout do usuário ──────────────────────
		// Não precisamos fazer nada aqui além de registrar — o bridge
		// continua rodando aguardando o próximo logon.
		if lastSessionState == "active" && currentState == "none" {
			log.Printf("[LOGIN] Sessão gráfica encerrada (logout detectado) — aguardando próximo logon\n")
		}

		lastSessionState = currentState
	}
}

// detectSessionState verifica se há uma sessão gráfica ativa.
// Retorna "active" ou "none".
// Usa múltiplos indicadores para cobrir X11, Wayland e ambientes mistos.
func detectSessionState(runtimeDir string) string {
	// ── Indicador 1: loginctl (mais confiável quando D-Bus está disponível) ──
	// Verifica se há sessão do tipo "x11" ou "wayland" para o usuário atual.
	if out, err := runLoginctl(); err == nil && out != "" {
		return "active"
	}

	// ── Indicador 2: sockets Wayland em XDG_RUNTIME_DIR ──────────────────────
	// Procurar por wayland-0, wayland-1, wayland-2, etc.
	if runtimeDir != "" {
		entries, err := os.ReadDir(runtimeDir)
		if err == nil {
			for _, e := range entries {
				if !e.IsDir() && len(e.Name()) >= 8 &&
					e.Name()[:8] == "wayland-" {
					return "active"
				}
			}
		}
		// D-Bus da sessão — presente em X11 e Wayland
		if fileExists(filepath.Join(runtimeDir, "bus")) {
			// D-Bus sozinho não confirma sessão gráfica, mas junto com
			// ausência de sockets gráficos pode indicar sessão TTY.
			// Verificar também /tmp/.X11-unix antes de confirmar.
		}
	}

	// ── Indicador 3: sockets Xorg em /tmp/.X11-unix ──────────────────────────
	// Procurar X0, X1, X2, …, X9 — cobrir múltiplos displays.
	if xDir, err := os.ReadDir("/tmp/.X11-unix"); err == nil {
		for _, e := range xDir {
			if !e.IsDir() && len(e.Name()) >= 2 && e.Name()[0] == 'X' {
				return "active"
			}
		}
	}

	return "none"
}

// runLoginctl executa loginctl para detectar sessões gráficas do usuário atual.
// Retorna o tipo da sessão ("x11" ou "wayland") e nil se encontrar uma sessão
// gráfica ativa, ou ("", err) se não houver sessão ou o comando falhar.
func runLoginctl() (string, error) {
	uid := fmt.Sprintf("%d", os.Getuid())
	// loginctl list-sessions --no-legend retorna linhas com:
	//   SESSION  UID  USER  SEAT  TTY  TYPE  STATE  IDLE  …
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		// Campos esperados: SESSION UID USER SEAT TTY TYPE ...
		// Mas o formato pode variar entre versões do systemd.
		// Procurar pelo UID do usuário atual na linha.
		for i, f := range fields {
			if f == uid {
				// UID encontrado — verificar se TYPE é x11 ou wayland
				// TYPE pode estar em índices variados; varrer os campos restantes
				for _, ff := range fields[i:] {
					ff = strings.ToLower(ff)
					if ff == "x11" || ff == "wayland" || ff == "mir" {
						return ff, nil
					}
				}
			}
		}
	}
	return "", fmt.Errorf("nenhuma sessão gráfica encontrada para uid %s", uid)
}

// handleLoginTransition é chamada quando uma transição none→active é detectada.
// Probe o servidor gráfico, salva no cache e decide se reinício é necessário.
func (l *Launcher) handleLoginTransition() {
	// Tentar probe com até 3 tentativas em intervalos crescentes.
	// O compositor pode demorar até ~2s para expor suas variáveis de ambiente.
	delays := []time.Duration{0, 500 * time.Millisecond, 1500 * time.Millisecond}
	var liveDS DisplayServer
	var liveDisplay, liveXDisplay string

	for _, delay := range delays {
		if delay > 0 {
			time.Sleep(delay)
		}
		liveDS, liveDisplay, liveXDisplay = probeDisplayServer()
		if liveDS != DisplayUnknown {
			break
		}
		log.Printf("[LOGIN] Servidor gráfico ainda não identificável — tentando novamente em %s\n", delay+500*time.Millisecond)
	}

	if liveDS == DisplayUnknown {
		log.Printf("[LOGIN] Não foi possível identificar o servidor gráfico após 3 tentativas\n")
		return
	}

	// Salvar no cache imediatamente — este é o valor mais recente e confiável.
	// Feito ANTES de qualquer decisão de reinício para garantir que o próximo
	// boot use o servidor correto mesmo que o reinício falhe.
	saveDisplayCache(liveDS, liveDisplay, liveXDisplay)
	log.Printf("[LOGIN] Cache atualizado no logon: %s (display=%s, xdisplay=%s)\n",
		liveDS, liveDisplay, liveXDisplay)

	l.applyDisplayUpdate(liveDS, liveDisplay, liveXDisplay)
}

// applyDisplayUpdate compara o servidor gráfico ativo com o que o bridge
// foi iniciado e toma a ação necessária:
//   - Tipo diferente: sinalizar reinício (Wine foi configurado incorretamente)
//   - Tipo igual, display diferente: atualização suave (sem reinício)
//   - Tudo igual: nenhuma ação
func (l *Launcher) applyDisplayUpdate(liveDS DisplayServer, liveDisplay, liveXDisplay string) {
	l.mu.Lock()
	startDS    := l.displayServer
	curDisplay := l.display
	curXDisp   := l.xdisplay
	l.mu.Unlock()

	if startDS != liveDS {
		// O tipo de servidor mudou — Wine foi inicializado com variáveis de
		// ambiente erradas (ex: WAYLAND_DISPLAY vazio quando deveria ter valor).
		// Impossível corrigir em runtime sem reiniciar o processo.
		log.Printf("[LOGIN] ⚡ Discrepância de servidor gráfico: bridge iniciado com %s, sessão usa %s — reiniciando\n",
			startDS, liveDS)
		select {
		case l.restartCh <- liveDS:
		default:
		}
		return
	}

	if curDisplay != liveDisplay || curXDisp != liveXDisplay {
		// Mesmo tipo de servidor, mas os valores de display/socket mudaram.
		// Atualização suave — sem reinício necessário.
		l.mu.Lock()
		l.displayServer = liveDS
		l.display       = liveDisplay
		l.xdisplay      = liveXDisplay
		l.mu.Unlock()
		log.Printf("[LOGIN] Servidor gráfico confirmado (%s), display atualizado: %s → %s\n",
			liveDS, curDisplay, liveDisplay)
		return
	}

	log.Printf("[LOGIN] Servidor gráfico confirmado: %s (%s) — sem alterações necessárias\n",
		liveDS, liveDisplay)
}

// fileExists verifica se um arquivo ou socket existe no caminho dado.
func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
