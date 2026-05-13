package session

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// SiteHandler define como tratar sessões de um site específico.
type SiteHandler struct {
	Name        string   // nome amigável do site
	Domains     []string // domínios que pertencem a este site
	TokenFields []string // campos de token/auth a preservar nos cookies
	NeedsAuth   bool     // se o site requer autenticação para downloads
}

// Manager gerencia dados de sessão para sites específicos.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]map[string]string // site -> data
	handlers map[string]SiteHandler       // site -> handler
	dataDir  string
}

// NewManager cria um novo gerenciador de sessões com handlers pré-configurados.
func NewManager() *Manager {
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".config", "idm-bridge", "sessions")
	os.MkdirAll(dataDir, 0700)

	m := &Manager{
		sessions: make(map[string]map[string]string),
		handlers: make(map[string]SiteHandler),
		dataDir:  dataDir,
	}

	// Registrar handlers para sites populares
	m.registerBuiltinHandlers()

	// Carregar sessões salvas em disco
	m.loadFromDisk()

	return m
}

// registerBuiltinHandlers registra handlers para sites que precisam de tratamento especial.
func (m *Manager) registerBuiltinHandlers() {
	handlers := []SiteHandler{
		{
			Name:        "YouTube",
			Domains:     []string{"youtube.com", "googlevideo.com", "ytimg.com"},
			TokenFields: []string{"VISITOR_INFO1_LIVE", "YSC", "HSID", "SSID", "APISID", "SAPISID", "__Secure-1PSID"},
			NeedsAuth:   false,
		},
		{
			Name:        "Google Drive",
			Domains:     []string{"drive.google.com", "docs.google.com", "storage.googleapis.com"},
			TokenFields: []string{"DRIVE_STREAM", "SID", "HSID", "SSID", "APISID", "__Secure-1PSID"},
			NeedsAuth:   true,
		},
		{
			Name:        "Hotmart",
			Domains:     []string{"hotmart.com", "cf-media.hotmart.com", "hotmart.net"},
			TokenFields: []string{"access_token", "refresh_token", "club_token", "hotmart_club_session"},
			NeedsAuth:   true,
		},
		{
			Name:        "Udemy",
			Domains:     []string{"udemy.com", "udemy-cdn.com", "vimeocdn.com"},
			TokenFields: []string{"access_token", "ud_cache_user", "client_id"},
			NeedsAuth:   true,
		},
		{
			Name:        "Coursera",
			Domains:     []string{"coursera.org", "coursera-assets.s3.amazonaws.com"},
			TokenFields: []string{"CAUTH", "csrftoken", "userbarbet"},
			NeedsAuth:   true,
		},
		{
			Name:        "Dropbox",
			Domains:     []string{"dropbox.com", "dl.dropboxusercontent.com"},
			TokenFields: []string{"t", "jar", "__Host-js_csrf"},
			NeedsAuth:   true,
		},
		{
			Name:        "OneDrive",
			Domains:     []string{"onedrive.live.com", "1drv.ms", "storage.live.com"},
			TokenFields: []string{"MUID", "PPAuth", "MSPAuth"},
			NeedsAuth:   true,
		},
		{
			Name:        "Mega",
			Domains:     []string{"mega.nz", "mega.co.nz"},
			TokenFields: []string{"sid", "cross_domain_key"},
			NeedsAuth:   true,
		},
		{
			Name:        "Twitch",
			Domains:     []string{"twitch.tv", "usher.twitchapps.com"},
			TokenFields: []string{"auth-token", "twilight-user", "persistent"},
			NeedsAuth:   true,
		},
		{
			Name:        "Vimeo",
			Domains:     []string{"vimeo.com", "player.vimeo.com", "vimeocdn.com"},
			TokenFields: []string{"vimeo", "vuid", "__utmz"},
			NeedsAuth:   false,
		},
	}

	for _, h := range handlers {
		m.handlers[strings.ToLower(h.Name)] = h
		for _, domain := range h.Domains {
			m.handlers[domain] = h
		}
	}
}

// Store armazena dados de sessão para um site.
func (m *Manager) Store(site string, data map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	site = strings.ToLower(site)
	if existing, ok := m.sessions[site]; ok {
		// Mesclar com sessão existente
		for k, v := range data {
			existing[k] = v
		}
	} else {
		m.sessions[site] = data
	}

	// Persistir em disco
	m.saveSiteToDisk(site, m.sessions[site])
}

// Get retorna os dados de sessão armazenados para um site.
func (m *Manager) Get(site string) map[string]string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[strings.ToLower(site)]
}

// GetHandler retorna o handler para um site/domínio.
func (m *Manager) GetHandler(siteOrDomain string) (SiteHandler, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	h, ok := m.handlers[strings.ToLower(siteOrDomain)]
	return h, ok
}

// saveSiteToDisk persiste a sessão de um site em disco.
func (m *Manager) saveSiteToDisk(site string, data map[string]string) {
	path := filepath.Join(m.dataDir, site+".json")
	b, _ := json.MarshalIndent(data, "", "  ")
	if err := os.WriteFile(path, b, 0600); err != nil {
		log.Printf("[SESSION] Erro ao salvar sessão %s: %v\n", site, err)
	}
}

// loadFromDisk carrega todas as sessões salvas em disco.
func (m *Manager) loadFromDisk() {
	entries, err := os.ReadDir(m.dataDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		site := strings.TrimSuffix(entry.Name(), ".json")
		path := filepath.Join(m.dataDir, entry.Name())
		b, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var data map[string]string
		if err := json.Unmarshal(b, &data); err != nil {
			continue
		}
		m.sessions[site] = data
		log.Printf("[SESSION] Sessão carregada: %s\n", site)
	}
}
