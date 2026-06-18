# IDM Linux Bridge

Solução completa para usar o **Internet Download Manager (IDM)** no Linux via Wine, capturando downloads e mídias direto do navegador — sem depender do driver WFP/BFE do Windows, que não existe no Wine.

> **Versão atual:** `3.0.0` (proxy e extensão Chrome). Ver [`CHANGELOG.md`](./CHANGELOG.md) para o histórico de mudanças e a convenção de versionamento adotada pelo projeto.

## Como funciona

```
Navegador (Linux)
    │
    │  webRequest + interceptação de fetch/XHR/HLS (extensão)
    ▼
Proxy Bridge (Go) ←── 127.0.0.1:6969
    │
    │  wine IDMan.exe /d <url> + cookies + headers
    │  (ou merge de streams via ffmpeg/yt-dlp, quando necessário)
    ▼
IDM rodando no Wine
```

O driver de rede WFP que o IDM usa no Windows não existe no Wine. A extensão intercepta downloads e streams de mídia no navegador, envia os metadados (URL, cookies, referrer, qualidade selecionada) a um proxy local em Go, que repassa ao IDM via linha de comando Wine — sem precisar do driver.

## Recursos

- **Download genérico**: qualquer link de arquivo (zip, exe, iso, etc.) é interceptado e enviado ao IDM, com cookies e headers da sessão do navegador.
- **Captura de mídia em players**: botão flutuante injetado sobre o player, com dropdown de qualidades disponíveis.
  - **YouTube**: captura formatos muxed e adaptativos (vídeo+áudio separados), incluindo qualidades acima de 1080p (requer um segundo fetch com cliente ANDROID, já feito automaticamente). Pareamento automático de vídeo-only com o melhor áudio disponível. Suporte a Shorts (incluindo a shelf de prévias na home).
  - **TikTok**: detecção de vídeo ativo durante scroll infinito.
  - **Players genéricos**: JW Player (incluindo extração profunda via listeners internos), Video.js, Hls.js, dash.js, Flowplayer, Plyr, Brightcove, e fallback por Content-Type HTTP para streams servidos sem extensão na URL (TS/MKV/MP4/HLS).
- **Merge de streams**:
  - Fallback via `yt-dlp` com seletor de formato construído a partir do itag/altura escolhidos no dropdown (não força mais `bestvideo+bestaudio` ignorando a escolha do usuário).
  - Merge direto via `ffmpeg` para streams DASH separados do YouTube (vídeo + áudio), sem depender do yt-dlp.
- **Botão flutuante com posicionamento inteligente**:
  - Recorte de área visível (`getClippedRect`) para players com `object-fit: cover` que "vazam" da área do card (grade da home do YouTube, Shorts shelf).
  - Hit-test por posição do mouse (não por eventos de hover) — robusto contra players de prévia criados de forma assíncrona pelo site.
  - Arquitetura de dual-button: quando há um player principal ativo e o usuário aponta para outro player em modo preview, uma segunda instância do botão é criada para o preview, sem mover o botão do player principal.
  - Reset de posição em três situações: navegação de página, troca de mídia no mesmo player, ou fechamento explícito pelo usuário.
- **Detecção de servidor gráfico (X11/Wayland)** com cache persistente em disco, monitoramento contínuo de mudanças de sessão (logon/logoff, troca de compositor) e reinício automático do bridge quando o servidor gráfico ativo diverge do que foi usado na inicialização.
- **Deduplicação de downloads** por `requestId` do `webRequest` — evita captura duplicada em sites com cadeia de redirecionamento (GitHub Releases, GnomeLook, etc.).
- **Gerenciamento de sessão por site**: cookies e tokens coletados automaticamente para sites com autenticação (Google Drive, Hotmart, Udemy, Coursera, etc.).
- **Multi-navegador**: pastas dedicadas para Chrome, Edge, Firefox e Opera em `extension/`, cada uma com seu `manifest.json` ajustado às particularidades da plataforma (MV3 `service_worker` vs `scripts`, permissões específicas do Firefox).

## Requisitos

- Linux (Ubuntu 20.04+, Debian 11+, Fedora 36+, Arch)
- Wine instalado (`sudo apt install wine`)
- IDM instalado no prefixo Wine
- Go 1.21+ (para compilar o proxy)
- `ffmpeg` (merge de streams DASH/YouTube) e `yt-dlp` (fallback de extração) — opcionais, mas recomendados para captura completa de mídia
- Chrome, Chromium, Edge, Firefox ou Opera

## Instalação rápida

```bash
git clone https://github.com/seu-usuario/idm-linux-bridge
cd idm-linux-bridge
chmod +x scripts/install.sh
./scripts/install.sh
```

O instalador interativo vai:

1. Verificar e instalar dependências (Go, Wine)
2. Compilar o proxy Go (a versão exibida no log é lida diretamente do código-fonte)
3. Criar o arquivo de configuração
4. **Perguntar o modo de inicialização**: com o sistema (systemd + `loginctl enable-linger`, disponível antes do login gráfico) ou após o login (XDG Autostart, recomendado — garante acesso correto às variáveis de ambiente gráficas)
5. Guiar a instalação da extensão no navegador

Para automação sem prompts: `./scripts/install.sh --auto` (modo login, padrão seguro) ou `./scripts/install.sh --auto-boot` (modo boot). Para apenas trocar o modo de inicialização depois de já instalado: `./scripts/install.sh --change-startup`.

## Instalação manual

### 1. Compilar o proxy

```bash
make build
make install
```

`make version` exibe a versão atual lida diretamente de `proxy/internal/server/server.go`.

### 2. Configurar

```bash
mkdir -p ~/.config/idm-bridge
cat > ~/.config/idm-bridge/config.env << EOF
BRIDGE_PORT=6969
BRIDGE_HOST=127.0.0.1
WINE_PREFIX=$HOME/.wine
IDM_PATH=$HOME/.wine/drive_c/Program Files (x86)/Internet Download Manager/IDMan.exe
VERBOSE=false
EOF
```

### 3. Iniciar como serviço

Duas formas de inicialização são suportadas — escolha uma:

**Com o sistema (systemd, antes do login):**
```bash
loginctl enable-linger $(whoami)
cp scripts/idm-bridge.service ~/.config/systemd/user/
systemctl --user enable --now idm-bridge
```

**Após o login (XDG Autostart, recomendado):**
```bash
cp scripts/idm-bridge.service ~/.config/systemd/user/
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/idm-bridge.desktop << EOF
[Desktop Entry]
Type=Application
Name=IDM Linux Bridge
Exec=systemctl --user start idm-bridge
X-GNOME-Autostart-Delay=3
EOF
systemctl --user start idm-bridge
```

Ver logs em tempo real: `journalctl --user -u idm-bridge -f`.

### 4. Instalar a extensão

Cada navegador tem sua própria pasta pronta em `extension/`:

**Chrome / Chromium / Edge / Opera (todos baseados em Chromium):**
1. Abra `chrome://extensions` (ou `edge://extensions`, `opera://extensions`)
2. Ative o "Modo do desenvolvedor"
3. Clique em "Carregar sem compactação"
4. Selecione a pasta correspondente: `extension/chrome`, `extension/edge` ou `extension/opera`

**Firefox:**
1. Abra `about:debugging#/runtime/this-firefox`
2. "Carregar extensão temporária" → selecione `extension/firefox/manifest.json`

> O conteúdo de `src/` é idêntico entre as 4 pastas; o que muda é apenas o `manifest.json` (Firefox usa `background.scripts` em vez de `service_worker`, adiciona `webRequestBlocking` e `browser_specific_settings.gecko`, e omite `declarativeNetRequest`).

### Instalação alternativa: pós-instalação automatizada

```bash
./scripts/post_install_browsers.sh
```

Detecta os navegadores instalados e, para cada um, pergunta se você quer instalar a extensão **via terceiros** (forçada por política do navegador — requer root, sobrevive a reinícios do navegador sem precisar recarregar manualmente) ou prefere apenas ver as instruções de carregamento manual acima.

- **Chrome/Edge**: gera um `.crx3` assinado e instala via política `ExtensionInstallForcelist`.
- **Opera**: sempre direciona para instalação manual — o navegador não implementa o mecanismo de políticas do Chromium, então a via "terceiros" não tem efeito nele.
- **Firefox**: gera um `.xpi` e tenta via `policies.json`, mas com aviso de que isso só funciona de fato em Firefox ESR/Developer Edition ou com extensão assinada pela Mozilla — em Firefox estável a instalação tende a ser rejeitada silenciosamente.

Os artefatos gerados (`.crx`/`.xpi`, update manifests, chaves de assinatura) ficam em `build/` e `.keys/` na raiz do projeto (ambos já no `.gitignore`).

## Configuração de sites específicos

O bridge tem tratamento especial para sites que requerem autenticação. Os cookies são automaticamente coletados do navegador e enviados ao IDM.

### Sites suportados out-of-the-box

| Site | Cookies críticos | Auth necessária |
|------|-----------------|-----------------|
| YouTube | VISITOR_INFO1_LIVE, YSC, HSID | Não |
| Google Drive | SID, HSID, __Secure-1PSID | Sim |
| Hotmart | access_token, club_token | Sim |
| Udemy | access_token, ud_cache_user | Sim |
| Coursera | CAUTH, csrftoken | Sim |
| Dropbox | t, jar | Sim |
| OneDrive | MUID, PPAuth | Sim |
| Mega | sid | Sim |
| Twitch | auth-token | Sim |
| Vimeo | vuid | Não |

### Adicionar suporte a um site novo

Os handlers de site ficam em `proxy/internal/session/manager.go`. Adicione um novo `SiteHandler`:

```go
{
    Name:        "MeuSite",
    Domains:     []string{"meusite.com", "cdn.meusite.com"},
    TokenFields: []string{"session_token", "user_id"},
    NeedsAuth:   true,
},
```

## API do proxy

O proxy expõe endpoints HTTP na porta 6969 (configurável).

### `GET /status`

Verifica se o bridge está rodando e qual servidor gráfico está em uso.

```json
{
  "status": "running",
  "version": "3.0.0",
  "idmFound": true,
  "winePrefix": "/home/user/.wine",
  "reverseProxy": "127.0.0.1:43217"
}
```

### `POST /capture`

Envia um download ou stream de mídia ao IDM. Campos relevantes para captura de vídeo:

```json
{
  "url": "https://exemplo.com/video.mp4",
  "audioUrl": "https://exemplo.com/audio.m4a",
  "filename": "video.mp4",
  "cookies": "session=abc; token=xyz",
  "referrer": "https://exemplo.com/pagina",
  "site": "youtube",
  "itag": "313",
  "audioItag": "140",
  "height": 2160,
  "needsMerge": true,
  "videoId": "dQw4w9WgXcQ"
}
```

- `audioUrl` presente → merge direto via `ffmpeg` (streams DASH separados, sem yt-dlp).
- `itag`/`height` sem `audioUrl` → fallback via `yt-dlp`, com seletor de formato construído a partir desses campos.
- Nenhum dos dois → download direto (arquivo único, comportamento padrão).

### `GET /{jobId}/s?u={url}`

Proxy reverso de segmentos HLS/DASH — usado internamente para reescrever manifests M3U8 antes de entregá-los ao IDM, tunelizando os segmentos pelo bridge.

### `POST /cookies`

Armazena cookies para um domínio (persistidos em disco).

```json
{
  "domain": "hotmart.com",
  "cookies": "access_token=abc123; club_token=xyz"
}
```

### `POST /session`

Armazena dados de sessão de um site.

```json
{
  "site": "hotmart",
  "data": {
    "access_token": "abc123",
    "user_id": "456"
  }
}
```

## Comandos úteis

```bash
# Ver versão atual do proxy (lida do código-fonte)
make version

# Ver status do bridge
curl http://127.0.0.1:6969/status

# Testar envio manual de download
curl -X POST http://127.0.0.1:6969/capture \
  -H "Content-Type: application/json" \
  -d '{"url":"https://exemplo.com/arquivo.mp4"}'

# Ver logs em tempo real
make logs

# Reiniciar após mudança de configuração
make service-restart

# Parar o bridge
make service-stop

# Trocar modo de inicialização (boot ↔ login)
./scripts/install.sh --change-startup
```

## Solução de problemas

**IDM não inicia:**
```bash
wine "$HOME/.wine/drive_c/Program Files (x86)/Internet Download Manager/IDMan.exe"
```

**Bridge não responde:**
```bash
journalctl --user -u idm-bridge --no-pager -n 50
```

**Bridge detectou o servidor gráfico errado (X11 quando devia ser Wayland, ou vice-versa):**
- O bridge mantém um cache persistente em `~/.config/idm-bridge/display-server.conf`, atualizado a cada logon e a cada troca de sessão.
- Se o cache estiver claramente incorreto, apague o arquivo e reinicie o serviço — a próxima detecção será feita do zero.
- Verifique os logs: `journalctl --user -u idm-bridge -f | grep DISPLAY`.

**Extensão não detecta o bridge:**
- Verifique se a porta 6969 está livre: `ss -tlnp | grep 6969`
- Verifique se o CORS está habilitado (está por padrão)
- Recarregue a extensão na página de extensões do navegador

**Downloads não chegam ao IDM, ou chegam duplicados:**
- Ative o modo verbose no config: `VERBOSE=true`
- Recarregue o serviço: `systemctl --user restart idm-bridge`
- Monitore os logs: `make logs`
- Captura duplicada em sites com redirecionamento (GitHub, GnomeLook): já mitigado por deduplicação via `requestId`; se persistir, verifique se há mais de uma instância do bridge rodando (`ps aux | grep idm-bridge`).

**Botão flutuante não aparece ou se comporta de forma inesperada:**
- Em sites com o player isolado num iframe cross-origin não detectável, o botão entra em modo "flutuante livre" (canto da viewport, sem interceptar cliques da página).
- Para Shorts/grades de prévia do YouTube: o botão usa hit-test por posição do mouse, não eventos de hover — deve funcionar mesmo com players criados de forma assíncrona pelo site.

## Estrutura do projeto

```
idm-linux-bridge/
├── .gitignore                  # build/, .keys/, bin/ — artefatos não versionados
├── CHANGELOG.md               # Histórico de versões (SemVer)
├── Makefile
├── README.md
├── proxy/                     # Proxy bridge em Go
│   ├── cmd/bridge/main.go     # Ponto de entrada
│   └── internal/
│       ├── server/            # Servidor HTTP, roteamento, const Version
│       ├── idm/                # Lançador do IDM via Wine, dividido por responsabilidade:
│       │   ├── types.go              # Tipos centrais (DisplayServer, DownloadJob, Launcher)
│       │   ├── launcher.go           # Construtor e acessores
│       │   ├── launch.go             # Lançamento de jobs e ambiente do processo
│       │   ├── display_cache.go      # Cache persistente do servidor gráfico
│       │   ├── display_probe.go      # Detecção ao vivo (loginctl, /proc)
│       │   ├── display_watch.go      # Monitoramento contínuo + eventos de logon
│       │   ├── idm_process.go        # Detecção do processo IDM em execução
│       │   ├── proxy_server.go       # Proxy reverso HTTP para CDNs de mídia
│       │   ├── restart.go            # Canal de reinício
│       │   ├── youtube_merge.go      # Resolução de URLs YouTube, fallback yt-dlp
│       │   ├── youtube_dash.go       # Merge direto DASH via ffmpeg
│       │   ├── youtube_nsig.go       # Resolução do parâmetro 'n' via goja
│       │   ├── http_helpers.go       # Reescrita de manifests HLS, respostas HTTP
│       │   └── fileutil.go           # MIME, sanitização de nomes, localização do Wine
│       ├── cookies/            # Gerenciamento de cookies persistentes
│       └── session/            # Sessões e handlers de sites específicos
├── extension/                  # Extensões do navegador (MV3), uma pasta por navegador
│   ├── README.md
│   ├── build.sh
│   ├── chrome/                 # Prioridade de desenvolvimento — correções aqui primeiro
│   │   ├── manifest.json
│   │   ├── src/
│   │   │   ├── interceptor.js        # MAIN world: fetch/XHR/HLS, captura de mídia
│   │   │   ├── page_inject.js        # ISOLATED world: relay entre frames
│   │   │   ├── parser_m3u8.js        # Parser de manifests HLS
│   │   │   ├── content.js            # Botão flutuante, dropdown, posicionamento
│   │   │   ├── background.js         # Service worker: interceptação de downloads
│   │   │   ├── popup.html / popup.js
│   │   │   └── downloads.html / downloads_page.js
│   │   └── icons/
│   ├── edge/                   # Idêntico ao chrome/ (MV3 Chromium padrão)
│   ├── opera/                  # Idêntico ao chrome/ (MV3 Chromium padrão)
│   └── firefox/                # manifest.json ajustado (scripts, webRequestBlocking, gecko)
└── scripts/
    ├── install.sh              # Instalador interativo (modo boot ou login)
    ├── post_install_browsers.sh # Instala a extensão via política ou orienta carregamento manual
    └── build_crx.py             # Gera .crx3 assinado (usado por post_install_browsers.sh)
```

## Versionamento

O projeto segue [SemVer](https://semver.org/lang/pt-BR/), com proxy e extensão Chrome versionados de forma independente. Ver [`CHANGELOG.md`](./CHANGELOG.md) para o histórico completo e a convenção adotada para futuras mudanças.

## Licença

MIT
