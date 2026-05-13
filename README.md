# IDM Linux Bridge

Solução completa para usar o **Internet Download Manager (IDM)** no Linux via Wine, substituindo o mecanismo de integração com o navegador que depende do driver WFP/BFE do Windows (não suportado pelo Wine).

## Como funciona

```
Navegador (Linux)
    │
    │  webRequest API (extensão)
    ▼
Proxy Bridge (Go) ←── 127.0.0.1:6969
    │
    │  wine IDMan.exe /d <url> + cookies + headers
    ▼
IDM rodando no Wine
```

O driver de rede WFP que o IDM usa no Windows **não existe no Wine**. A solução intercepta os downloads no navegador via extensão, envia os metadados (URL, cookies, referrer) a um proxy local em Go, que repassa ao IDM via linha de comando Wine — sem precisar do driver.

## Requisitos

- Linux (Ubuntu 20.04+, Debian 11+, Fedora 36+, Arch)
- Wine instalado (`sudo apt install wine`)
- IDM instalado no prefixo Wine
- Go 1.21+ (para compilar o proxy)
- Chrome, Chromium ou Firefox

## Instalação rápida

```bash
git clone https://github.com/seu-usuario/idm-linux-bridge
cd idm-linux-bridge
chmod +x scripts/install.sh
./scripts/install.sh
```

O instalador vai:
1. Verificar e instalar dependências (Go, Wine)
2. Compilar o proxy Go
3. Criar o arquivo de configuração
4. Registrar como serviço systemd do usuário
5. Guiar a instalação da extensão no navegador

## Instalação manual

### 1. Compilar o proxy

```bash
make install
```

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

```bash
# Copiar arquivo de serviço
cp scripts/idm-bridge.service ~/.config/systemd/user/

# Habilitar e iniciar
systemctl --user enable --now idm-bridge

# Ver logs
journalctl --user -u idm-bridge -f
```

### 4. Instalar extensão

**Chrome/Chromium:**
1. Abra `chrome://extensions`
2. Ative "Modo do desenvolvedor"
3. Clique em "Carregar sem compactação"
4. Selecione a pasta `extension/`

**Firefox:**
1. Abra `about:debugging#/runtime/this-firefox`
2. "Carregar extensão temporária" → selecione `extension/manifest.json`

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

O proxy expõe 4 endpoints na porta 6969:

### `GET /status`
Verifica se o bridge está rodando.

```json
{
  "status": "running",
  "version": "1.0.0",
  "idmFound": true,
  "winePrefix": "/home/user/.wine"
}
```

### `POST /capture`
Envia um download ao IDM.

```json
{
  "url": "https://exemplo.com/arquivo.zip",
  "filename": "arquivo.zip",
  "cookies": "session=abc; token=xyz",
  "referrer": "https://exemplo.com/pagina",
  "userAgent": "Mozilla/5.0...",
  "site": "exemplo.com",
  "headers": {}
}
```

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
```

## Solução de problemas

**IDM não inicia:**
```bash
# Testar se o Wine consegue rodar o IDM diretamente
wine "$HOME/.wine/drive_c/Program Files (x86)/Internet Download Manager/IDMan.exe"
```

**Bridge não responde:**
```bash
journalctl --user -u idm-bridge --no-pager -n 50
```

**Extensão não detecta o bridge:**
- Verifique se a porta 6969 está livre: `ss -tlnp | grep 6969`
- Verifique se o CORS está habilitado (está por padrão)
- Recarregue a extensão em `chrome://extensions`

**Downloads não chegam ao IDM:**
- Ative o modo verbose no config: `VERBOSE=true`
- Recarregue o serviço: `systemctl --user restart idm-bridge`
- Monitore os logs: `make logs`

## Estrutura do projeto

```
idm-linux-bridge/
├── proxy/                    # Proxy bridge em Go
│   ├── cmd/bridge/main.go    # Ponto de entrada
│   └── internal/
│       ├── server/           # Servidor HTTP e roteamento
│       ├── idm/              # Lançador do IDM via Wine
│       ├── cookies/          # Gerenciamento de cookies
│       └── session/          # Sessões de sites específicos
├── extension/                # Extensão do navegador (MV3)
│   ├── manifest.json
│   ├── src/
│   │   ├── background.js     # Service worker (interceptação)
│   │   ├── content.js        # Injetado nas páginas
│   │   ├── popup.html        # Interface do popup
│   │   └── popup.js
│   └── icons/
├── scripts/
│   └── install.sh            # Instalador automatizado
├── Makefile
└── README.md
```

## Licença

MIT
