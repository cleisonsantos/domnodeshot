# DOMnodeshot — Extensão Chrome (Manifest V3)

`DOMnodeshot` ativa modo de seleção visual de elementos na página e captura imagem do elemento selecionado.

Descrição da extensão (manifest):

> Seleciona elementos, captura PNG completo, baixa imagem e copia para clipboard (Ctrl/Shift copia outerHTML).

---

## Recursos

- Atalho para ligar/desligar modo de seleção.
- Overlay de highlight sem alterar layout.
- Hit-test com amostragem ao redor do cursor (seleção mais estável).
- Clique no elemento:
  - captura PNG do elemento;
  - baixa arquivo PNG;
  - copia **imagem** para clipboard por padrão.
- Clique com `Ctrl` ou `Shift`: copia **`outerHTML`** em vez da imagem.
- `Esc`/`Escape`: cancela seleção ativa.
- Navegação de seleção por teclado:
  - `ArrowUp`: pai
  - `ArrowDown`: primeiro filho

---

## Captura: CDP + fallback

Fluxo atual de captura:

1. Tenta captura completa via CDP (`chrome.debugger` + `Page.captureScreenshot`).
2. Se CDP falhar (site/restrição/attach), usa fallback `chrome.tabs.captureVisibleTab`.
3. No fallback, imagem é recortada para retângulo do elemento visível no viewport.

Resultado:
- com CDP: melhor chance de conteúdo completo fora da área visível;
- fallback: funciona sem CDP, mas limitado ao que está visível.

---

## Estrutura

- `manifest.json`
  - MV3, comando de atalho, permissões e metadados da extensão.
- `background.js`
  - service worker, toggle por aba, captura CDP, fallback `captureVisibleTab`, download.
- `content.js`
  - seleção, overlay, clique, cópia imagem/HTML, cancelamento por `Esc`.
- `styles.css`
  - estilos de cursor/overlay.
- `icons/`
  - ícones 16/32/48/128.

---

## Instalação (modo dev)

1. Abrir `chrome://extensions`
2. Ativar **Modo do desenvolvedor**
3. Clicar **Carregar sem compactação**
4. Selecionar pasta do projeto

---

## Atalhos

- Ativar/desativar modo seleção:
  - Windows/Linux: `Ctrl+Shift+X`
  - macOS: `Command+Shift+X`
- Cancelar seleção ativa: `Esc` / `Escape`

---

## Permissões

- `scripting`
- `activeTab`
- `tabs`
- `downloads`
- `debugger`
- `clipboardWrite`

---

## Limitações

- Não injeta em páginas restritas (`chrome://*`, internas).
- CDP pode falhar em alguns contextos; fallback cobre parte do cenário.
- Clipboard de imagem depende de suporte de API/contexto.

---

## Publicação (CWS)

Materiais prontos:

- `docs/cws/STORE_LISTING.pt-BR.md`
- `docs/cws/PERMISSIONS_JUSTIFICATION.pt-BR.md`
- `docs/cws/PUBLISH_CHECKLIST.pt-BR.md`
- `PRIVACY_POLICY.md`

---

## Licença

Definir (MIT, Apache-2.0, etc.).
