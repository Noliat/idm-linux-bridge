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
	Site        string            `json:"site"`        // ex: "youtube", "hotmart"
	SessionData map[string]string `json:"sessionData"` // dados extras de sessão
	// Silent: false (padrão) = abre janela do IDM para confirmar/editar;
	// true = inicia o download imediatamente sem interação do usuário.
	Silent      bool   `json:"silent"`
	// RequestType: "stream" (vídeo embutido) ou "download" (arquivo direto).
	// Determina quais Sec-Fetch-* headers o proxy usa na requisição ao CDN.
	RequestType string `json:"requestType"`
	// MediaOrigin: Origin do CDN (ex: "https://cf-media.hotmart.com").
	// CDNs de vídeo validam este header — sem ele retornam 403.
	MediaOrigin string `json:"mediaOrigin"`
	HlsKeys []map[string]string `json:"hlsKeys,omitempty"`
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
		Addr:    addr,
		Handler: mux,
		// ReadHeaderTimeout: limite apenas para leitura de headers —
		// protege contra slowloris sem afetar downloads longos.
		//
		// PROBLEMA ANTERIOR: ReadTimeout e WriteTimeout de 15s matavam
		// qualquer download que demorasse mais de 15s → 502 Bad Gateway.
		// Para downloads de vídeo (GB), 15s é insuficiente até para o
		// handshake inicial com o CDN em conexões lentas.
		//
		// ReadTimeout e WriteTimeout são intencionalmente OMITIDOS:
		//   - ReadTimeout: controlado pelo streaming do CDN (sem limite fixo)
		//   - WriteTimeout: controlado pelo IDM (sem limite fixo)
		// O timeout de segurança fica apenas no header (proteção anti-slowloris).
		ReadHeaderTimeout: 30 * time.Second,
		IdleTimeout:       120 * time.Second,
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
		mode := "interativo"
		if req.Silent {
			mode = "silencioso"
		}
		log.Printf("[CAPTURE] URL: %s | Site: %s | Filename: %s | Modo: %s\n",
			req.URL, req.Site, req.Filename, mode)
	}

	// Enriquecer cookies com dados armazenados (cookies manager + session manager)
	enrichedCookies := s.cookiesMgr.Enrich(req.URL, req.Cookies, req.Site)

	// Complementar com dados de sessão específicos do site.
	//
	// PROBLEMA ANTERIOR: tokens JWT/Bearer eram injetados diretamente na string
	// Cookie (ex: Cookie: access_token=eyJhbG...). CDNs como Cloudflare Stream
	// e Akamai não reconhecem esse formato — eles esperam cookies de rede HTTP
	// reais, não tokens de API. O resultado era 403 mesmo com token válido.
	//
	// CORREÇÃO: separar tokens de autenticação de cookies de sessão:
	//   - Campos reconhecidamente de API (access_token, Bearer, Authorization)
	//     → injetados como header Authorization: Bearer <token>
	//   - Outros campos de sessão que parecem cookies legítimos (nome=valor curto)
	//     → mantidos como cookie (comportamento original, correto para esses)
	if req.Site != "" {
		if sessionData := s.sessionMgr.Get(req.Site); len(sessionData) > 0 {
			for k, v := range sessionData {
				if k == "" || v == "" {
					continue
				}
				// Detectar se é token de API (não deve virar cookie)
				if isAPIToken(k, v) {
					// Guardar no mapa de headers extras para o launcher usar
					if req.Headers == nil {
						req.Headers = make(map[string]string)
					}
					// Só adicionar Authorization se não veio da extensão
					if _, exists := req.Headers["Authorization"]; !exists {
						req.Headers["Authorization"] = "Bearer " + v
					}
				} else {
					// Cookie de sessão legítimo: injetar normalmente
					if !containsCookieKey(enrichedCookies, k) {
						enrichedCookies = appendCookie(enrichedCookies, k, v)
					}
				}
			}
		}
	}

	// Construir job de download
	job := idm.DownloadJob{
		URL:         req.URL,
		Filename:    req.Filename,
		Cookies:     enrichedCookies,
		Referrer:    req.Referrer,
		UserAgent:   req.UserAgent,
		Headers:     req.Headers,
		Silent:      req.Silent,      // false = abre janela IDM; true = inicia direto
		RequestType: req.RequestType, // "stream" | "download"
		MediaOrigin: req.MediaOrigin, // Origin do CDN para header Origin
		HlsKeys:     req.HlsKeys,
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
		"version":        "2.1.0",
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

// isAPIToken detecta se um par chave/valor representa um token de API
// que NÃO deve ser injetado como cookie HTTP.
//
// Critérios:
//   - Nome da chave contém "token", "auth", "bearer", "jwt", "key", "secret"
//   - Valor parece JWT (começa com "eyJ" — base64 de {"...)
//   - Valor é muito longo para ser um cookie (> 200 chars)
//
// Tokens de API injetados como cookies causam 403 em CDNs modernos porque
// o CDN espera cookies de sessão de rede, não strings de autorização JWT.
func isAPIToken(key, value string) bool {
	k := strings.ToLower(key)
	if strings.Contains(k, "access_token") || strings.Contains(k, "refresh_token") ||
		strings.Contains(k, "bearer") || strings.Contains(k, "jwt") ||
		strings.Contains(k, "api_key") || strings.Contains(k, "api_secret") ||
		strings.Contains(k, "client_secret") {
		return true
	}
	// JWT tem header base64url que começa com eyJ
	if strings.HasPrefix(value, "eyJ") {
		return true
	}
	// Cookie legítimo raramente passa de 200 chars
	if len(value) > 200 {
		return true
	}
	return false
}

// containsCookieKey verifica se uma chave já existe na string de cookies.
func containsCookieKey(cookies, key string) bool {
	for _, part := range strings.Split(cookies, ";") {
		part = strings.TrimSpace(part)
		if idx := strings.IndexByte(part, '='); idx > 0 {
			if strings.TrimSpace(part[:idx]) == key {
				return true
			}
		}
	}
	return false
}

// appendCookie adiciona um par key=value à string de cookies existente.
func appendCookie(cookies, key, value string) string {
	if cookies == "" {
		return key + "=" + value
	}
	return cookies + "; " + key + "=" + value
}
