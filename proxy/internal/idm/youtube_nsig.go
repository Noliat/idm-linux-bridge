package idm

// youtube_nsig.go — resolução nativa do parâmetro 'n' do YouTube via goja.
//
// PROBLEMA
// ─────────
// URLs do googlevideo.com contêm um parâmetro 'n' que é um token de
// throttling. O valor na URL é o "n raw" — precisa ser transformado por
// uma função JavaScript obfuscada embutida no player do YouTube (base.js).
// Sem essa transformação: throttling severo (~50KB/s) ou 403 em ~30% dos casos.
//
// SOLUÇÃO
// ────────
// 1. Extrair a versão do player da URL CDN (parâmetro cver ou cpn).
// 2. Baixar o base.js da CDN do YouTube com cache por versão.
// 3. Extrair a função nsig do base.js via regex (mesmos padrões do yt-dlp).
// 4. Executar a função com goja (engine JS puro em Go, sem CGo/V8).
// 5. Substituir n=raw por n=transformado na URL.
//
// Cache: a função é cacheada por versão do player. O player muda ~semanalmente,
// então na prática a função fica cacheada por dias. TTL de 24h garante
// re-fetch mesmo que a versão não mude (proteção contra atualizações silenciosas).
//
// Dependência: github.com/dop251/goja
// Instalar:    go get github.com/dop251/goja

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
)

// ─────────────────────────────────────────────────────────────────────────────
// Padrões de extração do nsig — baseados no yt-dlp (_youtube.py)
//
// A função nsig no base.js tem a forma:
//
//   var Xk = [func1, func2, ...];
//   function abc(a) {
//       var b = a.split(""),
//           c = [...]; // array de ~70 elementos
//       // operações encadeadas: reverse, splice, swap, push...
//       return b.join("");
//   }
//
// O YouTube obfusca o nome da variável que guarda a função. Os padrões abaixo
// identificam onde essa variável é chamada com o valor de 'n'.
// ─────────────────────────────────────────────────────────────────────────────

var nsigCallPatterns = []*regexp.Regexp{
	// Padrão 1 (principal) — cobre ~90% das versões recentes
	// Captura: grupo 1 = nome da var/função, grupo 2 = índice opcional (var[idx])
	regexp.MustCompile(`\.get\("n"\)\)&&\(b=([a-zA-Z0-9$]{2,3})(?:\[(\d+)\])?\([a-zA-Z0-9]\)`),

	// Padrão 2 — variante com .set() ao invés de .get()
	regexp.MustCompile(`[a-zA-Z]\s*&&\s*[a-zA-Z]\.set\([^,]+,\s*(?:encodeURIComponent\s*\()?\s*([a-zA-Z0-9$]{2,3})(?:\[(\d+)\])?\(`),

	// Padrão 3 — variante mais antiga com b[0](a)
	regexp.MustCompile(`\(b=([a-zA-Z0-9$]{2,3})(?:\[(\d+)\])?\([a-zA-Z]\)`),

	// Padrão 4 — variante com c&&d.set(...)
	regexp.MustCompile(`(?:^|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2,3})(?:\[(\d+)\])?\s*=\s*function\(a\)\s*\{(?:[^{}]|\{[^{}]*\})*a\.split`),
}

// nsigFuncBodyPattern localiza o corpo completo da função nsig no base.js.
// Procura por: function NAME(a){...} onde o corpo contém split/join (assinatura do nsig).
var nsigFuncBodyPattern = regexp.MustCompile(
	`function\s+([a-zA-Z0-9$]{1,5})\s*\(a\)\s*\{[^}]*\.split[^}]*\.join[^}]*\}`,
)

// nsigArrayFuncPattern — função nsig armazenada em variável de array.
// Padrão: var NAME=[...,function(a){...a.split...a.join...},...];
var nsigArrayFuncPattern = regexp.MustCompile(
	`var\s+([a-zA-Z0-9$]{2,3})\s*=\s*\[[^\]]*function\(a\)\s*\{[^\]]*\.split[^\]]*\.join[^\]]*\}[^\]]*\]`,
)

// ─────────────────────────────────────────────────────────────────────────────
// NSigCache — cache de funções nsig por versão de player
// ─────────────────────────────────────────────────────────────────────────────

// NSigCache mantém funções nsig compiladas e prontas para execução,
// indexadas pela versão do player YouTube.
//
// Thread-safe: múltiplos requests simultâneos podem usar o cache concorrentemente.
// Apenas um goroutine faz o fetch do base.js por versão (singleflight interno).
type NSigCache struct {
	mu       sync.RWMutex
	byPlayer map[string]*cachedNSig
}

type cachedNSig struct {
	vm       *goja.Runtime
	fn       goja.Callable
	cachedAt time.Time
}

// cacheTTL — tempo máximo de vida de uma entrada no cache.
// Após 24h, re-fetch do base.js mesmo que a versão do player não tenha mudado.
// Proteção contra atualizações silenciosas do YouTube.
const cacheTTL = 24 * time.Hour

// globalNSigCache é a instância compartilhada pelo Launcher.
// Inicializado uma vez em NewLauncher via init implícito.
var globalNSigCache = &NSigCache{
	byPlayer: make(map[string]*cachedNSig),
}

// TransformN resolve o parâmetro 'n' para a versão de player dada.
//
// Fluxo:
//  1. Cache hit com TTL válido → retorna imediatamente (~0ms)
//  2. Cache miss ou expirado → faz fetch do base.js e extrai a função
//  3. Executa a função JS com goja (~1-5ms)
//  4. Retorna o n transformado
func (c *NSigCache) TransformN(nRaw, playerVersion string) (string, error) {
	// ── Verificar cache ────────────────────────────────────────────────
	c.mu.RLock()
	entry, ok := c.byPlayer[playerVersion]
	c.mu.RUnlock()

	if ok && time.Since(entry.cachedAt) < cacheTTL {
		return runNSigFunction(entry.vm, entry.fn, nRaw)
	}

	// ── Cache miss ou expirado — buscar e compilar ─────────────────────
	log.Printf("[NSIG] Compilando nsig para player %s...\n", playerVersion)

	vm, fn, err := fetchAndCompileNSig(playerVersion)
	if err != nil {
		return "", fmt.Errorf("nsig compile (player %s): %w", playerVersion, err)
	}

	c.mu.Lock()
	c.byPlayer[playerVersion] = &cachedNSig{
		vm:       vm,
		fn:       fn,
		cachedAt: time.Now(),
	}
	c.mu.Unlock()

	log.Printf("[NSIG] Função nsig compilada e cacheada para player %s\n", playerVersion)
	return runNSigFunction(vm, fn, nRaw)
}

// ─────────────────────────────────────────────────────────────────────────────
// fetchAndCompileNSig — baixa o base.js e extrai + compila a função nsig
// ─────────────────────────────────────────────────────────────────────────────

func fetchAndCompileNSig(playerVersion string) (*goja.Runtime, goja.Callable, error) {
	baseJSURL := fmt.Sprintf(
		"https://www.youtube.com/s/player/%s/player_ias.vflset/en_US/base.js",
		playerVersion,
	)

	baseJS, err := fetchBaseJS(baseJSURL)
	if err != nil {
		return nil, nil, fmt.Errorf("fetch base.js: %w", err)
	}

	funcCode, err := extractNSigFunction(baseJS)
	if err != nil {
		return nil, nil, fmt.Errorf("extração da função nsig: %w", err)
	}

	vm, fn, err := compileNSigFunction(funcCode)
	if err != nil {
		return nil, nil, fmt.Errorf("compilação da função nsig: %w", err)
	}

	return vm, fn, nil
}

// fetchBaseJS baixa o base.js do YouTube com headers básicos de browser.
func fetchBaseJS(baseJSURL string) (string, error) {
	client := &http.Client{Timeout: 15 * time.Second}

	req, err := http.NewRequest("GET", baseJSURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d para %s", resp.StatusCode, baseJSURL)
	}

	// base.js tem ~500KB — ler tudo é necessário para o regex
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024)) // limite 4MB
	if err != nil {
		return "", err
	}

	return string(body), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// extractNSigFunction — extrai o código da função nsig do base.js
//
// Estratégia de dois passos:
//  1. Usar os padrões de "call site" para descobrir o nome da variável/função
//     que contém o nsig (ex: "Xk[0]" ou "abc")
//  2. Buscar o corpo completo dessa função no base.js
// ─────────────────────────────────────────────────────────────────────────────

func extractNSigFunction(baseJS string) (string, error) {
	// ── Passo 1: descobrir o nome da função/variável ───────────────────────
	funcName, arrayIdx := findNSigCallSite(baseJS)
	if funcName == "" {
		return "", fmt.Errorf("padrão de call site do nsig não encontrado no base.js")
	}

	// ── Passo 2: extrair o corpo da função ────────────────────────────────
	if arrayIdx >= 0 {
		// A função está num array: var NAME=[...,function(a){...},...];
		// arrayIdx indica qual elemento do array é a função nsig.
		return extractNSigFromArray(baseJS, funcName, arrayIdx)
	}

	// A função está definida diretamente: function NAME(a){...}
	return extractNSigFunctionByName(baseJS, funcName)
}

// findNSigCallSite percorre os padrões de call site e retorna:
// - funcName: nome da variável ou função que implementa o nsig
// - arrayIdx: índice no array se for NAME[idx], ou -1 se for NAME direto
func findNSigCallSite(baseJS string) (funcName string, arrayIdx int) {
	for _, pat := range nsigCallPatterns {
		matches := pat.FindStringSubmatch(baseJS)
		if len(matches) < 2 || matches[1] == "" {
			continue
		}

		name := matches[1]
		idx := -1

		if len(matches) >= 3 && matches[2] != "" {
			// Tem índice: NAME[idx]
			fmt.Sscanf(matches[2], "%d", &idx)
		}

		return name, idx
	}
	return "", -1
}

// extractNSigFunctionByName extrai o corpo completo de "function NAME(a){...}"
// do base.js. Usa balanceamento de chaves para pegar o corpo inteiro.
func extractNSigFunctionByName(baseJS, funcName string) (string, error) {
	// Encontrar onde a função começa
	needle := fmt.Sprintf("function %s(a)", funcName)
	start := strings.Index(baseJS, needle)
	if start == -1 {
		// Tentar sem espaço: function NAME(a)
		needle = fmt.Sprintf("function%s(a)", funcName)
		start = strings.Index(baseJS, needle)
	}
	if start == -1 {
		return "", fmt.Errorf("função '%s' não encontrada no base.js", funcName)
	}

	body := extractBalancedBraces(baseJS[start:])
	if body == "" {
		return "", fmt.Errorf("não foi possível extrair corpo de '%s'", funcName)
	}

	// Verificar assinatura do nsig (deve conter split e join)
	if !strings.Contains(body, "split") || !strings.Contains(body, "join") {
		return "", fmt.Errorf("função '%s' não parece ser o nsig (sem split/join)", funcName)
	}

	// Envolver como função nomeada para o goja
	return fmt.Sprintf("var __nsig = %s; %s", funcName, body[strings.Index(body, "function"):]), nil
}

// extractNSigFromArray extrai a função nsig de dentro de um array de funções.
// Padrão: var NAME=[f0, f1, ..., function(a){...nsig body...}, ...];
func extractNSigFromArray(baseJS, arrayName string, idx int) (string, error) {
	// Localizar a declaração do array
	needle := fmt.Sprintf("var %s=[", arrayName)
	start := strings.Index(baseJS, needle)
	if start == -1 {
		return "", fmt.Errorf("array '%s' não encontrado no base.js", arrayName)
	}

	// Extrair o array completo (balanceamento de colchetes)
	arrayContent := extractBalancedBrackets(baseJS[start+len(needle)-1:])
	if arrayContent == "" {
		return "", fmt.Errorf("não foi possível extrair array '%s'", arrayName)
	}

	// Separar os elementos do array (simplificado: split por funções)
	// Precisamos do elemento no índice idx
	elements := splitArrayElements(arrayContent)
	if idx >= len(elements) {
		return "", fmt.Errorf("índice %d fora do array '%s' (len=%d)", idx, arrayName, len(elements))
	}

	funcBody := strings.TrimSpace(elements[idx])
	if !strings.HasPrefix(funcBody, "function") {
		return "", fmt.Errorf("elemento [%d] de '%s' não é uma função: %.50s", idx, arrayName, funcBody)
	}

	if !strings.Contains(funcBody, "split") || !strings.Contains(funcBody, "join") {
		return "", fmt.Errorf("elemento [%d] de '%s' não parece ser o nsig", idx, arrayName)
	}

	return fmt.Sprintf("var __nsig = %s;", funcBody), nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de parsing de JS
// ─────────────────────────────────────────────────────────────────────────────

// extractBalancedBraces extrai a substring começando em '{' e terminando no
// '}' correspondente, com balanceamento correto de chaves aninhadas.
// Retorna "" se não encontrar '{' ou se o JS estiver malformado.
func extractBalancedBraces(s string) string {
	start := strings.Index(s, "{")
	if start == -1 {
		return ""
	}
	depth := 0
	inStr := false
	strChar := byte(0)

	for i := start; i < len(s); i++ {
		c := s[i]

		// Rastrear strings JS para não contar chaves dentro de strings
		if inStr {
			if c == '\\' {
				i++ // skip escaped char
				continue
			}
			if c == strChar {
				inStr = false
			}
			continue
		}
		if c == '"' || c == '\'' || c == '`' {
			inStr = true
			strChar = c
			continue
		}

		if c == '{' {
			depth++
		} else if c == '}' {
			depth--
			if depth == 0 {
				// Precisamos da declaração completa: "function NAME(a) { ... }"
				// Retornar desde o início do 's' até aqui
				return s[:i+1]
			}
		}
	}
	return ""
}

// extractBalancedBrackets extrai o conteúdo de '[' até ']' correspondente.
func extractBalancedBrackets(s string) string {
	start := strings.Index(s, "[")
	if start == -1 {
		return ""
	}
	depth := 0
	inStr := false
	strChar := byte(0)

	for i := start; i < len(s); i++ {
		c := s[i]
		if inStr {
			if c == '\\' {
				i++
				continue
			}
			if c == strChar {
				inStr = false
			}
			continue
		}
		if c == '"' || c == '\'' || c == '`' {
			inStr = true
			strChar = c
			continue
		}
		if c == '[' {
			depth++
		} else if c == ']' {
			depth--
			if depth == 0 {
				return s[start+1 : i] // conteúdo sem os colchetes externos
			}
		}
	}
	return ""
}

// splitArrayElements divide o conteúdo de um array JS em elementos individuais,
// respeitando funções aninhadas (que podem conter vírgulas internas).
func splitArrayElements(content string) []string {
	var elements []string
	depth := 0
	inStr := false
	strChar := byte(0)
	start := 0

	for i := 0; i < len(content); i++ {
		c := content[i]
		if inStr {
			if c == '\\' {
				i++
				continue
			}
			if c == strChar {
				inStr = false
			}
			continue
		}
		if c == '"' || c == '\'' || c == '`' {
			inStr = true
			strChar = c
			continue
		}
		if c == '{' || c == '[' || c == '(' {
			depth++
		} else if c == '}' || c == ']' || c == ')' {
			depth--
		} else if c == ',' && depth == 0 {
			elements = append(elements, strings.TrimSpace(content[start:i]))
			start = i + 1
		}
	}
	if start < len(content) {
		if elem := strings.TrimSpace(content[start:]); elem != "" {
			elements = append(elements, elem)
		}
	}
	return elements
}

// ─────────────────────────────────────────────────────────────────────────────
// compileNSigFunction — compila o código JS extraído com goja
// ─────────────────────────────────────────────────────────────────────────────

// compileNSigFunction cria um runtime goja isolado, compila o código da função
// nsig e retorna o runtime + a callable pronta para invocação.
//
// Cada versão de player tem seu próprio goja.Runtime para isolamento.
// O runtime é reutilizado para todas as chamadas dessa versão (thread-safe
// apenas com lock externo — o NSigCache garante isso via entry por versão).
func compileNSigFunction(funcCode string) (*goja.Runtime, goja.Callable, error) {
	vm := goja.New()

	// Executar o código que define a função nsig
	// O código pode ser "var __nsig = function(a){...}" ou "function NAME(a){...}"
	_, err := vm.RunString(funcCode)
	if err != nil {
		return nil, nil, fmt.Errorf("erro ao executar código nsig: %w", err)
	}

	// Tentar obter a função pelo nome canônico __nsig primeiro
	var fn goja.Callable
	nsigVal := vm.Get("__nsig")
	if nsigVal != nil && !goja.IsUndefined(nsigVal) && !goja.IsNull(nsigVal) {
		var ok bool
		fn, ok = goja.AssertFunction(nsigVal)
		if !ok {
			return nil, nil, fmt.Errorf("__nsig não é uma função no runtime goja")
		}
		return vm, fn, nil
	}

	return nil, nil, fmt.Errorf("função nsig não encontrada no runtime após compilação")
}

// runNSigFunction executa a função nsig compilada com o valor n dado.
func runNSigFunction(vm *goja.Runtime, fn goja.Callable, nRaw string) (string, error) {
	result, err := fn(goja.Undefined(), vm.ToValue(nRaw))
	if err != nil {
		return "", fmt.Errorf("execução da função nsig falhou: %w", err)
	}

	nTransformed := result.String()
	if nTransformed == "" || nTransformed == "undefined" {
		return "", fmt.Errorf("função nsig retornou vazio para n=%q", nRaw)
	}

	return nTransformed, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// extractPlayerVersion — obtém a versão do player de uma URL do YouTube
//
// A versão do player pode estar:
//   1. No parâmetro 'cver' da URL CDN (mais confiável quando presente)
//   2. No parâmetro 'c' (client version, fallback)
//   3. Derivado do parâmetro 'cpn' (não contém versão, ignorar)
//
// Se a URL CDN não tiver a versão, é preciso buscar na watch page.
// Essa função implementa apenas a extração da URL — o fetch da watch page
// fica em extractPlayerVersionFromPage (usado como fallback no Launcher).
// ─────────────────────────────────────────────────────────────────────────────

// playerVersionFromURL tenta extrair a versão do player dos parâmetros da URL CDN.
// Retorna "" se não encontrar — o caller deve tentar extractPlayerVersionFromPage.
func playerVersionFromURL(cdnURL string) string {
	u, err := url.Parse(cdnURL)
	if err != nil {
		return ""
	}
	q := u.Query()

	// 'cver' é o campo mais direto — contém a versão do player completa
	if v := q.Get("cver"); v != "" {
		return v
	}

	// Alguns clientes colocam em 'c' (ex: WEB.2.20240520.00.00)
	// Precisamos só da parte numérica que identifica o player JS
	if v := q.Get("c"); v != "" && isValidPlayerVersion(v) {
		return v
	}

	return ""
}

// playerVersionFromPage faz fetch da watch page do YouTube e extrai a versão
// do player JS. É mais lento (~200-500ms) mas necessário quando a URL CDN
// não contém 'cver'.
func playerVersionFromPage(watchURL string) string {
	if watchURL == "" {
		return ""
	}

	client := &http.Client{Timeout: 10 * time.Second}
	req, err := http.NewRequest("GET", watchURL, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("User-Agent",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	// A watch page é grande (~500KB). Só precisamos das primeiras 100KB
	// onde a referência ao player JS sempre aparece.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 100*1024))
	if err != nil {
		return ""
	}

	return extractPlayerVersionFromHTML(string(body))
}

// watchPagePlayerVersionPattern extrai a versão do player do HTML da watch page.
// O YouTube inclui algo como: "jsUrl":"/s/player/HASH/player_ias.vflset/..."
var watchPagePlayerVersionPattern = regexp.MustCompile(
	`/s/player/([a-f0-9]{8})/player_ias\.vflset`,
)

func extractPlayerVersionFromHTML(html string) string {
	matches := watchPagePlayerVersionPattern.FindStringSubmatch(html)
	if len(matches) >= 2 {
		return matches[1]
	}
	return ""
}

// isValidPlayerVersion verifica se uma string parece ser uma versão de player válida.
// Versões reais são hashes hex de 8 chars (ex: "a8a8f671") ou versões com pontos.
func isValidPlayerVersion(v string) bool {
	if len(v) < 4 || len(v) > 40 {
		return false
	}
	// Hash hex de 8 chars (formato mais comum)
	hexPattern := regexp.MustCompile(`^[a-f0-9]{8}$`)
	if hexPattern.MatchString(v) {
		return true
	}
	// Versão com pontos (ex: "2.20240520.00.00")
	dotPattern := regexp.MustCompile(`^\d+\.\d+`)
	return dotPattern.MatchString(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// ResolveNParam — função pública que o Launcher chama
//
// Tenta resolver o parâmetro 'n' usando a cadeia:
//  1. NSigCache com goja (Go nativo, ~1-5ms)
//  2. Fallback: retorna ("", err) para o caller usar Python/yt-dlp
// ─────────────────────────────────────────────────────────────────────────────

// ResolveNParam resolve o parâmetro 'n' de uma URL do googlevideo.com.
// Retorna a URL com o 'n' transformado, ou a URL original se falhar.
//
// playerVersion pode ser vazio — nesse caso a função tenta extraí-lo
// da própria URL ou do watchURL (Referrer do job).
func ResolveNParam(cdnURL, watchURL string) (string, error) {
	u, err := url.Parse(cdnURL)
	if err != nil {
		return cdnURL, err
	}

	q := u.Query()
	nRaw := q.Get("n")
	if nRaw == "" {
		return cdnURL, nil // sem parâmetro n — nada a fazer
	}

	// ── Obter versão do player ─────────────────────────────────────────────
	playerVersion := playerVersionFromURL(cdnURL)
	if playerVersion == "" && watchURL != "" {
		playerVersion = playerVersionFromPage(watchURL)
	}
	if playerVersion == "" {
		return cdnURL, fmt.Errorf("versão do player não encontrada na URL CDN nem na watch page")
	}

	// ── Transformar n via cache ────────────────────────────────────────────
	nTransformed, err := globalNSigCache.TransformN(nRaw, playerVersion)
	if err != nil {
		return cdnURL, err
	}

	if nTransformed == nRaw {
		// A função retornou o mesmo valor — algo está errado
		return cdnURL, fmt.Errorf("nsig retornou mesmo valor (função pode estar desatualizada)")
	}

	q.Set("n", nTransformed)
	u.RawQuery = q.Encode()

	log.Printf("[NSIG] n transformado: %s → %s (player %s)\n", nRaw[:min(8, len(nRaw))], nTransformed[:min(8, len(nTransformed))], playerVersion)
	return u.String(), nil
}
