package cookies

import (
	"net/url"
	"strings"
	"sync"
)

// Manager gerencia cookies para múltiplos domínios.
// Suporta enriquecimento de cookies com dados armazenados de sessões anteriores.
type Manager struct {
	mu      sync.RWMutex
	storage map[string]string // domain -> cookie string
}

// NewManager cria um novo gerenciador de cookies.
func NewManager() *Manager {
	return &Manager{
		storage: make(map[string]string),
	}
}

// Store armazena cookies para um domínio específico.
func (m *Manager) Store(domain, cookieStr string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Normalizar domínio (remover www., protocolo, etc.)
	domain = normalizeDomain(domain)
	m.storage[domain] = cookieStr
}

// Enrich combina cookies recebidos da extensão com cookies armazenados para o domínio.
// Cookies da extensão têm prioridade sobre os armazenados.
func (m *Manager) Enrich(rawURL, extensionCookies, site string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	// Extrair domínio da URL
	domain := extractDomain(rawURL)

	// Coletar cookies armazenados para este domínio
	var storedCookies string
	for storedDomain, c := range m.storage {
		if domainMatches(domain, storedDomain) {
			storedCookies = c
			break
		}
	}

	// Mesclar: armazenados como base + extensão sobrescreve
	return mergeCookies(storedCookies, extensionCookies)
}

// Get retorna os cookies armazenados para um domínio.
func (m *Manager) Get(domain string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	domain = normalizeDomain(domain)
	return m.storage[domain]
}

// mergeCookies mescla duas strings de cookies (formato: "key=value; key2=value2").
// cookiesB tem prioridade sobre cookiesA em caso de chaves duplicadas.
func mergeCookies(cookiesA, cookiesB string) string {
	if cookiesA == "" {
		return cookiesB
	}
	if cookiesB == "" {
		return cookiesA
	}

	// Parse cookies em mapas
	mapA := parseCookieString(cookiesA)
	mapB := parseCookieString(cookiesB)

	// Mesclar: B sobrescreve A
	for k, v := range mapB {
		mapA[k] = v
	}

	// Reconstruir string
	var parts []string
	for k, v := range mapA {
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, "; ")
}

// parseCookieString converte "key=value; key2=value2" em um mapa.
func parseCookieString(s string) map[string]string {
	m := make(map[string]string)
	for _, part := range strings.Split(s, ";") {
		part = strings.TrimSpace(part)
		if idx := strings.IndexByte(part, '='); idx > 0 {
			k := strings.TrimSpace(part[:idx])
			v := strings.TrimSpace(part[idx+1:])
			m[k] = v
		}
	}
	return m
}

// extractDomain extrai o domínio de uma URL.
func extractDomain(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	return normalizeDomain(u.Hostname())
}

// normalizeDomain normaliza um domínio removendo www. e espaços.
func normalizeDomain(domain string) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	domain = strings.TrimPrefix(domain, "www.")
	return domain
}

// domainMatches verifica se um domínio corresponde a um padrão armazenado.
// Suporta correspondência de subdomínios.
func domainMatches(host, stored string) bool {
	host = normalizeDomain(host)
	stored = normalizeDomain(stored)
	return host == stored || strings.HasSuffix(host, "."+stored)
}
