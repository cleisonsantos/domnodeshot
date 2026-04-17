# DOM Node Selector (OuterHTML Copier) — Extensão Chrome (Manifest V3)

Extensão para Google Chrome (Manifest V3) que replica o comportamento do **seletor de elementos do DevTools** (estilo `Ctrl+Shift+C`), permitindo:

- Ativar/desativar um **modo de seleção visual** via atalho de teclado.
- Destacar (highlight) elementos ao passar o mouse.
- Ao clicar em um elemento, capturar o **`outerHTML`**.
- Copiar automaticamente o HTML capturado para a **área de transferência (clipboard)**.
- Baixar automaticamente um **PNG do elemento em tamanho completo** sem precisar rolar visualmente a página (via CDP/debugger).
- Desativar o modo de seleção automaticamente após a captura.

> Observação: o DevTools tem privilégios especiais. Aqui o comportamento é implementado via **Content Script + CSS** usando as APIs de extensão.

---

## Estrutura do projeto

- `manifest.json` — Configuração da extensão (Manifest V3), permissões (`scripting`, `downloads`, `debugger`, etc.) e atalho (`commands`).
- `background.js` — Service Worker: escuta o atalho, injeta scripts/CSS, controla estado por aba e faz screenshot/recorte para baixar PNG.
- `content.js` — Script injetado na página: faz o highlight, intercepta clique e copia o `outerHTML`.
- `styles.css` — Estilo do destaque (outline + overlay) e cursor de mira.

---

## Como instalar/testar (Modo Desenvolvedor)

1. Abra o Chrome e acesse: `chrome://extensions`
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta deste projeto (onde está o `manifest.json`).
5. Abra qualquer site e use o atalho para ativar o modo de seleção.

---

## Atalho de teclado

- **Windows/Linux:** `Ctrl + Shift + X`
- **macOS:** `Command + Shift + X`

Esse atalho é definido em `manifest.json` na seção `commands`.

> Se houver conflito com outro atalho no seu sistema/extensões, você pode mudar em `chrome://extensions/shortcuts`.

---

## Como funciona (visão geral)

### 1) `background.js` (Service Worker)
- Escuta o comando `toggle-selector` (atalho).
- Descobre a aba ativa.
- Garante que o `content.js` esteja injetado usando `chrome.scripting.executeScript`.
- Insere/remove `styles.css` com `chrome.scripting.insertCSS/removeCSS`.
- Envia mensagem para o content script ligar/desligar o modo de seleção.
- Mantém um **estado por aba** (Map `tabId -> ativo`), para que o toggle funcione corretamente.

### 2) `content.js` (Content Script)
Quando o modo está **ativo**:
- Adiciona listeners em modo **capture** (`true`) para interceptar eventos antes do site:
  - `mouseover`: aplica destaque no elemento sob o mouse.
  - `mouseout`: remove destaque quando sai do elemento.
  - `click`: intercepta o clique, impede a ação do site e captura.

No clique:
1. `preventDefault()`, `stopPropagation()` e `stopImmediatePropagation()`.
2. Captura `outerHTML` do elemento (`ev.target.outerHTML`).
3. Copia o texto para o clipboard:
   - Tenta `navigator.clipboard.writeText`.
   - Se falhar, usa fallback `textarea` + `document.execCommand('copy')`.
4. Pede ao `background.js` para capturar o elemento via **Chrome DevTools Protocol (CDP)** com `Page.captureScreenshot` e `captureBeyondViewport`.
5. Faz `console.log` com tag/id/classes + metadados.
6. Desativa o modo automaticamente e notifica o `background.js`.

### 3) `styles.css` (Highlight sem quebrar layout)
Para evitar alterar o layout da página:
- Usa `outline` (não afeta fluxo como `border`).
- Usa `box-shadow` inset grande para criar um “fundo” azul sem mexer nas dimensões.
- Aplica cursor `crosshair` enquanto o modo está ativo.

---

## Limitações e notas importantes

- **Páginas especiais**: extensões normalmente **não podem** injetar scripts em páginas como:
  - `chrome://*`
  - `chromewebstore.google.com`
  - algumas páginas internas/privadas do navegador
- **Screenshot do elemento (tamanho completo)**: é feito via CDP/debugger. Em algumas páginas com políticas mais restritas, a captura pode falhar caso o debugger não consiga se anexar à aba.
- **Clipboard**: a cópia costuma funcionar porque o clique é um gesto do usuário, mas algumas páginas/políticas podem restringir.
- **Shadow DOM**: o highlight funciona em elementos dentro de Shadow DOM quando o evento chega ao host/target, mas alguns casos avançados podem exigir tratamento extra.

---

## Dicas de debug

- Abra o DevTools da página e veja o `console.log` após a captura.
- Abra `chrome://extensions` → sua extensão → **Service worker** → **Inspect** para ver logs do `background.js`.

---

## Próximos passos (opcional)

Se você quiser evoluir esta extensão, ideias comuns:
- Exibir um **toast** na página confirmando “Copiado!” e “Imagem salva”.
- Capturar também um seletor CSS (ex: `div#id.class1.class2 > span...`).
- Adicionar fallback automático para `captureVisibleTab` quando CDP estiver indisponível.

---

## Publicar este projeto no GitHub

Se quiser subir este projeto para um repositório remoto, rode:

```bash
git init
git add .
git commit -m "feat: extensão DOM Node Selector"
git remote add origin git@github.com:cleisonsantos/domnodeshot.git
git branch -M main
git push -u origin main
```

> Se o repositório remoto já tiver commits (ex.: README criado no GitHub), faça antes um `git pull --rebase origin main` ou use `git push -u origin main --force` com cuidado.

## Licença

Defina a licença que preferir (MIT, Apache-2.0, etc.).
