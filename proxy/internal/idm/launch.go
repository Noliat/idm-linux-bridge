package idm

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"github.com/google/uuid"
)

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
	// Se sim, apenas enviar a URL — o IDM existente processa o download.
	// Importante: se o IDM foi iniciado pelo usuário em Wayland e o bridge
	// estava configurado para X11, NÃO lançamos nova instância — enviamos
	// apenas /d para a instância existente (que já está no display correto).
	alreadyRunning := isIDMRunning()

	// Se já existe uma instância, atualizar displayServer a partir do
	// ambiente do processo IDM/Wine existente — garante consistência.
	if alreadyRunning {
		if ds, disp, xdisp := probeIDMProcessDisplay(l.idmPath); ds != DisplayUnknown {
			if ds != l.displayServer || disp != l.display {
				log.Printf("[IDM] Instância existente usa %s (%s) — sincronizando\n", ds, disp)
				l.mu.Lock()
				l.displayServer = ds
				l.display       = disp
				l.xdisplay      = xdisp
				l.mu.Unlock()
				saveDisplayCache(ds, disp, xdisp)
			}
		}
	}

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
// Lê l.displayServer/l.display/l.xdisplay com mutex para segurança com
// watchDisplayServer, que pode atualizar esses valores em background.

func (l *Launcher) buildEnv(idmAlreadyRunning bool) []string {
	// Snapshot thread-safe dos valores de display
	l.mu.RLock()
	ds       := l.displayServer
	display  := l.display
	xdisplay := l.xdisplay
	l.mu.RUnlock()

	env := os.Environ()

	// Remover variáveis de display que possam vir do ambiente do systemd
	// (podem estar erradas — substituímos pelos valores detectados)
	filtered := env[:0]
	for _, e := range env {
		k := strings.SplitN(e, "=", 2)[0]
		switch k {
		case "DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE",
			"WINE_WAYLAND_PREFER_DISPLAY":
			// Remover — vamos setar os valores corretos abaixo
		default:
			filtered = append(filtered, e)
		}
	}
	env = filtered

	// Prefixo Wine
	env = append(env, fmt.Sprintf("WINEPREFIX=%s", l.winePrefix))

	// Silenciar debug do Wine
	env = append(env, "WINEDEBUG=-all")

	// ── Configurar display de acordo com o servidor gráfico ──────
	switch ds {

	case DisplayWayland:
		// Wine em sessão Wayland: DISPLAY aponta para XWayland, que é a
		// ponte que o Wine usa para renderizar em sessões Wayland.
		// WAYLAND_DISPLAY informa ao Wine/SDL/GTK que há um compositor Wayland.
		env = append(env,
			fmt.Sprintf("DISPLAY=%s", xdisplay),
			fmt.Sprintf("WAYLAND_DISPLAY=%s", display),
			"XDG_SESSION_TYPE=wayland",
			// Forçar Wine a usar XWayland (mais estável para apps Windows)
			"WINE_WAYLAND_PREFER_DISPLAY=xwayland",
		)
		log.Printf("[DISPLAY] Wine via XWayland (DISPLAY=%s) em sessão Wayland (%s)\n",
			xdisplay, display)

	case DisplayX11:
		env = append(env,
			fmt.Sprintf("DISPLAY=%s", display),
			"XDG_SESSION_TYPE=x11",
		)
		log.Printf("[DISPLAY] Wine em X11 (DISPLAY=%s)\n", display)

	default:
		// Fallback: tentar Wayland padrão, depois :0
		if _, err := os.Stat(fmt.Sprintf("/run/user/%d/wayland-0", os.Getuid())); err == nil {
			env = append(env, "DISPLAY=:0", "WAYLAND_DISPLAY=wayland-0", "XDG_SESSION_TYPE=wayland")
			log.Printf("[DISPLAY] Wine fallback: Wayland detectado via socket\n")
		} else {
			env = append(env, "DISPLAY=:0", "XDG_SESSION_TYPE=x11")
			log.Printf("[DISPLAY] Wine fallback: X11 :0\n")
		}
	}

	if idmAlreadyRunning {
		env = append(env, "IDM_BRIDGE_EXISTING=1")
	}

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
