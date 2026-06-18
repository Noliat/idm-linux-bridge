package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"idm-bridge/internal/server"
)

// Códigos de saída:
//   0 — encerramento normal (SIGTERM/SIGINT)
//   1 — erro fatal de inicialização
//   2 — reinício solicitado por discrepância de servidor gráfico
//       (systemd reinicia automaticamente; wrapper script também)
const ExitCodeRestart = 2

func main() {
	var (
		port    = flag.Int("port", 6969, "Porta do proxy local")
		host    = flag.String("host", "127.0.0.1", "Host do proxy local")
		winePfx = flag.String("wine-prefix", "", "Caminho do prefixo Wine (padrão: ~/.wine)")
		idmPath = flag.String("idm-path", "", "Caminho do IDMan.exe dentro do prefixo Wine")
		verbose = flag.Bool("verbose", false, "Log detalhado")
		ver     = flag.Bool("version", false, "Exibir versão")
	)
	flag.Parse()

	if *ver {
		fmt.Printf("IDM Linux Bridge v%s\n", server.Version)
		os.Exit(0)
	}

	cfg := server.Config{
		Host:       *host,
		Port:       *port,
		WinePrefix: *winePfx,
		IDMPath:    *idmPath,
		Verbose:    *verbose,
	}

	if err := cfg.Validate(); err != nil {
		log.Fatalf("[ERRO] Configuração inválida: %v\n", err)
	}

	srv, err := server.New(cfg)
	if err != nil {
		log.Fatalf("[ERRO] Falha ao iniciar servidor: %v\n", err)
	}

	// Graceful shutdown via SIGINT/SIGTERM
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		log.Println("[INFO] Encerrando IDM Bridge...")
		srv.Shutdown()
		os.Exit(0)
	}()

	// Monitorar canal de reinício por discrepância de servidor gráfico.
	//
	// Quando watchLoginEvent ou watchDisplayServer detectam que o bridge foi
	// iniciado com um servidor gráfico diferente do que está ativo na sessão
	// (ex: cache dizia Wayland mas usuário logou em X11), o Launcher sinaliza
	// restartCh com o servidor gráfico correto.
	//
	// Resposta: shutdown gracioso + exit(2).
	// systemd (Restart=on-failure ou Restart=always) reinicia o processo.
	// No novo processo, detectDisplayServer() encontrará a sessão gráfica
	// ativa e usará o servidor correto desde o início.
	go func() {
		newDS := <-srv.Launcher().RestartCh()
		log.Printf("[INFO] ⚡ Reiniciando — servidor gráfico mudou para: %s\n", newDS)
		log.Printf("[INFO] Aguardando encerramento gracioso dos jobs em andamento...\n")
		srv.Shutdown()
		log.Printf("[INFO] Saindo com código %d (reinício solicitado)\n", ExitCodeRestart)
		os.Exit(ExitCodeRestart)
	}()

	log.Printf("[INFO] IDM Linux Bridge v%s iniciado em %s:%d (servidor gráfico: %s)\n",
		server.Version, *host, *port, srv.Launcher().DisplayServerName())
	if err := srv.Start(); err != nil {
		log.Fatalf("[ERRO] Servidor encerrado: %v\n", err)
	}
}
