# DOM Node Selector — Extensão Chrome (Manifest V3)

Extensão para Google Chrome (Manifest V3) que replica seletor de elementos do DevTools (estilo `Ctrl+Shift+C`), com captura de imagem do elemento.

## O que faz

- Ativa/desativa modo de seleção visual via atalho.
- Destaca elemento sob cursor com overlay fixo (sem quebrar layout).
- Hit-test mais estável: amostra pontos ao redor do cursor para melhorar precisão.
- Ao clicar em elemento:
  - baixa PNG do elemento em tamanho completo (via CDP/debugger);
  - copia **imagem** para clipboard por padrão.
- Com modificador no clique (`Ctrl` ou `Shift`): copia **`outerHTML`** em vez da imagem.
- Desativa modo de seleção automaticamente após captura.

> Observação: DevTools tem privilégios especiais. Aqui comportamento vem de Content Script + CSS + APIs de extensão.

---

## Estrutura

- `manifest.json`
  - Manifest V3, permissões (`scripting`, `downloads`, `debugger`, `clipboardWrite`, etc.), comando/atalho.
- `background.js`
  - Service Worker: toggle por aba, injeção de script/CSS, captura via CDP, download do PNG.
- `content.js`
  - Seleção, overlay, clique, decisão de modo de cópia (imagem vs HTML), integração com clipboard.
- `styles.css`
  - Estilo do highlight/overlay/cursor.

---

## Instalação (modo desenvolvedor)

1. Abrir `chrome://extensions`
2. Ativar **Modo do desenvolvedor**
3. Clicar **Carregar sem compactação**
4. Selecionar pasta do projeto (`manifest.json`)
5. Abrir site qualquer e usar atalho

---

## Atalho

- **Windows/Linux:** `Ctrl + Shift + X`
- **macOS:** `Command + Shift + X`

Configuração em `manifest.json` (`commands.toggle-selector`).

Se conflito: `chrome://extensions/shortcuts`.

---

## Fluxo de captura

1. Usuário ativa modo de seleção.
2. `content.js` calcula melhor alvo por `elementsFromPoint` em múltiplos offsets.
3. Clique interceptado (`preventDefault`, `stopPropagation`, `stopImmediatePropagation`).
4. `content.js` desativa overlay, espera repaint, pede captura ao `background.js`.
5. `background.js` usa `chrome.debugger` + `Page.captureScreenshot`:
   - captura em faixas quando altura grande;
   - costura faixas (`OffscreenCanvas`) para PNG final.
6. PNG salvo via `chrome.downloads.download`.
7. Clipboard:
   - padrão: tenta copiar **imagem** (`navigator.clipboard.write` + `ClipboardItem`);
   - com `Ctrl`/`Shift`: copia **HTML** (`navigator.clipboard.writeText` com fallback `execCommand('copy')`).

---

## Permissões usadas

- `scripting`
- `activeTab`
- `tabs`
- `downloads`
- `debugger`
- `clipboardWrite`

---

## Limitações

- Não injeta em páginas restritas (`chrome://*`, páginas internas, etc.).
- Em alguns cenários CDP/debugger pode falhar.
- Clipboard de imagem depende de suporte de API/permissões/contexto.
- Shadow DOM complexo pode exigir ajustes extras.

---

## Debug

- Logs da página: DevTools da aba (`console`).
- Logs do worker: `chrome://extensions` → extensão → **Service worker** → **Inspect**.

---

## Licença

Defina licença desejada (MIT, Apache-2.0, etc.).
