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

const version = "2.0.0"

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
		fmt.Printf("IDM Linux Bridge v%s\n", version)
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

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		log.Println("[INFO] Encerrando IDM Bridge...")
		srv.Shutdown()
		os.Exit(0)
	}()

	log.Printf("[INFO] IDM Linux Bridge v%s iniciado em %s:%d\n", version, *host, *port)
	if err := srv.Start(); err != nil {
		log.Fatalf("[ERRO] Servidor encerrado: %v\n", err)
	}
}
