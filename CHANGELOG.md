# Changelog

Todas as mudanças notáveis do projeto **idm-linux-bridge** são documentadas
neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/),
e o versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

Este projeto tem **dois componentes versionados de forma independente**, mas
documentados juntos neste arquivo:

- **Proxy** (`proxy/`) — versão declarada em `proxy/internal/server/server.go`,
  constante `Version`. Consultar via `idm-bridge --version` ou endpoint
  HTTP `/status`.
- **Extensão Chrome** (`extension/chrome/`) — versão declarada em
  `extension/chrome/manifest.json`, campo `"version"`.

> **Nota sobre o histórico anterior a este changelog:** antes desta entrada,
> o proxy tinha números de versão dessincronizados entre arquivos
> (`main.go` declarava `2.0.0`, `server.go` declarava `2.1.0` no endpoint
> `/status`, e `scripts/install.sh` usava `2.0.0` num `-ldflags` que na
> prática nunca tomava efeito, pois tentava sobrescrever uma `const` via
> `-X`, o que só funciona em `var`). A extensão Chrome estava em `2.5.0`.
> Não há registro confiável de quais mudanças correspondem a cada um
> desses números — por isso este changelog **não reconstrói esse
> histórico retroativamente**. A entrada `3.0.0` abaixo é o ponto de
> partida real do rastreamento.

## Como versionar a partir de agora

Ao alterar qualquer arquivo do proxy ou da extensão Chrome, junto da
correção:

1. Adicionar uma entrada em **`[Não publicado]`** neste arquivo, na
   categoria correta (`Adicionado`, `Corrigido`, `Alterado`, `Removido`).
2. Decidir o tipo de incremento SemVer (`MAJOR.MINOR.PATCH`):
   - **PATCH** (x.y.**Z**): correção de bug, sem mudança de comportamento
     visível para o usuário além do bug resolvido.
   - **MINOR** (x.**Y**.0): novo recurso, mantendo compatibilidade com o
     que já existia (ex: nova regra de posicionamento, novo site
     suportado, nova opção no instalador).
   - **MAJOR** (**X**.0.0): mudança que quebra compatibilidade ou altera
     significativamente o comportamento esperado (ex: reescrita de
     arquitetura, remoção de um modo de operação).
3. Atualizar o número da versão:
   - Proxy: `proxy/internal/server/server.go`, constante `Version`.
   - Extensão Chrome: `extension/chrome/manifest.json`, campo `version`.
4. Mover a entrada de `[Não publicado]` para uma nova seção `## [X.Y.Z] —
   AAAA-MM-DD` quando a versão for considerada "fechada".

Os dois componentes podem evoluir em ritmos diferentes (ex: um fix só na
extensão não precisa subir a versão do proxy). Quando uma mudança afeta
ambos (ex: novo campo no protocolo entre extensão e proxy), os dois
números devem subir juntos na mesma entrada do changelog.

---

## [Não publicado]

## [3.0.3] — 2026-06-17

### Corrigido
- Botão de preview continuava desaparecendo ao tentar focá-lo/clicar
  nele, mesmo depois da correção do hit-test em `3.0.2`. Diagnóstico
  correto desta vez: o problema não estava no nosso código de
  classificação, e sim no fato de que mover o cursor do `<video>`/card
  para o nosso botão (`#idm-float-pv`, um elemento DOM nosso, fora da
  árvore do card) gera um `mouseleave` **genuíno do navegador** no
  elemento real do site. Sites como TikTok e YouTube escutam esse
  evento para pausar ou até remover do DOM o player de prévia quando o
  hover termina — então a prévia "morria" por reação do PRÓPRIO SITE,
  não por um bug isolado em `classifyPlayers()`.
  - Adicionada `dispatchSyntheticHover(el)`: enquanto o ponteiro estiver
    sobre o botão de preview, disparamos `mouseover`/`mousemove`
    sintéticos no elemento real do card (com `bubbles: true`, então
    também alcança ancestrais que usem delegação de evento para
    detectar hover). Isso "convence" o listener do próprio site de que
    o cursor continua sobre o card, evitando que ele pause/remova a
    prévia.
  - O resgate roda em dois pontos: (1) imediatamente no listener global
    de `mousemove`, a cada movimento real do mouse — elimina o atraso
    de até 400ms que existiria se dependesse só do ciclo do
    `previewTick`, suficiente para o site já ter reagido ao
    `mouseleave` antes do resgate chegar; (2) como reforço, também
    dentro de `classifyPlayers()`, no mesmo ponto em que `lastPreviewEl`
    já era recuperado via `pointerOverPvButton`.
  - Throttle de 300ms por elemento, evitando disparo excessivo de
    eventos sintéticos a cada pixel de movimento do mouse.
  - Validado por simulação isolada: sem o resgate, um `mouseleave`
    simulado marca a prévia como pausada; com `dispatchSyntheticHover`
    chamado em seguida, o estado é revertido corretamente via
    `mouseover`/`mousemove`.

### Componentes nesta versão
- **Extensão Chrome:** `3.0.3` (antes: `3.0.2`)
- **Proxy:** sem alterações nesta versão (permanece `3.0.0`)

## [3.0.2] — 2026-06-17

### Corrigido
- Regressão reintroduzida pela correção da recursão em `3.0.1`: o botão
  de preview voltava a desaparecer permanentemente ao tentar focá-lo com
  o mouse (mesmo bug original de versões anteriores ao dual-button hit-
  test). Causa: `pointerOverPvButton`, em `classifyPlayers()`, excluía o
  próprio botão do hit-test sempre que ele já estivesse com a classe
  `idm-hidden` (`!pv.classList.contains("idm-hidden")` na condição).
  Isso criava um ciclo sem saída: assim que o botão ficava oculto por
  qualquer motivo (ex: 1 ciclo de `previewTick` em que nenhum `<video>`
  estava sob o cursor durante a transição entre o vídeo e o botão), a
  condição passava a ser sempre falsa para ele mesmo — `pointerOverPvButton`
  nunca mais podia ficar `true`, mesmo com o mouse fisicamente sobre o
  botão, e ele nunca reaparecia. O hit-test usa apenas
  `getBoundingClientRect()`, que continua retornando dimensões válidas
  independente de `opacity:0`/`pointer-events:none` (aplicados via CSS
  em `.idm-hidden`) — não havia necessidade real de checar o estado de
  visibilidade antes do hit-test. Removida essa exclusão; o hit-test
  agora só verifica `idm-closed` (fechamento explícito pelo usuário, que
  de fato deve permanecer definitivo) e a posição do ponteiro.
  Comportamento confirmado por simulação isolada: a condição antiga
  nunca recuperava o preview após o primeiro ciclo oculto; a corrigida
  recupera `lastPreviewEl` corretamente e reexibe o botão.

### Componentes nesta versão
- **Extensão Chrome:** `3.0.2` (antes: `3.0.1`)
- **Proxy:** sem alterações nesta versão (permanece `3.0.0`)

## [3.0.1] — 2026-06-17

### Corrigido
- **Crítico**: `RangeError: Maximum call stack size exceeded` em
  `classifyPlayers()`, reproduzível de forma determinística ao posicionar
  o mouse sobre um player de prévia enquanto o player principal está
  ativo/reproduzindo (ex: TikTok com a URL de um vídeo específico aberta,
  `tiktok.com/@usuario/video/<id>`, e qualquer prévia visível na mesma
  página). Causa raiz: recursão infinita síncrona entre
  `dualButtonCoordinator.ensureInstance()` e a própria instância de
  preview que ela cria:
  1. `tick()` da instância principal detecta preview + principal ativo →
     chama `ensureInstance()`.
  2. `_pvWrap` ainda é `null` → `ensureInstance()` chama
     `createButtonInstance("idm-float-pv", true)`.
  3. `createButtonInstance` chama `startPlayerWatcher`, que (por ser
     `isPreviewInstance=true`) executa `previewTick()` **uma vez de
     forma síncrona antes de retornar** — ou seja, antes de
     `this._pvWrap = ...` ser atribuído em `ensureInstance()`.
  4. Essa primeira `previewTick()` síncrona chamava `ensureInstance()`
     de novo. `_pvWrap` continuava `null` (ainda dentro da chamada do
     passo 2) → repetia o passo 2 → repetia o passo 3 → repetia o
     passo 4 → recursão infinita até estourar a pilha.

  Corrigido removendo a chamada redundante a `ensureInstance()` de
  dentro do próprio `previewTickBody` (a instância de preview nunca
  precisa garantir sua própria existência — isso é responsabilidade
  exclusiva do `tick()` da instância principal). Reforçado também com
  uma guarda de reentrância (`_creatingPvWrap`) em `ensureInstance()`,
  como defesa em profundidade contra qualquer caminho de código futuro
  que volte a chamá-la durante a janela em que `_pvWrap` ainda não foi
  atribuído. Diagnóstico confirmado por simulação isolada da lógica
  (Node.js): a versão anterior recursava indefinidamente; a corrigida
  resolve em uma única chamada.
- O comportamento relatado de "o preview parece continuar com hover
  ativo mesmo depois do mouse sair, sem trocar de player" era,
  provavelmente, um sintoma do mesmo travamento — a aba ficava
  ocupada/congelada empilhando chamadas síncronas, dando a impressão
  de estado travado, enquanto o `<video>` nativo do site (que não
  depende do JS da extensão para continuar reproduzindo) seguia seu
  curso normal em segundo plano. Não identificado nenhum código na
  extensão que interfira diretamente em eventos de hover do site ou
  do `<video>` nativo — a lógica de ocultação do botão de preview
  (`previewTickBody`) já era e continua sendo decisiva (`idm-hidden`
  aplicado imediatamente quando `preview` é `null`).

### Componentes nesta versão
- **Extensão Chrome:** `3.0.1` (antes: `3.0.0`)
- **Proxy:** sem alterações nesta versão (permanece `3.0.0`)

## [3.0.0] — 2026-06-16

Versão de consolidação — primeiro ponto de sincronização do SemVer entre
proxy e extensão Chrome. Reflete o estado acumulado de múltiplas sessões
de desenvolvimento anteriores a este changelog (arquitetura de detecção
de servidor gráfico X11/Wayland com cache persistente, suporte a players
externos genéricos, captura YouTube com merge DASH e fallback yt-dlp,
arquitetura de botão flutuante com instância dupla para preview/principal,
reorganização do proxy em múltiplos arquivos por responsabilidade, portas
para Edge/Firefox/Opera, script de pós-instalação multi-navegador).

### Adicionado
- `scripts/post_install_browsers.sh`: script de pós-instalação para
  instalar a extensão nos navegadores detectados no sistema. Para cada
  navegador, pergunta ao usuário se deseja instalar "via terceiros"
  (forçado por política do navegador, requer root) ou apenas receber
  instruções de carregamento manual em modo desenvolvedor — a decisão é
  sempre do usuário, nunca assumida pelo script.
  - **Chrome/Edge**: gera um `.crx3` assinado (reaproveitando
    `scripts/build_crx.py`, que já existia no repositório mas não estava
    integrado a nada) e instala via `ExtensionInstallForcelist` nos
    caminhos de política corretos de cada navegador
    (`/etc/opt/chrome/policies/managed/`, `/etc/opt/edge/policies/managed/`).
  - **Opera**: sempre direcionado para instalação manual — a Opera
    Software confirma oficialmente que o navegador não implementa o
    mecanismo de políticas do Chromium, então `ExtensionInstallForcelist`
    não tem efeito nele.
  - **Firefox**: gera um `.xpi` e tenta instalar via `policies.json`
    (`ExtensionSettings`), com aviso explícito de que isso só funciona de
    fato em Firefox ESR/Developer Edition ou com a extensão assinada pela
    Mozilla (AMO) — em Firefox estável a instalação tende a ser rejeitada
    silenciosamente, e o script avisa disso antes de prosseguir.
  - Chave de assinatura por navegador persistida em `.keys/`, reaproveitada
    entre execuções para manter o `extension_id` estável entre
    atualizações (essencial — trocar o ID faz o navegador tratar como uma
    extensão nova, perdendo configurações do usuário).
- `.gitignore` criado na raiz do projeto (não existia), cobrindo
  `/build/` e `/.keys/` (artefatos gerados pelo novo script,
  o segundo contendo chaves privadas que nunca devem ser versionadas),
  além do binário compilado do proxy (`/bin/`).

### Corrigido
- Pasta órfã `scripts/extension/icons/` removida — ícones antigos,
  não referenciados por nenhum arquivo do projeto, resíduo de antes da
  estrutura atual `extension/{chrome,edge,firefox,opera}/icons/` existir.
- `scripts/post_install_browsers.sh`: corrigido bug em que a função
  geradora do `.crx` (`build_crx_for`) imprimia mensagens de log para
  stdout *antes* do `echo "$ext_id"` final — como a função é chamada via
  `ext_id=$(build_crx_for ...)` (substituição de comando, que captura
  todo o stdout), o texto das mensagens de log contaminava o valor
  capturado em `ext_id`, quebrando o JSON de política gerado em seguida.
  Mensagens de log redirecionadas para stderr (`>&2`), preservando apenas
  o ID puro no stdout capturado.
- `Makefile` tinha `VERSION := 1.0.0` hardcoded (terceiro número
  dessincronizado, além dos já corrigidos em `main.go`/`server.go`/
  `install.sh`) e o mesmo `-ldflags -X main.version=...` que nunca
  funcionava de fato. Removida a variável; `make build` agora só lê a
  versão (via novo target `make version`) para exibição no log de
  build, sem tentar injetá-la — o binário sempre reporta `server.Version`
  diretamente do código-fonte.
- Versões de `extension/edge`, `extension/firefox` e `extension/opera`
  atualizadas para `3.0.0`, sincronizando com `extension/chrome`. O
  conteúdo de `src/` já estava idêntico ao do Chrome em todas as 4 pastas
  (replicado em sessões anteriores à decisão de priorizar correções no
  Chrome); apenas o número de versão em cada `manifest.json` estava
  defasado em `2.5.0`.
- Versão do proxy dessincronizada entre `main.go`, `server.go` (endpoint
  `/status`) e `scripts/install.sh`. Consolidada em uma única constante
  `server.Version`, referenciada por `main.go` e pelo instalador (lida
  diretamente do código-fonte em tempo de build, não mais hardcoded no
  script).
- Removida pasta órfã `{proxy/{cmd/...}` na raiz do repositório (resíduo
  de um comando de shell anterior com chaves não expandidas).

### Alterado
- `README.md` reescrito por completo para refletir a arquitetura e os
  recursos atuais (v3.0.0): captura de mídia em players (YouTube, TikTok,
  players genéricos), merge de streams via ffmpeg/yt-dlp, arquitetura de
  dual-button do botão flutuante, detecção de servidor gráfico X11/
  Wayland, deduplicação de downloads, suporte multi-navegador. A versão
  anterior descrevia apenas a captura de downloads genéricos — bem
  defasada do estado real do projeto.

### Componentes nesta versão
- **Proxy:** `3.0.0` (antes: números divergentes entre arquivos)
- **Extensão Chrome:** `3.0.0` (antes: `2.5.0`)

Versão de consolidação — primeiro ponto de sincronização do SemVer entre
proxy e extensão Chrome. Reflete o estado acumulado de múltiplas sessões
de desenvolvimento anteriores a este changelog (arquitetura de detecção
de servidor gráfico X11/Wayland com cache persistente, suporte a players
externos genéricos, captura YouTube com merge DASH e fallback yt-dlp,
arquitetura de botão flutuante com instância dupla para preview/principal,
reorganização do proxy em múltiplos arquivos por responsabilidade, portas
para Edge/Firefox/Opera).

### Componentes nesta versão
- **Proxy:** `3.0.0` (antes: números divergentes — ver nota acima)
- **Extensão Chrome:** `3.0.0` (antes: `2.5.0`)
