package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"idm-bridge/internal/cookies"
	"idm-bridge/internal/idm"
	"idm-bridge/internal/session"
)

// Config contém a configuração do servidor bridge.
type Config struct {
	Host       string
	Port       int
	WinePrefix string
	IDMPath    string
	Verbose    bool
}

// Validate valida e preenche valores padrão da configuração.
func (c *Config) Validate() error {
	if c.WinePrefix == "" {
		home, _ := os.UserHomeDir()
		c.WinePrefix = filepath.Join(home, ".wine")
	}
	if c.IDMPath == "" {
		c.IDMPath = filepath.Join(
			c.WinePrefix,
			"drive_c", "Program Files (x86)",
			"Internet Download Manager", "IDMan.exe",
		)
	}
	// Verificar se o IDMan.exe existe no prefixo Wine
	wineIDMPath := filepath.Join(
		c.WinePrefix, "drive_c",
		strings.TrimPrefix(c.IDMPath, filepath.Join(c.WinePrefix, "drive_c")),
	)
	if _, err := os.Stat(wineIDMPath); os.IsNotExist(err) {
		log.Printf("[AVISO] IDMan.exe não encontrado em: %s\n", c.IDMPath)
		log.Printf("[AVISO] Configure o caminho correto com --idm-path\n")
	}
	return nil
}

// Server é o proxy bridge entre extensão e IDM via Wine.
type Server struct {
	cfg        Config
	httpServer *http.Server
	launcher   *idm.Launcher
	cookiesMgr *cookies.Manager
	sessionMgr *session.Manager
}

// CaptureRequest é o payload enviado pela extensão.
type CaptureRequest struct {
	URL         string            `json:"url"`
	Filename    string            `json:"filename"`
	Cookies     string            `json:"cookies"`
	Referrer    string            `json:"referrer"`
	UserAgent   string            `json:"userAgent"`
	Headers     map[string]string `json:"headers"`
	Site        string            `json:"site"`      // ex: "youtube", "hotmart"
	SessionData map[string]string `json:"sessionData"` // dados extras de sessão
}

// CaptureResponse é a resposta enviada de volta à extensão.
type CaptureResponse struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	JobID   string `json:"jobId,omitempty"`
}

// New cria um novo servidor bridge.
func New(cfg Config) (*Server, error) {
	launcher, err := idm.NewLauncher(cfg.WinePrefix, cfg.IDMPath, cfg.Verbose)
	if err != nil {
		return nil, fmt.Errorf("falha ao criar launcher IDM: %w", err)
	}

	cookiesMgr := cookies.NewManager()
	sessionMgr := session.NewManager()

	return &Server{
		cfg:        cfg,
		launcher:   launcher,
		cookiesMgr: cookiesMgr,
		sessionMgr: sessionMgr,
	}, nil
}

// Start inicia o servidor HTTP.
func (s *Server) Start() error {
	mux := http.NewServeMux()

	// Endpoint principal: recebe downloads da extensão
	mux.HandleFunc("/capture", s.withCORS(s.handleCapture))

	// Endpoint de status: extensão verifica se bridge está rodando
	mux.HandleFunc("/status", s.withCORS(s.handleStatus))

	// Endpoint de sessão: armazena dados de sessão de sites específicos
	mux.HandleFunc("/session", s.withCORS(s.handleSession))

	// Endpoint de cookies: recebe cookies coletados pela extensão
	mux.HandleFunc("/cookies", s.withCORS(s.handleCookies))

	addr := fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
	s.httpServer = &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
	}

	return s.httpServer.ListenAndServe()
}

// Shutdown encerra o servidor graciosamente.
func (s *Server) Shutdown() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.httpServer.Shutdown(ctx)
}

// handleCapture processa uma requisição de captura de download.
func (s *Server) handleCapture(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}

	var req CaptureRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.respond(w, http.StatusBadRequest, CaptureResponse{
			Status:  "error",
			Message: fmt.Sprintf("payload inválido: %v", err),
		})
		return
	}

	if req.URL == "" {
		s.respond(w, http.StatusBadRequest, CaptureResponse{
			Status:  "error",
			Message: "URL é obrigatória",
		})
		return
	}

	if s.cfg.Verbose {
		log.Printf("[CAPTURE] URL: %s | Site: %s | Filename: %s\n", req.URL, req.Site, req.Filename)
	}

	// Enriquecer cookies com dados de sessão armazenados do site
	enrichedCookies := s.cookiesMgr.Enrich(req.URL, req.Cookies, req.Site)

	// Construir job de download
	job := idm.DownloadJob{
		URL:       req.URL,
		Filename:  req.Filename,
		Cookies:   enrichedCookies,
		Referrer:  req.Referrer,
		UserAgent: req.UserAgent,
		Headers:   req.Headers,
	}

	jobID, err := s.launcher.Launch(job)
	if err != nil {
		log.Printf("[ERRO] Falha ao lançar IDM: %v\n", err)
		s.respond(w, http.StatusInternalServerError, CaptureResponse{
			Status:  "error",
			Message: fmt.Sprintf("falha ao iniciar download: %v", err),
		})
		return
	}

	log.Printf("[OK] Download iniciado: %s (job: %s)\n", req.URL, jobID)
	s.respond(w, http.StatusOK, CaptureResponse{
		Status:  "ok",
		Message: "download enviado ao IDM",
		JobID:   jobID,
	})
}

// handleStatus responde com o status do bridge.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	idmFound := s.launcher.IsIDMAvailable()
	status := map[string]interface{}{
		"status":         "running",
		"version":        "1.0.0",
		"idmFound":       idmFound,
		"winePrefix":     s.cfg.WinePrefix,
		"reverseProxy":   fmt.Sprintf("127.0.0.1:%d", s.launcher.ProxyPort()),
	}
	s.respond(w, http.StatusOK, status)
}

// handleSession armazena dados de sessão de sites específicos.
func (s *Server) handleSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Site string            `json:"site"`
		Data map[string]string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "payload inválido", http.StatusBadRequest)
		return
	}

	s.sessionMgr.Store(payload.Site, payload.Data)
	if s.cfg.Verbose {
		log.Printf("[SESSION] Dados de sessão armazenados para: %s\n", payload.Site)
	}
	s.respond(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleCookies armazena cookies para domínios específicos.
func (s *Server) handleCookies(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "método não permitido", http.StatusMethodNotAllowed)
		return
	}

	var payload struct {
		Domain  string `json:"domain"`
		Cookies string `json:"cookies"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "payload inválido", http.StatusBadRequest)
		return
	}

	s.cookiesMgr.Store(payload.Domain, payload.Cookies)
	if s.cfg.Verbose {
		log.Printf("[COOKIES] Cookies armazenados para: %s\n", payload.Domain)
	}
	s.respond(w, http.StatusOK, map[string]string{"status": "ok"})
}

// withCORS adiciona headers CORS para comunicação com extensão.
func (s *Server) withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// respond serializa e envia a resposta JSON.
func (s *Server) respond(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}
