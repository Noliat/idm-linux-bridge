#!/usr/bin/env bash
# ============================================================
# IDM Linux Bridge — Pós-instalação: instalar extensão nos navegadores
# ============================================================
#
# Para cada navegador detectado no sistema, este script PERGUNTA ao
# usuário se ele quer instalar a extensão "via terceiros" (ou seja, fora
# da loja oficial, forçada via política do navegador — requer root e
# edita configuração global da máquina) ou se prefere apenas receber
# as instruções para carregar manualmente em modo desenvolvedor
# (sem root, reversível, mas precisa ser refeito a cada nova versão
# se o usuário desinstalar/limpar o perfil).
#
# A decisão é SEMPRE do usuário — o script nunca assume.
#
# Mecanismo "via terceiros" por navegador:
#   Chrome/Edge: ExtensionInstallForcelist (política JSON) + .crx3
#                assinado gerado por build_crx.py + update_manifest.xml
#                servido via file://.
#   Opera:       NÃO SUPORTADO. A Opera Software confirmou oficialmente
#                que não implementa o mecanismo de políticas do Chromium
#                (ExtensionInstallForcelist etc. não têm efeito). Para
#                Opera, este script SEMPRE recomenda apenas o modo
#                desenvolvedor, independente da escolha do usuário.
#   Firefox:     ExtensionSettings (policies.json) + .xpi. Só funciona
#                de fato se o .xpi for ASSINADO PELA MOZILLA (AMO) ou
#                se o Firefox for ESR/Developer Edition com a flag
#                xpinstall.signatures.required=false. Como esta extensão
#                não está publicada na AMO, o script gera o .xpi mas
#                AVISA que a instalação por política provavelmente vai
#                falhar silenciosamente em Firefox estável — modo
#                desenvolvedor (about:debugging) é o caminho confiável.
#
# Requer root apenas para a opção "via terceiros" (escrita em /etc/...).
# A opção "carregar manualmente" nunca precisa de root.
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()    { echo -e "${GREEN}[✓]${NC} $*"; }
info()   { echo -e "${BLUE}[i]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
error()  { echo -e "${RED}[✗]${NC} $*" >&2; }
header() { echo -e "\n${BOLD}${CYAN}── $* ──${NC}\n"; }
ask()    { echo -en "${YELLOW}[?]${NC} $1 "; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$REPO_DIR/extension"
BUILD_DIR="$REPO_DIR/build"
KEYS_DIR="$REPO_DIR/.keys"
CRX_TOOL="$REPO_DIR/scripts/build_crx.py"

mkdir -p "$BUILD_DIR" "$KEYS_DIR"
chmod 700 "$KEYS_DIR" 2>/dev/null || true

EXT_NAME="IDM Linux Bridge"
EXT_VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/chrome/manifest.json'))['version'])" 2>/dev/null || echo "desconhecida")

# ─── Helpers ─────────────────────────────────────────────────

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local ans
  ask "$prompt"
  read -r ans
  ans="${ans:-$default}"
  [[ "${ans,,}" == "s" || "${ans,,}" == "sim" || "${ans,,}" == "y" ]]
}

require_root_for() {
  local what="$1"
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    warn "Instalar $what via política requer permissões de root."
    ask_yes_no "Executar com sudo agora? [s/N]:" "n" || return 1
    return 0
  fi
  return 0
}

# ─── Geração do .crx assinado (Chrome/Edge/Opera, mesmo formato) ────

build_crx_for() {
  local browser_dir="$1"   # ex: chrome
  local out_crx="$BUILD_DIR/idm-linux-bridge-${browser_dir}.crx"
  local key_path="$KEYS_DIR/${browser_dir}.pem"

  if [ ! -f "$CRX_TOOL" ]; then
    error "Ferramenta não encontrada: $CRX_TOOL"
    return 1
  fi

  info "Gerando .crx assinado para $browser_dir..."
  # build_crx.py gera a chave automaticamente se não existir, e reutiliza
  # a mesma chave em builds seguintes — preserva o extension_id estável
  # entre atualizações (essencial: trocar o ID faz o Chrome tratar como
  # uma extensão totalmente nova, perdendo configurações do usuário).
  local ext_id
  ext_id=$(python3 "$CRX_TOOL" "$EXT_DIR/$browser_dir" "$key_path" "$out_crx")

  if [ -z "$ext_id" ] || [ ! -f "$out_crx" ]; then
    error "Falha ao gerar .crx para $browser_dir"
    return 1
  fi

  log ".crx gerado: $out_crx" >&2
  info "Extension ID: $ext_id" >&2
  echo "$ext_id"
}

# update_manifest.xml — documento exigido pelo Chromium para resolver
# a entrada do ExtensionInstallForcelist quando aponta para um arquivo
# local (file://). Formato "gupdate" padrão, mesmo usado pela Chrome
# Web Store internamente.
write_update_manifest() {
  local ext_id="$1"
  local crx_path="$2"
  local out_xml="$3"
  cat > "$out_xml" << EOF
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='$ext_id'>
    <updatecheck codebase='file://$crx_path' version='$EXT_VERSION' />
  </app>
</gupdate>
EOF
}

# ─── Chrome / Edge / Opera: política ExtensionInstallForcelist ─────
#
# Mesmo mecanismo nos 3 (todos Chromium), só o caminho de política
# muda. Opera é tratado separadamente — ver install_for_browser().

install_via_policy_chromium() {
  local browser_dir="$1"     # chrome | edge | opera
  local policy_dir="$2"      # caminho de /etc/.../policies/managed

  if ! require_root_for "$EXT_NAME ($browser_dir)"; then
    warn "Pulado (sem root). Veja as instruções de instalação manual abaixo."
    return 1
  fi

  local ext_id
  ext_id=$(build_crx_for "$browser_dir") || return 1

  local crx_path="$BUILD_DIR/idm-linux-bridge-${browser_dir}.crx"
  local xml_path="$BUILD_DIR/idm-linux-bridge-${browser_dir}-update.xml"
  write_update_manifest "$ext_id" "$crx_path" "$xml_path"

  local sudo_cmd=""
  [ "${EUID:-$(id -u)}" -ne 0 ] && sudo_cmd="sudo"

  $sudo_cmd mkdir -p "$policy_dir"
  local policy_file="$policy_dir/idm-linux-bridge.json"

  # ExtensionInstallForcelist: lista de "ID;URL_do_update_manifest".
  # Mesclamos com qualquer policy existente do bridge nesse arquivo
  # (sobrescrevendo apenas a nossa entrada), preservando outras chaves
  # se o arquivo já existir e tiver sido editado manualmente.
  $sudo_cmd tee "$policy_file" > /dev/null << EOF
{
  "ExtensionInstallForcelist": [
    "$ext_id;file://$xml_path"
  ],
  "ExtensionInstallSources": [
    "file://$BUILD_DIR/*"
  ]
}
EOF

  log "Política instalada em: $policy_file"
  info "Extension ID: $ext_id"
  warn "Reinicie o $browser_dir completamente (fechar todas as janelas) para a política ser aplicada."
  info "Verifique em: ${browser_dir}://policy (procure por ExtensionInstallForcelist)"
  return 0
}

suggest_manual_chromium() {
  local browser_dir="$1"
  local browser_label="$2"
  local browser_proto="$3"  # ex: chrome, edge, opera (para o protocolo de URL interna)

  echo ""
  echo -e "${BOLD}Instalação manual ($browser_label):${NC}"
  echo "  1. Abra ${browser_proto}://extensions"
  echo "  2. Ative o \"Modo do desenvolvedor\""
  echo "  3. Clique em \"Carregar sem compactação\""
  echo "  4. Selecione a pasta: ${CYAN}$EXT_DIR/$browser_dir${NC}"
}

# ─── Firefox: ExtensionSettings via policies.json ──────────────────

install_via_policy_firefox() {
  if ! require_root_for "$EXT_NAME (Firefox)"; then
    warn "Pulado (sem root). Veja as instruções de instalação manual abaixo."
    return 1
  fi

  warn "AVISO IMPORTANTE sobre Firefox:"
  warn "  O Firefox estável só instala .xpi via política se ele for"
  warn "  ASSINADO PELA MOZILLA (AMO) — esta extensão não está publicada"
  warn "  lá. A instalação abaixo provavelmente será REJEITADA em"
  warn "  silêncio pelo Firefox estável/release."
  warn "  Funciona apenas em Firefox ESR ou Developer Edition com a flag"
  warn "  xpinstall.signatures.required=false em about:config."
  ask_yes_no "Mesmo assim, deseja tentar a instalação via política? [s/N]:" "n" || return 1

  local ext_dir="$EXT_DIR/firefox"
  local manifest_id
  manifest_id=$(python3 -c "import json; print(json.load(open('$ext_dir/manifest.json'))['browser_specific_settings']['gecko']['id'])" 2>/dev/null || echo "")
  if [ -z "$manifest_id" ]; then
    error "Não foi possível ler browser_specific_settings.gecko.id do manifest.json"
    return 1
  fi

  local xpi_path="$BUILD_DIR/idm-linux-bridge-firefox.xpi"
  info "Empacotando .xpi (zip da pasta extension/firefox)..."
  rm -f "$xpi_path"
  (cd "$ext_dir" && zip -rq "$xpi_path" . -x "*.DS_Store")
  log ".xpi gerado: $xpi_path"

  # Localizar o diretório de instalação do Firefox para escrever
  # firefox/distribution/policies.json (escopo só dessa instalação) —
  # alternativa mais simples: /etc/firefox/policies/policies.json
  # (escopo de sistema, funciona para qualquer instalação via pacote
  # que respeite XDG, mas não para builds Snap/Flatpak).
  local sudo_cmd=""
  [ "${EUID:-$(id -u)}" -ne 0 ] && sudo_cmd="sudo"

  local policy_dir="/etc/firefox/policies"
  $sudo_cmd mkdir -p "$policy_dir"
  local policy_file="$policy_dir/policies.json"

  $sudo_cmd tee "$policy_file" > /dev/null << EOF
{
  "policies": {
    "ExtensionSettings": {
      "$manifest_id": {
        "installation_mode": "force_installed",
        "install_url": "file://$xpi_path"
      }
    }
  }
}
EOF

  log "Política instalada em: $policy_file"
  warn "Se o Firefox for instalado via Snap ou Flatpak, este caminho NÃO"
  warn "tem efeito — esses formatos usam sandboxing próprio que ignora"
  warn "/etc/firefox/policies. Nesse caso, use o modo desenvolvedor."
  info "Reinicie o Firefox e verifique em about:policies"
  return 0
}

suggest_manual_firefox() {
  echo ""
  echo -e "${BOLD}Instalação manual (Firefox):${NC}"
  echo "  1. Abra about:debugging#/runtime/this-firefox"
  echo "  2. Clique em \"Carregar extensão temporária\""
  echo "  3. Selecione: ${CYAN}$EXT_DIR/firefox/manifest.json${NC}"
  echo ""
  echo -e "  ${YELLOW}Nota:${NC} extensões carregadas assim são removidas ao fechar"
  echo "  o Firefox — é preciso recarregar a cada sessão. Para algo"
  echo "  persistente sem assinatura da Mozilla, considere o Firefox"
  echo "  Developer Edition ou ESR com unsigned-extensions habilitado."
}

# ─── Detecção de navegadores instalados ─────────────────────────────

detect_browsers() {
  local found=()
  command -v google-chrome    &>/dev/null && found+=("chrome")
  command -v chromium         &>/dev/null && found+=("chrome")
  command -v chromium-browser &>/dev/null && found+=("chrome")
  command -v microsoft-edge   &>/dev/null && found+=("edge")
  command -v microsoft-edge-stable &>/dev/null && found+=("edge")
  command -v opera            &>/dev/null && found+=("opera")
  command -v opera-stable     &>/dev/null && found+=("opera")
  command -v firefox          &>/dev/null && found+=("firefox")
  command -v firefox-esr      &>/dev/null && found+=("firefox")
  # Remover duplicatas preservando ordem
  printf "%s\n" "${found[@]}" | awk '!seen[$0]++'
}

# ─── Fluxo por navegador ─────────────────────────────────────────────

install_for_browser() {
  local browser="$1"

  case "$browser" in
    chrome)
      header "Google Chrome / Chromium"
      ask_yes_no "Instalar via política (\"terceiros\", requer root)? [s/N]:" "n" \
        && install_via_policy_chromium "chrome" "/etc/opt/chrome/policies/managed" \
        || suggest_manual_chromium "chrome" "Google Chrome / Chromium" "chrome"
      ;;
    edge)
      header "Microsoft Edge"
      ask_yes_no "Instalar via política (\"terceiros\", requer root)? [s/N]:" "n" \
        && install_via_policy_chromium "edge" "/etc/opt/edge/policies/managed" \
        || suggest_manual_chromium "edge" "Microsoft Edge" "edge"
      ;;
    opera)
      header "Opera"
      warn "A Opera Software confirmou oficialmente que o navegador NÃO"
      warn "implementa o mecanismo de políticas do Chromium"
      warn "(ExtensionInstallForcelist e afins não têm efeito no Opera,"
      warn "mesmo sendo Chromium-based). Não há alternativa via terceiros"
      warn "confiável para o Opera — apenas o modo desenvolvedor funciona."
      suggest_manual_chromium "opera" "Opera" "opera"
      ;;
    firefox)
      header "Firefox"
      ask_yes_no "Instalar via política (\"terceiros\", requer root)? [s/N]:" "n" \
        && install_via_policy_firefox \
        || suggest_manual_firefox
      ;;
  esac
}

# ─── Ponto de entrada ────────────────────────────────────────────────

main() {
  echo -e "${BOLD}${CYAN}IDM Linux Bridge — Pós-instalação: extensões dos navegadores${NC}"
  echo -e "Versão da extensão: ${EXT_VERSION}"

  local browsers
  mapfile -t browsers < <(detect_browsers)

  if [ ${#browsers[@]} -eq 0 ]; then
    warn "Nenhum navegador suportado foi detectado automaticamente."
    ask "Quais navegadores deseja configurar manualmente? [chrome/edge/opera/firefox, separados por espaço]:"
    read -r manual_list
    browsers=($manual_list)
  else
    info "Navegadores detectados: ${browsers[*]}"
  fi

  for b in "${browsers[@]}"; do
    install_for_browser "$b"
  done

  header "Concluído"
  info "Arquivos gerados (.crx/.xpi e update manifests) ficam em: $BUILD_DIR"
  info "Chave(s) de assinatura privada(s) ficam em: $KEYS_DIR (NÃO versionar — adicionar ao .gitignore)"
}

main "$@"
