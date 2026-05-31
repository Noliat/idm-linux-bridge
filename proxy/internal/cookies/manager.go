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
//
// Estratégia de busca em 3 camadas:
//
//  Camada 1 — correspondência exata ou por subdomínio:
//    cf-media.hotmart.com  →  cf-media.hotmart.com  ✓
//    cf-media.hotmart.com  →  hotmart.com           ✓ (HasSuffix)
//
//  Camada 2 — fallback por nome de site (parâmetro `site`):
//    CDN usa domínio diferente do site principal (ex: cf-media.hotmart.com
//    não termina em .hotmart.com por causa do prefixo cf-media).
//    Se o storage tiver "hotmart.com" e site=="hotmart", encontra.
//
//  Camada 3 — fallback por domínio raiz (eTLD+1):
//    Extrai o domínio raiz da URL do CDN (hotmart.com de cf-media.hotmart.com)
//    e busca cookies armazenados para esse domínio raiz.
//    Cobre casos onde o domínio foi armazenado sem o subdomínio do CDN.
func (m *Manager) Enrich(rawURL, extensionCookies, site string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	domain := extractDomain(rawURL)
	site    = strings.ToLower(strings.TrimSpace(site))

	// ── Camada 1: correspondência exata ou subdomínio ──────────────────────
	var storedCookies string
	for storedDomain, c := range m.storage {
		if domainMatches(domain, storedDomain) {
			storedCookies = c
			break
		}
	}

	// ── Camada 2: fallback por nome de site ────────────────────────────────
	// Usado quando o CDN tem domínio diferente do site principal.
	// Ex: IDM pede cf-media.hotmart.com → storage tem hotmart.com
	//     site="hotmart" → strings.Contains("hotmart.com", "hotmart") → ✓
	if storedCookies == "" && site != "" {
		for storedDomain, c := range m.storage {
			if strings.Contains(storedDomain, site) {
				storedCookies = c
				break
			}
		}
	}

	// ── Camada 3: fallback por domínio raiz (eTLD+1) ───────────────────────
	// Extrai "hotmart.com" de "cf-media.hotmart.com" e busca no storage.
	// Cobre casos onde a extensão armazenou cookies pelo domínio principal
	// e o CDN usa um subdomínio não listado no site handler.
	if storedCookies == "" {
		root := rootDomain(domain)
		if root != "" && root != domain {
			for storedDomain, c := range m.storage {
				if domainMatches(root, storedDomain) || strings.HasSuffix(storedDomain, "."+root) {
					storedCookies = c
					break
				}
			}
		}
	}

	// Mesclar: armazenados como base + extensão sobrescreve
	return mergeCookies(storedCookies, extensionCookies)
}

// rootDomain extrai o domínio raiz (eTLD+1) de um hostname.
// "cf-media.hotmart.com" → "hotmart.com"
// "player.vimeo.com"     → "vimeo.com"
// "hotmart.com"          → "hotmart.com" (já é raiz)
func rootDomain(host string) string {
	parts := strings.Split(host, ".")
	if len(parts) >= 2 {
		return strings.Join(parts[len(parts)-2:], ".")
	}
	return host
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
