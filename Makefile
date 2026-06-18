.PHONY: build install run stop logs clean test fmt help version

BINARY_NAME := idm-bridge
INSTALL_DIR := $(HOME)/.local/bin
CONFIG_DIR  := $(HOME)/.config/idm-bridge

# ─── Build ──────────────────────────────────────────────────
# A versão NÃO é fixada aqui — vem de proxy/internal/server/server.go
# (const Version), a única fonte de verdade do SemVer do proxy. Antes,
# este Makefile tinha VERSION := 1.0.0 e tentava injetá-la via
# -X main.version=..., o que nunca funcionou de fato (-X só sobrescreve
# var, não const) — o binário sempre reportava a versão hardcoded em
# main.go, dessincronizada deste arquivo.

version:
	@grep -oP 'const Version = "\K[^"]+' proxy/internal/server/server.go

build:
	@echo "→ Compilando $(BINARY_NAME) v$$(make -s version)..."
	@cd proxy && CGO_ENABLED=0 GOOS=linux go build \
		-ldflags="-s -w" \
		-o ../bin/$(BINARY_NAME) \
		./cmd/bridge/
	@echo "✓ Binário: bin/$(BINARY_NAME)"

build-debug:
	@cd proxy && go build -race -o ../bin/$(BINARY_NAME)-debug ./cmd/bridge/

# ─── Instalação ─────────────────────────────────────────────

install: build
	@mkdir -p $(INSTALL_DIR)
	@cp bin/$(BINARY_NAME) $(INSTALL_DIR)/
	@chmod +x $(INSTALL_DIR)/$(BINARY_NAME)
	@echo "✓ Instalado em: $(INSTALL_DIR)/$(BINARY_NAME)"

# ─── Execução local ─────────────────────────────────────────

run:
	@cd proxy && go run ./cmd/bridge/ --verbose

run-with-config:
	@$(INSTALL_DIR)/$(BINARY_NAME) \
		--port 6969 \
		--verbose

# ─── Serviço ────────────────────────────────────────────────

service-start:
	systemctl --user start idm-bridge

service-stop:
	systemctl --user stop idm-bridge

service-restart:
	systemctl --user restart idm-bridge

service-status:
	systemctl --user status idm-bridge

logs:
	journalctl --user -u idm-bridge -f

# ─── Testes ─────────────────────────────────────────────────

test:
	@cd proxy && go test ./... -v

test-api:
	@echo "→ Testando /status..."
	@curl -sf http://127.0.0.1:6969/status | python3 -m json.tool
	@echo ""
	@echo "→ Testando /capture (URL de exemplo)..."
	@curl -sf -X POST http://127.0.0.1:6969/capture \
		-H "Content-Type: application/json" \
		-d '{"url":"https://example.com/test.zip","cookies":"session=abc","referrer":"https://example.com"}' \
		| python3 -m json.tool

# ─── Qualidade ──────────────────────────────────────────────

fmt:
	@cd proxy && go fmt ./...
	@echo "✓ Código formatado"

lint:
	@cd proxy && go vet ./...

# ─── Limpeza ────────────────────────────────────────────────

clean:
	@rm -rf bin/
	@cd proxy && go clean
	@echo "✓ Limpo"

uninstall:
	@systemctl --user stop idm-bridge 2>/dev/null || true
	@systemctl --user disable idm-bridge 2>/dev/null || true
	@rm -f $(INSTALL_DIR)/$(BINARY_NAME)
	@rm -rf $(CONFIG_DIR)
	@echo "✓ Desinstalado"

# ─── Help ───────────────────────────────────────────────────

help:
	@echo ""
	@echo "IDM Linux Bridge — Comandos disponíveis:"
	@echo ""
	@echo "  make version        Exibir versão atual do proxy"
	@echo "  make build          Compilar binário"
	@echo "  make install        Compilar e instalar em ~/.local/bin"
	@echo "  make run            Rodar localmente (desenvolvimento)"
	@echo "  make test           Rodar testes unitários"
	@echo "  make test-api       Testar endpoints HTTP do bridge"
	@echo "  make logs           Ver logs do serviço systemd"
	@echo "  make service-start  Iniciar serviço"
	@echo "  make service-stop   Parar serviço"
	@echo "  make clean          Remover binários compilados"
	@echo "  make uninstall      Remover tudo"
	@echo ""

.DEFAULT_GOAL := help
