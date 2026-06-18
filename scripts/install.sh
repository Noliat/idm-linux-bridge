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
# BRIDGE_VERSION não é mais fixado aqui — lido em build_proxy() diretamente
# de proxy/internal/server/server.go (a única fonte de verdade do SemVer
# do proxy). Isso evita o script ficar dessincronizado do código, como
# ocorria antes (script dizia 2.0.0, server.go dizia 2.1.0).
INSTALL_DIR="$HOME/.local/bin"
CONFIG_DIR="$HOME/.config/idm-bridge"
SERVICE_DIR="$HOME/.config/systemd/user"
AUTOSTART_DIR="$HOME/.config/autostart"
BRIDGE_PORT=6969
WINE_PREFIX="$HOME/.wine"
IDM_DEFAULT_PATH="$WINE_PREFIX/drive_c/Program Files (x86)/Internet Download Manager/IDMan.exe"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Modo de inicialização: "boot" (systemd, antes do login) ou "login" (autostart, após login)
STARTUP_MODE=""

# ─── Helpers ─────────────────────────────────────────────────

log()    { echo -e "${GREEN}[✓]${NC} $*"; }
info()   { echo -e "${BLUE}[i]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
error()  { echo -e "${RED}[✗]${NC} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }
ask()    { echo -en "${YELLOW}[?]${NC} $1 "; }

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

  if ! command -v go &>/dev/null; then
    warn "Go não encontrado. Instalando..."
    install_go "$pkg_mgr"
  else
    local go_version
    go_version=$(go version | grep -oP '\d+\.\d+' | head -1)
    log "Go $go_version encontrado"
  fi

  if ! command -v wine &>/dev/null && ! command -v wine64 &>/dev/null; then
    warn "Wine não encontrado. Instalando..."
    install_wine "$pkg_mgr"
  else
    log "Wine $(wine --version 2>/dev/null || echo 'encontrado')"
  fi

  if ! command -v curl &>/dev/null; then
    install_pkg "$pkg_mgr" "curl"
  fi
}

install_go() {
  local pkg_mgr=$1
  case "$pkg_mgr" in
    apt)    sudo apt-get update -q && sudo apt-get install -y golang-go ;;
    dnf)    sudo dnf install -y golang ;;
    pacman) sudo pacman -S --noconfirm go ;;
    zypper) sudo zypper install -y go ;;
    *)
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
    dnf)    sudo dnf install -y wine ;;
    pacman) sudo pacman -S --noconfirm wine wine-mono ;;
    zypper) sudo zypper install -y wine ;;
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

  # Extrair a versão diretamente do código-fonte — única fonte de verdade.
  # const Version = "X.Y.Z" em internal/server/server.go.
  BRIDGE_VERSION=$(grep -oP 'const Version = "\K[^"]+' internal/server/server.go 2>/dev/null || echo "desconhecida")
  info "Versão detectada no código-fonte: $BRIDGE_VERSION"

  info "Baixando dependências Go..."
  go mod tidy
  info "Compilando binário..."
  CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
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

  ask "Caminho do prefixo Wine [$WINE_PREFIX]:"
  read -r user_prefix
  WINE_PREFIX="${user_prefix:-$WINE_PREFIX}"

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

  ask "Porta do bridge [$BRIDGE_PORT]:"
  read -r user_port
  BRIDGE_PORT="${user_port:-$BRIDGE_PORT}"

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

# ─── Escolha do modo de inicialização ────────────────────────
#
# MODO "boot"  — systemd --user com lingering habilitado
#   O serviço sobe junto com o sistema operacional, mesmo antes do
#   usuário fazer login gráfico. Ideal para quem quer que o bridge
#   esteja disponível imediatamente ao abrir o navegador.
#   Requer: loginctl enable-linger (persiste sessão do usuário no boot)
#
# MODO "login" — arquivo .desktop em ~/.config/autostart/
#   O serviço só sobe após o usuário entrar na sessão gráfica.
#   Mais seguro (não precisa de linger) e garante que as variáveis
#   de ambiente gráficas (DISPLAY, WAYLAND_DISPLAY) estejam presentes.
#   Ideal para quem prefere que o bridge inicie somente após o login.

choose_startup_mode() {
  header "Modo de inicialização"

  echo -e "  ${BOLD}Como o IDM Bridge deve iniciar?${NC}"
  echo ""
  echo -e "  ${CYAN}1)${NC} ${BOLD}Com o sistema${NC} (antes do login)"
  echo -e "     Usa systemd --user + loginctl enable-linger"
  echo -e "     O bridge fica disponível assim que o sistema ligar,"
  echo -e "     independentemente de você ter feito login gráfico."
  echo -e "     ${YELLOW}Requer permissão para habilitar linger do usuário.${NC}"
  echo ""
  echo -e "  ${CYAN}2)${NC} ${BOLD}Após o login${NC} (recomendado)"
  echo -e "     Usa XDG Autostart (~/.config/autostart/)"
  echo -e "     O bridge inicia automaticamente quando você entra"
  echo -e "     na sessão gráfica (GNOME, KDE, XFCE, etc.)."
  echo -e "     Garante acesso às variáveis de ambiente gráficas."
  echo ""

  local choice=""
  while [[ "$choice" != "1" && "$choice" != "2" ]]; do
    ask "Opção [2]:"
    read -r choice
    choice="${choice:-2}"
    if [[ "$choice" != "1" && "$choice" != "2" ]]; then
      warn "Digite 1 ou 2"
    fi
  done

  if [ "$choice" = "1" ]; then
    STARTUP_MODE="boot"
    log "Modo selecionado: iniciar COM O SISTEMA"
  else
    STARTUP_MODE="login"
    log "Modo selecionado: iniciar APÓS O LOGIN"
  fi
}

# ─── Instalação modo "boot" (systemd + linger) ───────────────

install_service_boot() {
  header "Configurando serviço systemd (modo: com o sistema)"

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
# Restart=on-failure cobre:
#   exit(1)  → erro fatal → reinicia (pode ser transitório)
#   exit(2)  → discrepância de servidor gráfico → reinicia com env correto
#   SIGTERM/SIGINT (exit 0) → encerramento intencional → NÃO reinicia
Restart=on-failure
RestartSec=3
# Limitar reinícios em rajada (ex: loop de erros fatais reais)
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=idm-bridge

# Segurança
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

  # Parar e desabilitar o modo login se estava ativo
  _disable_autostart_entry 2>/dev/null || true

  # Habilitar linger: mantém a sessão do usuário ativa mesmo sem login gráfico,
  # permitindo que serviços --user rodem desde o boot.
  info "Habilitando linger para o usuário '$(whoami)'..."
  if loginctl enable-linger "$(whoami)" 2>/dev/null; then
    log "Linger habilitado com sucesso"
  else
    warn "Não foi possível habilitar linger automaticamente."
    warn "Execute manualmente: sudo loginctl enable-linger $(whoami)"
    warn "Sem isso o serviço só sobe após o primeiro login."
  fi

  systemctl --user daemon-reload
  systemctl --user enable --now idm-bridge.service

  # Salvar modo escolhido na configuração
  _save_startup_mode "boot"

  log "Serviço idm-bridge habilitado (modo: boot)"
  info "Para ver logs:    journalctl --user -u idm-bridge -f"
  info "Para parar:       systemctl --user stop idm-bridge"
  info "Para desabilitar: systemctl --user disable idm-bridge"
}

# ─── Instalação modo "login" (XDG Autostart) ─────────────────

install_service_login() {
  header "Configurando autostart pós-login (modo: após o login)"

  mkdir -p "$AUTOSTART_DIR"
  mkdir -p "$SERVICE_DIR"

  # Criar também o unit systemd (para controle via systemctl)
  # mas NÃO habilitar no boot — será ativado pelo autostart
  cat > "$SERVICE_DIR/idm-bridge.service" << EOF
[Unit]
Description=IDM Linux Bridge — Proxy entre extensão e IDM via Wine
Documentation=https://github.com/seu-usuario/idm-linux-bridge
After=graphical-session.target network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONFIG_DIR/config.env
ExecStart=$INSTALL_DIR/idm-bridge \\
  --host \${BRIDGE_HOST} \\
  --port \${BRIDGE_PORT} \\
  --wine-prefix \${WINE_PREFIX} \\
  --idm-path \${IDM_PATH}
Restart=on-failure
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=idm-bridge

# Segurança
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=graphical-session.target
EOF

  # Desabilitar modo boot se estava ativo (remover linger + disable)
  if systemctl --user is-enabled idm-bridge 2>/dev/null | grep -q "enabled"; then
    info "Desabilitando serviço boot anterior..."
    systemctl --user disable idm-bridge 2>/dev/null || true
  fi
  # Revogar linger se estava ativo para este usuário
  if loginctl show-user "$(whoami)" 2>/dev/null | grep -q "Linger=yes"; then
    info "Removendo linger (não necessário para modo login)..."
    loginctl disable-linger "$(whoami)" 2>/dev/null || \
      warn "Não foi possível desativar linger. Execute: sudo loginctl disable-linger $(whoami)"
  fi

  systemctl --user daemon-reload

  # Criar entrada .desktop de autostart
  # O .desktop é lido pelo ambiente gráfico (GNOME, KDE, XFCE, etc.)
  # e inicia o bridge assim que a sessão gráfica estiver disponível.
  # Usamos systemctl --user start para aproveitar o unit já definido
  # (controle uniforme via journalctl e systemctl).
  cat > "$AUTOSTART_DIR/idm-bridge.desktop" << EOF
[Desktop Entry]
Type=Application
Name=IDM Linux Bridge
Comment=Proxy entre a extensão do navegador e o IDM via Wine
Exec=systemctl --user start idm-bridge
Icon=network-server
Terminal=false
Hidden=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=3
X-KDE-autostart-after=panel
X-Mate-Autostart-enabled=true
EOF

  chmod +x "$AUTOSTART_DIR/idm-bridge.desktop"

  # Salvar modo escolhido na configuração
  _save_startup_mode "login"

  log "Autostart pós-login configurado"
  info "Arquivo: $AUTOSTART_DIR/idm-bridge.desktop"
  info "O bridge iniciará automaticamente no próximo login gráfico."
  info ""
  info "Para iniciar agora:   systemctl --user start idm-bridge"
  info "Para ver logs:        journalctl --user -u idm-bridge -f"
  info "Para desabilitar:     rm $AUTOSTART_DIR/idm-bridge.desktop"

  # Oferecer iniciar agora (sem precisar fazer logout/login)
  echo ""
  ask "Iniciar o bridge agora? [S/n]:"
  read -r start_now
  if [[ "${start_now,,}" != "n" ]]; then
    systemctl --user start idm-bridge && log "Bridge iniciado!" || \
      warn "Não foi possível iniciar. Tente: systemctl --user start idm-bridge"
  fi
}

# ─── Dispatcher: escolhe e instala o modo correto ────────────

install_service() {
  # Se o modo não foi escolhido ainda (chamada direta), perguntar
  if [ -z "$STARTUP_MODE" ]; then
    choose_startup_mode
  fi

  case "$STARTUP_MODE" in
    boot)  install_service_boot  ;;
    login) install_service_login ;;
    *)
      error "Modo de startup inválido: '$STARTUP_MODE'"
      exit 1 ;;
  esac
}

# ─── Alterar modo de inicialização (sem reinstalar tudo) ─────

change_startup_mode() {
  header "Alterar modo de inicialização"

  local current_mode
  current_mode=$(_load_startup_mode)

  if [ -n "$current_mode" ]; then
    echo -e "  Modo atual: ${CYAN}${BOLD}$current_mode${NC}"
  else
    echo -e "  ${YELLOW}Nenhum modo configurado ainda.${NC}"
  fi
  echo ""

  choose_startup_mode

  # Parar o serviço antes de reconfigurar
  systemctl --user stop idm-bridge 2>/dev/null || true

  install_service
}

# ─── Helpers para persistência do modo ───────────────────────

_save_startup_mode() {
  local mode=$1
  # Salvar no config.env como comentário estruturado (não interfere no bridge)
  if grep -q "^STARTUP_MODE=" "$CONFIG_DIR/config.env" 2>/dev/null; then
    sed -i "s/^STARTUP_MODE=.*/STARTUP_MODE=$mode/" "$CONFIG_DIR/config.env"
  else
    echo "" >> "$CONFIG_DIR/config.env"
    echo "# Modo de inicialização: boot (com o sistema) ou login (após login gráfico)" >> "$CONFIG_DIR/config.env"
    echo "STARTUP_MODE=$mode" >> "$CONFIG_DIR/config.env"
  fi
}

_load_startup_mode() {
  if [ -f "$CONFIG_DIR/config.env" ]; then
    local mode
    mode=$(grep "^STARTUP_MODE=" "$CONFIG_DIR/config.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
    echo "${mode:-}"
  fi
}

_disable_autostart_entry() {
  local desktop="$AUTOSTART_DIR/idm-bridge.desktop"
  if [ -f "$desktop" ]; then
    info "Removendo entrada de autostart anterior..."
    rm -f "$desktop"
  fi
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

  generate_icons "$ext_dir/icons"

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

  for size in 16 48 128; do
    local svg_file="$icons_dir/icon${size}.svg"
    cat > "$svg_file" << SVGEOF
<svg xmlns="http://www.w3.org/2000/svg" width="$size" height="$size" viewBox="0 0 $size $size">
  <rect width="$size" height="$size" rx="$(($size/5))" fill="#e74c3c"/>
  <text x="50%" y="58%" font-family="sans-serif" font-size="$(($size*7/10))"
        fill="white" text-anchor="middle" dominant-baseline="middle" font-weight="bold">⬇</text>
</svg>
SVGEOF

    if command -v rsvg-convert &>/dev/null; then
      rsvg-convert -w "$size" -h "$size" "$svg_file" > "$icons_dir/icon${size}.png" 2>/dev/null
    elif command -v inkscape &>/dev/null; then
      inkscape --export-png="$icons_dir/icon${size}.png" -w "$size" -h "$size" "$svg_file" 2>/dev/null
    else
      cp "$svg_file" "$icons_dir/icon${size}.png"
    fi
  done

  log "Ícones gerados em: $icons_dir"
}

# ─── Verificação final ───────────────────────────────────────

verify_installation() {
  header "Verificando instalação"

  local ok=true

  if [ -x "$INSTALL_DIR/idm-bridge" ]; then
    log "Binário: $INSTALL_DIR/idm-bridge"
  else
    error "Binário não encontrado"
    ok=false
  fi

  if [ -f "$CONFIG_DIR/config.env" ]; then
    log "Configuração: $CONFIG_DIR/config.env"
  else
    error "Arquivo de configuração não encontrado"
    ok=false
  fi

  local current_mode
  current_mode=$(_load_startup_mode)

  case "$current_mode" in
    boot)
      log "Modo de startup: com o sistema (systemd + linger)"
      if systemctl --user is-active --quiet idm-bridge 2>/dev/null; then
        log "Serviço: idm-bridge rodando ✓"
      else
        warn "Serviço não está rodando. Tente: systemctl --user start idm-bridge"
      fi
      ;;
    login)
      log "Modo de startup: após o login (XDG Autostart)"
      if [ -f "$AUTOSTART_DIR/idm-bridge.desktop" ]; then
        log "Autostart: $AUTOSTART_DIR/idm-bridge.desktop ✓"
      else
        warn "Arquivo .desktop não encontrado"
      fi
      if systemctl --user is-active --quiet idm-bridge 2>/dev/null; then
        log "Serviço: idm-bridge rodando ✓"
      else
        info "Serviço não rodando (normal se ainda não fez login gráfico)"
      fi
      ;;
    *)
      warn "Modo de startup não configurado"
      ok=false
      ;;
  esac

  sleep 1
  if curl -sf "http://127.0.0.1:${BRIDGE_PORT}/status" &>/dev/null; then
    log "Bridge HTTP respondendo na porta $BRIDGE_PORT ✓"
  else
    info "Bridge não respondeu na porta $BRIDGE_PORT (pode ainda não ter iniciado)"
  fi

  echo ""
  if [ "$ok" = true ]; then
    echo -e "${GREEN}${BOLD}✓ IDM Linux Bridge instalado com sucesso!${NC}"
    echo ""
    _print_startup_summary "$current_mode"
  else
    echo -e "${YELLOW}${BOLD}Instalação concluída com avisos. Verifique os erros acima.${NC}"
  fi
}

_print_startup_summary() {
  local mode=$1
  case "$mode" in
    boot)
      echo -e "${BOLD}Inicialização:${NC} Com o sistema"
      echo -e "  O bridge inicia automaticamente no boot via systemd."
      echo -e "  ${CYAN}journalctl --user -u idm-bridge -f${NC}  — acompanhar logs"
      echo -e "  ${CYAN}systemctl --user status idm-bridge${NC}   — ver status"
      echo -e "  Para alterar: ${CYAN}$0 --change-startup${NC}"
      ;;
    login)
      echo -e "${BOLD}Inicialização:${NC} Após o login gráfico"
      echo -e "  O bridge inicia automaticamente ao entrar na sessão."
      echo -e "  ${CYAN}journalctl --user -u idm-bridge -f${NC}  — acompanhar logs"
      echo -e "  ${CYAN}systemctl --user status idm-bridge${NC}   — ver status"
      echo -e "  Para alterar: ${CYAN}$0 --change-startup${NC}"
      ;;
  esac
}

# ─── Desinstalar ─────────────────────────────────────────────

uninstall() {
  header "Desinstalando IDM Linux Bridge"

  systemctl --user stop    idm-bridge 2>/dev/null || true
  systemctl --user disable idm-bridge 2>/dev/null || true
  rm -f "$SERVICE_DIR/idm-bridge.service"
  systemctl --user daemon-reload 2>/dev/null || true

  # Remover autostart se existir
  rm -f "$AUTOSTART_DIR/idm-bridge.desktop"
  info "Entrada de autostart removida"

  # Desabilitar linger se estava ativo para este usuário
  if loginctl show-user "$(whoami)" 2>/dev/null | grep -q "Linger=yes"; then
    loginctl disable-linger "$(whoami)" 2>/dev/null && \
      info "Linger desabilitado" || \
      warn "Execute: sudo loginctl disable-linger $(whoami)"
  fi

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
  echo "  4) Apenas instalar serviço"
  echo "  5) Alterar modo de inicialização"
  echo "  6) Desinstalar"
  echo "  7) Sair"
  echo ""
  ask "Opção [1]:"
  read -r choice
  choice="${choice:-1}"
}

# ─── Ponto de entrada ────────────────────────────────────────

main() {
  show_banner

  # Flags de linha de comando
  case "${1:-}" in
    --auto)
      STARTUP_MODE="login"  # padrão seguro no modo não-interativo
      detect_distro
      install_dependencies
      build_proxy
      configure
      install_service
      setup_path
      generate_icons "$REPO_DIR/extension/icons"
      verify_installation
      return ;;
    --auto-boot)
      STARTUP_MODE="boot"
      detect_distro
      install_dependencies
      build_proxy
      configure
      install_service
      setup_path
      generate_icons "$REPO_DIR/extension/icons"
      verify_installation
      return ;;
    --change-startup)
      change_startup_mode
      return ;;
    --startup-boot)
      STARTUP_MODE="boot"
      systemctl --user stop idm-bridge 2>/dev/null || true
      install_service
      verify_installation
      return ;;
    --startup-login)
      STARTUP_MODE="login"
      systemctl --user stop idm-bridge 2>/dev/null || true
      install_service
      verify_installation
      return ;;
  esac

  show_menu

  case "$choice" in
    1)
      detect_distro
      install_dependencies
      build_proxy
      configure
      choose_startup_mode
      install_service
      setup_path
      install_extension
      verify_installation
      ;;
    2) build_proxy ;;
    3) configure ;;
    4)
      choose_startup_mode
      install_service
      ;;
    5) change_startup_mode ;;
    6) uninstall ;;
    7) exit 0 ;;
    *) error "Opção inválida"; exit 1 ;;
  esac
}

# Verificar se está rodando como root
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  warn "Não execute como root — o bridge usa instalação em espaço do usuário."
  ask "Continuar mesmo assim? [s/N]:"
  read -r ans
  [[ "${ans,,}" != "s" ]] && exit 1
fi

main "$@"
