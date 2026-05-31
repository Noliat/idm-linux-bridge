#!/usr/bin/env bash
# ============================================================
# IDM Linux Bridge — Instalador Automatizado
# Compatível com: Ubuntu 20.04+, Debian 11+, Fedora 36+, Arch
# ============================================================
set -euo pipefail

# ─── Cores ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

# ─── Configurações padrão ────────────────────────────────────
BRIDGE_VERSION="2.0.0"
INSTALL_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/idm-bridge"
SERVICE_DIR="$HOME/.config/systemd/user"
BRIDGE_PORT=6969
WINE_PREFIX="$HOME/.wine"
IDM_DEFAULT_PATH="$WINE_PREFIX/drive_c/Program Files (x86)/Internet Download Manager/IDMan.exe"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Helpers ─────────────────────────────────────────────────

log()     { echo -e "${GREEN}[✓]${NC} $*"; }
info()    { echo -e "${BLUE}[i]${NC} $*"; }
warn()    { echo -e "${YELLOW}[!]${NC} $*"; }
error()   { echo -e "${RED}[✗]${NC} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }
ask()     { echo -en "${YELLOW}[?]${NC} $1 "; }

# ─── Verificar sistema operacional ───────────────────────────

detect_distro() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_LIKE="${ID_LIKE:-}"
  elif command -v lsb_release &>/dev/null; then
    DISTRO_ID=$(lsb_release -si | tr '[:upper:]' '[:lower:]')
  else
    DISTRO_ID="unknown"
  fi
}

get_pkg_manager() {
  if command -v apt-get &>/dev/null; then echo "apt"
  elif command -v dnf &>/dev/null;     then echo "dnf"
  elif command -v pacman &>/dev/null;  then echo "pacman"
  elif command -v zypper &>/dev/null;  then echo "zypper"
  else echo "unknown"; fi
}

# ─── Instalação de dependências ──────────────────────────────

install_dependencies() {
  header "Verificando dependências"

  local pkg_mgr
  pkg_mgr=$(get_pkg_manager)

  # Go
  if ! command -v go &>/dev/null; then
    warn "Go não encontrado. Instalando..."
    install_go "$pkg_mgr"
  else
    local go_version
    go_version=$(go version | grep -oP '\d+\.\d+' | head -1)
    log "Go $go_version encontrado"
  fi

  # Wine
  if ! command -v wine &>/dev/null && ! command -v wine64 &>/dev/null; then
    warn "Wine não encontrado. Instalando..."
    install_wine "$pkg_mgr"
  else
    log "Wine $(wine --version 2>/dev/null || echo 'encontrado')"
  fi

  # curl (para downloads)
  if ! command -v curl &>/dev/null; then
    install_pkg "$pkg_mgr" "curl"
  fi
}

install_go() {
  local pkg_mgr=$1
  case "$pkg_mgr" in
    apt)
      sudo apt-get update -q
      sudo apt-get install -y golang-go ;;
    dnf)
      sudo dnf install -y golang ;;
    pacman)
      sudo pacman -S --noconfirm go ;;
    zypper)
      sudo zypper install -y go ;;
    *)
      # Instalar Go manualmente
      local GO_VER="1.22.0"
      local ARCH
      ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
      local GO_TAR="go${GO_VER}.linux-${ARCH}.tar.gz"
      info "Baixando Go $GO_VER..."
      curl -fsSL "https://go.dev/dl/${GO_TAR}" -o "/tmp/${GO_TAR}"
      sudo tar -C /usr/local -xzf "/tmp/${GO_TAR}"
      export PATH=$PATH:/usr/local/go/bin
      echo 'export PATH=$PATH:/usr/local/go/bin' >> "$HOME/.profile"
      rm "/tmp/${GO_TAR}"
      ;;
  esac
  log "Go instalado"
}

install_wine() {
  local pkg_mgr=$1
  info "Instalando Wine (pode demorar alguns minutos)..."
  case "$pkg_mgr" in
    apt)
      sudo dpkg --add-architecture i386
      sudo apt-get update -q
      sudo apt-get install -y wine wine32 wine64 ;;
    dnf)
      sudo dnf install -y wine ;;
    pacman)
      sudo pacman -S --noconfirm wine wine-mono ;;
    zypper)
      sudo zypper install -y wine ;;
    *)
      error "Instale o Wine manualmente: https://www.winehq.org/"
      exit 1 ;;
  esac
  log "Wine instalado"
}

install_pkg() {
  local pkg_mgr=$1
  local pkg=$2
  case "$pkg_mgr" in
    apt)    sudo apt-get install -y "$pkg" ;;
    dnf)    sudo dnf install -y "$pkg" ;;
    pacman) sudo pacman -S --noconfirm "$pkg" ;;
    zypper) sudo zypper install -y "$pkg" ;;
  esac
}

# ─── Compilar o proxy Go ─────────────────────────────────────

build_proxy() {
  header "Compilando IDM Bridge (Go)"

  local proxy_src="$REPO_DIR/../proxy"

  if [ ! -d "$proxy_src" ]; then
    error "Diretório proxy não encontrado em: $proxy_src"
    exit 1
  fi

  cd "$proxy_src"

  info "Baixando dependências Go..."
  go mod tidy

  info "Compilando binário..."
  CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w -X main.version=$BRIDGE_VERSION" \
    -o /tmp/idm-bridge \
    ./cmd/bridge/

  mkdir -p "$INSTALL_DIR"
  mv /tmp/idm-bridge "$INSTALL_DIR/idm-bridge"
  chmod +x "$INSTALL_DIR/idm-bridge"

  log "Binário instalado em: $INSTALL_DIR/idm-bridge"
  cd "$REPO_DIR"
}

# ─── Configuração ────────────────────────────────────────────

configure() {
  header "Configuração"

  mkdir -p "$CONFIG_DIR" "$CONFIG_DIR/sessions"

  # Perguntar sobre o Wine prefix
  ask "Caminho do prefixo Wine [$WINE_PREFIX]:"
  read -r user_prefix
  WINE_PREFIX="${user_prefix:-$WINE_PREFIX}"

  # Perguntar sobre o caminho do IDM
  local idm_path="$WINE_PREFIX/drive_c/Program Files (x86)/Internet Download Manager/IDMan.exe"
  ask "Caminho do IDMan.exe [$idm_path]:"
  read -r user_idm
  idm_path="${user_idm:-$idm_path}"

  if [ ! -f "$idm_path" ]; then
    warn "IDMan.exe não encontrado em: $idm_path"
    warn "Configure o caminho correto em: $CONFIG_DIR/config.env"
  else
    log "IDMan.exe encontrado!"
  fi

  # Perguntar sobre a porta
  ask "Porta do bridge [$BRIDGE_PORT]:"
  read -r user_port
  BRIDGE_PORT="${user_port:-$BRIDGE_PORT}"

  # Criar arquivo de configuração
  cat > "$CONFIG_DIR/config.env" << EOF
# IDM Linux Bridge — Configuração
# Editado em: $(date)

BRIDGE_PORT=$BRIDGE_PORT
BRIDGE_HOST=127.0.0.1
WINE_PREFIX=$WINE_PREFIX
IDM_PATH=$idm_path
VERBOSE=false
EOF

  log "Configuração salva em: $CONFIG_DIR/config.env"
}

# ─── Serviço systemd ─────────────────────────────────────────

install_service() {
  header "Configurando serviço systemd"

  mkdir -p "$SERVICE_DIR"

  cat > "$SERVICE_DIR/idm-bridge.service" << EOF
[Unit]
Description=IDM Linux Bridge — Proxy entre extensão e IDM via Wine
Documentation=https://github.com/seu-usuario/idm-linux-bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_DIR/config.env
ExecStart=$INSTALL_DIR/idm-bridge \\
  --host \${BRIDGE_HOST} \\
  --port \${BRIDGE_PORT} \\
  --wine-prefix \${WINE_PREFIX} \\
  --idm-path \${IDM_PATH}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=idm-bridge

# Segurança
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

  # Recarregar systemd e habilitar serviço
  systemctl --user daemon-reload
  systemctl --user enable --now idm-bridge.service

  log "Serviço idm-bridge habilitado e iniciado"
  info "Para ver logs: journalctl --user -u idm-bridge -f"
}

# ─── PATH do usuário ─────────────────────────────────────────

setup_path() {
  local shell_rc=""
  case "${SHELL:-}" in
    */bash) shell_rc="$HOME/.bashrc" ;;
    */zsh)  shell_rc="$HOME/.zshrc"  ;;
    */fish) shell_rc="$HOME/.config/fish/config.fish" ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac

  if ! grep -q "$INSTALL_DIR" "$shell_rc" 2>/dev/null; then
    echo "export PATH=\"\$PATH:$INSTALL_DIR\"" >> "$shell_rc"
    info "PATH atualizado em: $shell_rc"
    info "Rode: source $shell_rc  (ou abra um novo terminal)"
  fi
}

# ─── Instalar extensão ───────────────────────────────────────

install_extension() {
  header "Extensão do Navegador"

  local ext_dir="$REPO_DIR/extension"

  echo ""
  echo -e "${BOLD}Para instalar a extensão no Chrome/Chromium:${NC}"
  echo "  1. Abra: chrome://extensions"
  echo "  2. Ative o 'Modo do desenvolvedor' (canto superior direito)"
  echo "  3. Clique em 'Carregar sem compactação'"
  echo "  4. Selecione a pasta: ${CYAN}$ext_dir${NC}"
  echo ""
  echo -e "${BOLD}Para instalar no Firefox:${NC}"
  echo "  1. Abra: about:debugging#/runtime/this-firefox"
  echo "  2. Clique em 'Carregar extensão temporária'"
  echo "  3. Selecione: ${CYAN}$ext_dir/manifest.json${NC}"
  echo ""

  # Criar ícones SVG básicos se não existirem
  generate_icons "$ext_dir/icons"

  # Abrir o gerenciador de extensões automaticamente (se possível)
  if command -v google-chrome &>/dev/null || command -v chromium-browser &>/dev/null; then
    ask "Abrir chrome://extensions agora? [s/N]:"
    read -r open_chrome
    if [[ "${open_chrome,,}" == "s" ]]; then
      (google-chrome chrome://extensions 2>/dev/null || chromium-browser chrome://extensions 2>/dev/null) &
    fi
  fi
}

generate_icons() {
  local icons_dir=$1
  mkdir -p "$icons_dir"

  # Gerar ícones SVG simples e converter se possível
  for size in 16 48 128; do
    local svg_file="$icons_dir/icon${size}.svg"
    cat > "$svg_file" << SVGEOF
<svg xmlns="http://www.w3.org/2000/svg" width="$size" height="$size" viewBox="0 0 $size $size">
  <rect width="$size" height="$size" rx="$(($size/5))" fill="#e74c3c"/>
  <text x="50%" y="58%" font-family="sans-serif" font-size="$(($size*7/10))"
        fill="white" text-anchor="middle" dominant-baseline="middle" font-weight="bold">⬇</text>
</svg>
SVGEOF

    # Converter para PNG se inkscape ou rsvg-convert disponível
    if command -v rsvg-convert &>/dev/null; then
      rsvg-convert -w "$size" -h "$size" "$svg_file" > "$icons_dir/icon${size}.png" 2>/dev/null
    elif command -v inkscape &>/dev/null; then
      inkscape --export-png="$icons_dir/icon${size}.png" -w "$size" -h "$size" "$svg_file" 2>/dev/null
    else
      # Copiar SVG com nome PNG (workaround — Chrome aceita)
      cp "$svg_file" "$icons_dir/icon${size}.png"
    fi
  done

  log "Ícones gerados em: $icons_dir"
}

# ─── Verificação final ───────────────────────────────────────

verify_installation() {
  header "Verificando instalação"

  local ok=true

  # Verificar binário
  if [ -x "$INSTALL_DIR/idm-bridge" ]; then
    log "Binário: $INSTALL_DIR/idm-bridge"
  else
    error "Binário não encontrado"
    ok=false
  fi

  # Verificar configuração
  if [ -f "$CONFIG_DIR/config.env" ]; then
    log "Configuração: $CONFIG_DIR/config.env"
  else
    error "Arquivo de configuração não encontrado"
    ok=false
  fi

  # Verificar serviço
  if systemctl --user is-active --quiet idm-bridge 2>/dev/null; then
    log "Serviço: idm-bridge rodando ✓"
  else
    warn "Serviço não está rodando. Tente: systemctl --user start idm-bridge"
  fi

  # Verificar bridge via HTTP
  sleep 2
  if curl -sf "http://127.0.0.1:${BRIDGE_PORT}/status" &>/dev/null; then
    log "Bridge HTTP respondendo na porta $BRIDGE_PORT ✓"
  else
    warn "Bridge não respondeu. Verifique: journalctl --user -u idm-bridge --no-pager"
  fi

  echo ""
  if [ "$ok" = true ]; then
    echo -e "${GREEN}${BOLD}✓ IDM Linux Bridge instalado com sucesso!${NC}"
  else
    echo -e "${YELLOW}${BOLD}Instalação concluída com avisos. Verifique os erros acima.${NC}"
  fi
}

# ─── Desinstalar ─────────────────────────────────────────────

uninstall() {
  header "Desinstalando IDM Linux Bridge"

  systemctl --user stop idm-bridge 2>/dev/null || true
  systemctl --user disable idm-bridge 2>/dev/null || true
  rm -f "$SERVICE_DIR/idm-bridge.service"
  systemctl --user daemon-reload
  rm -f "$INSTALL_DIR/idm-bridge"
  rm -rf "$CONFIG_DIR"

  log "IDM Linux Bridge removido"
}

# ─── Menu principal ──────────────────────────────────────────

show_banner() {
  echo -e "${RED}${BOLD}"
  cat << 'BANNER'
 _____ ____  __  __   _     _
|_   _|  _ \|  \/  | | |   (_)_ __  _   ___  __
  | | | | | | |\/| | | |   | | '_ \| | | \ \/ /
  | | | |_| | |  | | | |___| | | | | |_| |>  <
  |_| |____/|_|  |_| |_____|_|_| |_|\__,_/_/\_\
                        Bridge para Linux via Wine
BANNER
  echo -e "${NC}"
}

show_menu() {
  echo -e "${BOLD}O que deseja fazer?${NC}"
  echo "  1) Instalação completa (recomendado)"
  echo "  2) Apenas compilar o proxy"
  echo "  3) Apenas configurar"
  echo "  4) Apenas instalar serviço systemd"
  echo "  5) Desinstalar"
  echo "  6) Sair"
  echo ""
  ask "Opção [1]:"
  read -r choice
  choice="${choice:-1}"
}

# ─── Ponto de entrada ────────────────────────────────────────

main() {
  show_banner

  # Modo não-interativo (CI/scripts)
  if [ "${1:-}" = "--auto" ]; then
    detect_distro
    install_dependencies
    build_proxy
    configure
    install_service
    setup_path
    generate_icons "$REPO_DIR/extension/icons"
    verify_installation
    return
  fi

  show_menu

  case "$choice" in
    1)
      detect_distro
      install_dependencies
      build_proxy
      configure
      install_service
      setup_path
      install_extension
      verify_installation
      ;;
    2) build_proxy ;;
    3) configure ;;
    4) install_service ;;
    5) uninstall ;;
    6) exit 0 ;;
    *) error "Opção inválida"; exit 1 ;;
  esac
}

# Verificar se está rodando como root (não recomendado para instalação user-space)
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  warn "Não execute como root — o bridge usa instalação em espaço do usuário."
  ask "Continuar mesmo assim? [s/N]:"
  read -r ans
  [[ "${ans,,}" != "s" ]] && exit 1
fi

main "$@"
