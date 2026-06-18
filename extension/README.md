# IDM Linux Bridge — Extensão (multi-navegador)

Cada subpasta contém uma versão **completa e independente** da extensão,
pronta para ser carregada diretamente no navegador correspondente.

```
extension/
├── chrome/    → Google Chrome (MV3, service_worker)
├── edge/      → Microsoft Edge (MV3, service_worker — mesma engine do Chrome)
├── opera/     → Opera (MV3, service_worker — mesma engine do Chrome)
├── firefox/   → Firefox (MV3, background.scripts — requer Firefox 128+)
└── src/       → Código-fonte compartilhado (referência — editar aqui)
```

## Como instalar

### Chrome / Edge / Opera
1. Abra `chrome://extensions` (Edge: `edge://extensions`, Opera: `opera://extensions`)
2. Ative o **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação**
4. Selecione a pasta `extension/chrome` (ou `edge`, `opera`)

### Firefox
1. Abra `about:debugging#/runtime/this-firefox`
2. Clique em **Carregar extensão temporária**
3. Selecione o arquivo `extension/firefox/manifest.json`

> **Requisito Firefox 128+**: a extensão usa `world: "MAIN"` nos content
> scripts (necessário para interceptar `fetch`/`XHR`/`MediaSource` da
> página) — suporte adicionado ao Firefox na versão 128.

## Diferenças entre os manifests

| Recurso                          | Chrome/Edge/Opera        | Firefox                          |
|-----------------------------------|---------------------------|-----------------------------------|
| `background`                      | `service_worker` (módulo) | `scripts` (event page, módulo)    |
| `chrome_url_overrides.downloads`  | ✅ suportado               | ❌ não suportado (ignorado)        |
| `declarativeNetRequest`           | declarado (não usado)     | removido do manifest              |
| `webRequestBlocking`              | não necessário (MV3)      | necessário para `onBeforeSendHeaders` blocking |
| `browser_specific_settings.gecko` | —                          | ID da extensão + versão mínima    |

## Código compartilhado

Os arquivos em `src/` (background.js, content.js, interceptor.js, etc.) são
**idênticos** entre as quatro versões — copiados para cada subpasta no
momento da criação. O código já lida com diferenças de runtime via:

- `chrome.*` — disponível em todos os navegadores (Firefox expõe `chrome.*`
  como alias de compatibilidade desde a versão 55)
- `IS_FIREFOX` — detectado via `browser.runtime.getBrowserInfo()`, usado
  para a branch `onBeforeSendHeaders` (blocking webRequest no Firefox)

## Atualizando todas as versões

Após editar arquivos em `extension/src/` (a fonte de verdade), rode:

```bash
bash extension/sync-browsers.sh
```

Isso copia `src/` e `icons/` para `chrome/`, `edge/`, `opera/` e `firefox/`,
preservando os `manifest.json` específicos de cada um.
