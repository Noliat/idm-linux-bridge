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

// DownloadJob representa um trabalho de download a ser enviado ao IDM.
type DownloadJob struct {
	URL       string
	Filename  string
	Cookies   string
	Referrer  string
	UserAgent string
	Headers   map[string]string
}

// Launcher é responsável por lançar o IDM via Wine com os parâmetros corretos.
type Launcher struct {
	winePrefix string
	idmPath    string   // caminho Windows-style dentro do prefixo
	wineBin    string   // caminho do binário wine no Linux
	verbose    bool
}

// NewLauncher cria um novo launcher do IDM.
func NewLauncher(winePrefix, idmPath string, verbose bool) (*Launcher, error) {
	wineBin, err := findWine()
	if err != nil {
		return nil, err
	}

	return &Launcher{
		winePrefix: winePrefix,
		idmPath:    idmPath,
		wineBin:    wineBin,
		verbose:    verbose,
	}, nil
}

// IsIDMAvailable verifica se o IDMan.exe existe no prefixo Wine.
func (l *Launcher) IsIDMAvailable() bool {
	_, err := os.Stat(l.idmPath)
	return err == nil
}

// Launch lança o IDM para baixar a URL especificada.
// Retorna um job ID único para rastreamento.
func (l *Launcher) Launch(job DownloadJob) (string, error) {
	jobID := uuid.New().String()[:8]

	// Estratégia 1: tentar via argumentos de linha de comando (mais simples)
	if err := l.launchViaArgs(job, jobID); err != nil {
		log.Printf("[WARN] Falha na estratégia args: %v. Tentando via arquivo...\n", err)
		// Estratégia 2: fallback via arquivo temporário .url
		if err2 := l.launchViaFile(job, jobID); err2 != nil {
			return "", fmt.Errorf("todas estratégias falharam: args=%v, file=%v", err, err2)
		}
	}

	return jobID, nil
}

// launchViaArgs lança o IDM passando a URL como argumento de linha de comando.
// O IDM suporta: IDMan.exe /d <url> /n /q /f <filename> /c <cookies> /r <referrer>
func (l *Launcher) launchViaArgs(job DownloadJob, jobID string) error {
	args := []string{
		l.idmPath,
		"/d", job.URL,
		"/n", // sem confirmação
	}

	if job.Filename != "" {
		args = append(args, "/p", job.Filename)
	}

	if l.verbose {
		log.Printf("[IDM:%s] Comando: wine %s\n", jobID, strings.Join(args, " "))
	}

	cmd := exec.Command(l.wineBin, args...)
	cmd.Env = l.buildEnv(job)

	if l.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	// IDM é lançado em background — não esperamos ele terminar
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("falha ao iniciar wine: %w", err)
	}

	// Liberar o processo para rodar independente
	go func() {
		if err := cmd.Wait(); err != nil && l.verbose {
			log.Printf("[IDM:%s] Processo encerrado: %v\n", jobID, err)
		}
	}()

	return nil
}

// launchViaFile cria um arquivo temporário com os metadados e lança o IDM.
func (l *Launcher) launchViaFile(job DownloadJob, jobID string) error {
	// Criar arquivo temporário dentro do prefixo Wine para que o IDM possa ler
	tmpDir := filepath.Join(l.winePrefix, "drive_c", "windows", "temp")
	os.MkdirAll(tmpDir, 0755)

	tmpFile := filepath.Join(tmpDir, fmt.Sprintf("idm_bridge_%s_%d.idmjob", jobID, time.Now().UnixMilli()))

	content := buildJobFile(job)
	if err := os.WriteFile(tmpFile, []byte(content), 0644); err != nil {
		return fmt.Errorf("falha ao criar arquivo de job: %w", err)
	}

	// Converter caminho Linux para caminho Windows (para o IDM)
	winPath := linuxToWinePath(tmpFile, l.winePrefix)

	args := []string{
		l.idmPath,
		"/f", winPath,
		"/n",
	}

	cmd := exec.Command(l.wineBin, args...)
	cmd.Env = l.buildEnv(job)

	if err := cmd.Start(); err != nil {
		os.Remove(tmpFile)
		return fmt.Errorf("falha ao iniciar wine: %w", err)
	}

	go func() {
		cmd.Wait()
		// Limpar arquivo temporário após 30s
		time.Sleep(30 * time.Second)
		os.Remove(tmpFile)
	}()

	return nil
}

// buildEnv constrói as variáveis de ambiente para o processo Wine.
func (l *Launcher) buildEnv(job DownloadJob) []string {
	env := os.Environ()

	// Prefixo Wine
	env = append(env, fmt.Sprintf("WINEPREFIX=%s", l.winePrefix))

	// Passar cookies e referrer via variáveis de ambiente
	// (lidos pelo IDM através de um helper DLL ou script de inicialização)
	if job.Cookies != "" {
		env = append(env, fmt.Sprintf("IDM_BRIDGE_COOKIES=%s", job.Cookies))
	}
	if job.Referrer != "" {
		env = append(env, fmt.Sprintf("IDM_BRIDGE_REFERER=%s", job.Referrer))
	}
	if job.UserAgent != "" {
		env = append(env, fmt.Sprintf("IDM_BRIDGE_UA=%s", job.UserAgent))
	}

	// Suprimir janelas gráficas desnecessárias do Wine
	env = append(env, "WINEDEBUG=-all")

	return env
}

// buildJobFile cria o conteúdo de um arquivo de job para o IDM.
func buildJobFile(job DownloadJob) string {
	var sb strings.Builder
	sb.WriteString("[IDM Download Job]\n")
	sb.WriteString(fmt.Sprintf("URL=%s\n", job.URL))
	if job.Filename != "" {
		sb.WriteString(fmt.Sprintf("Filename=%s\n", job.Filename))
	}
	if job.Cookies != "" {
		sb.WriteString(fmt.Sprintf("Cookie=%s\n", job.Cookies))
	}
	if job.Referrer != "" {
		sb.WriteString(fmt.Sprintf("Referer=%s\n", job.Referrer))
	}
	if job.UserAgent != "" {
		sb.WriteString(fmt.Sprintf("User-Agent=%s\n", job.UserAgent))
	}
	// Headers extras
	for k, v := range job.Headers {
		sb.WriteString(fmt.Sprintf("Header-%s=%s\n", k, v))
	}
	return sb.String()
}

// linuxToWinePath converte caminho Linux para caminho Windows dentro do prefixo Wine.
func linuxToWinePath(linuxPath, winePrefix string) string {
	driveC := filepath.Join(winePrefix, "drive_c")
	rel := strings.TrimPrefix(linuxPath, driveC)
	rel = strings.ReplaceAll(rel, "/", "\\")
	return "C:" + rel
}

// findWine localiza o binário wine no sistema.
func findWine() (string, error) {
	candidates := []string{"wine", "wine64", "/usr/bin/wine", "/usr/local/bin/wine"}
	for _, c := range candidates {
		if path, err := exec.LookPath(c); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("wine não encontrado no sistema. Instale com: sudo apt install wine")
}
