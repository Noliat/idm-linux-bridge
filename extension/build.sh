#!/usr/bin/env bash
# build.sh — gera page_inject_bundle.js embutindo o interceptor inline
# Executar após modificar interceptor.js ou page_inject.js
set -e
cd "$(dirname "$0")"

INTERCEPTOR="src/interceptor.js"
PARSER="src/parser_m3u8.js"
OUT="src/page_inject_bundle.js"

echo "// AUTO-GERADO por build.sh — NÃO EDITAR DIRETAMENTE" > "$OUT"
echo "// Editar src/page_inject.js e src/interceptor.js, depois rodar build.sh" >> "$OUT"
echo "" >> "$OUT"

# Embutir como string escapada dentro do page_inject_bundle.js
# O bundle injeta o código inline (síncrono) em vez de via src= (assíncrono)
python3 - << 'PYEOF'
import json, sys

with open("src/parser_m3u8.js") as f:
    parser_code = f.read()

with open("src/interceptor.js") as f:
    interceptor_code = f.read()

# Código combinado: parser primeiro (interceptor usa window.__idmM3u8Parser)
combined = parser_code + "\n" + interceptor_code

with open("src/page_inject.js") as f:
    inject_template = f.read()

# Substituir o marcador pelo código embutido
bundle = inject_template.replace(
    "// __INTERCEPTOR_INLINE_PLACEHOLDER__",
    f"const __idmInlineCode = {json.dumps(combined)};"
)

with open("src/page_inject_bundle.js", "w") as f:
    f.write("// AUTO-GERADO por build.sh — NÃO EDITAR DIRETAMENTE\n")
    f.write("// Editar src/page_inject.js + src/interceptor.js e rodar: bash build.sh\n\n")
    f.write(bundle)

print(f"Bundle gerado: src/page_inject_bundle.js ({len(bundle)} bytes)")
PYEOF
