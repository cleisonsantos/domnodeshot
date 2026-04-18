// content.js
//
// Executa no contexto da página (content script) e implementa:
// - seleção visual precisa com overlay fixo
// - captura do outerHTML no clique
// - cópia para clipboard
// - desativação automática após captura
//
// Melhorias de granularidade:
// - seleção por mousemove + elementsFromPoint (mais estável)
// - overlay posicionado pelo getBoundingClientRect
// - navegação de seleção por teclado (↑ pai, ↓ primeiro filho, ESC cancela)

let active = false;
let currentEl = null;
let overlayEl = null;

const CURSOR_CLASS = "domnodeshot-cursor";
const NO_SCROLL_CLASS = "domnodeshot-no-scroll";
const OVERLAY_CLASS = "domnodeshot-overlay";
const OVERLAY_LABEL_CLASS = "domnodeshot-overlay-label";

// Aumenta "sensibilidade" de hit-test: amostra pontos próximos ao cursor.
const HIT_TEST_RADIUS = 10;
const HIT_TEST_OFFSETS = [
  [0, 0],
  [-HIT_TEST_RADIUS, 0],
  [HIT_TEST_RADIUS, 0],
  [0, -HIT_TEST_RADIUS],
  [0, HIT_TEST_RADIUS],
  [-HIT_TEST_RADIUS, -HIT_TEST_RADIUS],
  [HIT_TEST_RADIUS, -HIT_TEST_RADIUS],
  [-HIT_TEST_RADIUS, HIT_TEST_RADIUS],
  [HIT_TEST_RADIUS, HIT_TEST_RADIUS]
];

function setActive(next) {
  if (active === next) return;
  active = next;

  if (active) {
    document.documentElement.classList.add(CURSOR_CLASS, NO_SCROLL_CLASS);
    document.body?.classList.add(NO_SCROLL_CLASS);

    ensureOverlay();

    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange, true);

    console.log("[DOM Selector] Modo de seleção ATIVADO.");
  } else {
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("keydown", onKeyDownCapture, true);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange, true);

    document.documentElement.classList.remove(CURSOR_CLASS, NO_SCROLL_CLASS);
    document.body?.classList.remove(NO_SCROLL_CLASS);
    clearHighlight();

    console.log("[DOM Selector] Modo de seleção DESATIVADO.");
  }
}

function ensureOverlay() {
  if (overlayEl?.isConnected) return;

  overlayEl = document.createElement("div");
  overlayEl.className = OVERLAY_CLASS;

  const label = document.createElement("div");
  label.className = OVERLAY_LABEL_CLASS;
  overlayEl.appendChild(label);

  document.documentElement.appendChild(overlayEl);
}

function onMouseMove(ev) {
  if (!active) return;

  const el = getSelectableElementAt(ev.clientX, ev.clientY);
  if (!el) return;

  highlight(el);
}

function onViewportChange() {
  if (!active || !currentEl) return;
  updateOverlayForElement(currentEl);
}

function getSelectableElementAt(x, y) {
  const candidates = new Map();

  for (const [dx, dy] of HIT_TEST_OFFSETS) {
    const sx = x + dx;
    const sy = y + dy;

    if (sx < 0 || sy < 0 || sx > window.innerWidth - 1 || sy > window.innerHeight - 1) {
      continue;
    }

    const stack = document.elementsFromPoint(sx, sy);
    for (let depth = 0; depth < stack.length; depth++) {
      const el = stack[depth];
      if (!(el instanceof Element)) continue;
      if (el === overlayEl || overlayEl?.contains(el)) continue;

      const dist = Math.hypot(dx, dy);
      const prev = candidates.get(el);

      if (!prev) {
        candidates.set(el, {
          depth,
          minDist: dist,
          hits: 1
        });
      } else {
        prev.depth = Math.min(prev.depth, depth);
        prev.minDist = Math.min(prev.minDist, dist);
        prev.hits += 1;
      }
    }
  }

  if (!candidates.size) return null;

  let bestEl = null;
  let bestMeta = null;

  for (const [el, meta] of candidates.entries()) {
    if (!bestEl) {
      bestEl = el;
      bestMeta = meta;
      continue;
    }

    if (
      meta.depth < bestMeta.depth ||
      (meta.depth === bestMeta.depth && meta.minDist < bestMeta.minDist) ||
      (meta.depth === bestMeta.depth && meta.minDist === bestMeta.minDist && meta.hits > bestMeta.hits)
    ) {
      bestEl = el;
      bestMeta = meta;
    }
  }

  return bestEl;
}

async function onClickCapture(ev) {
  if (!active) return;

  // Intercepta totalmente o clique
  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  const clickedEl = ev.target instanceof Element ? ev.target : null;
  const el = currentEl || clickedEl;
  if (!(el instanceof Element)) return;

  const outerHTML = el.outerHTML;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = el.classList?.length ? "." + [...el.classList].join(".") : "";

  // Calcula retângulo antes de desativar o modo (evita perder referência de alvo).
  const r = el.getBoundingClientRect();
  const pageRect = {
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height
  };

  // Nome sugerido do arquivo
  const baseName = `${tag}${el.id ? "-" + el.id : ""}-${Date.now()}`;

  // Copia para a área de transferência (com fallback)
  const copied = await copyToClipboard(outerHTML);

  // Desativa imediatamente para evitar overlay/borda na captura.
  setActive(false);
  chrome.runtime.sendMessage({ type: "SELECTION_DEACTIVATED" });

  // Aguarda repaint para garantir que o overlay saiu da composição.
  await waitForNextPaint();

  // Captura imagem do elemento (TAMANHO COMPLETO) via CDP.
  let imageResult = null;
  try {
    imageResult = await chrome.runtime.sendMessage({
      type: "CAPTURE_ELEMENT_CDP",
      pageRect,
      suggestedName: baseName
    });
  } catch (err) {
    imageResult = { ok: false, error: String(err) };
  }

  console.log(
    `[DOM Selector] Capturado: ${tag}${id}${classes}`,
    {
      copied,
      imageResult,
      outerHTMLLength: outerHTML.length,
      element: el
    }
  );
}

function onKeyDownCapture(ev) {
  if (!active) return;

  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    setActive(false);
    chrome.runtime.sendMessage({ type: "SELECTION_DEACTIVATED" });
    return;
  }

  if (!currentEl) return;

  if (ev.key === "ArrowUp") {
    const parent = currentEl.parentElement;
    if (!parent) return;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    highlight(parent);
    return;
  }

  if (ev.key === "ArrowDown") {
    const child = currentEl.firstElementChild;
    if (!child) return;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    highlight(child);
  }
}

function highlight(el) {
  if (currentEl === el) return;

  currentEl = el;
  updateOverlayForElement(currentEl);
}

function updateOverlayForElement(el) {
  ensureOverlay();
  if (!overlayEl || !el?.isConnected) return;

  const rect = el.getBoundingClientRect();

  overlayEl.style.display = "block";
  overlayEl.style.left = `${Math.max(0, rect.left)}px`;
  overlayEl.style.top = `${Math.max(0, rect.top)}px`;
  overlayEl.style.width = `${Math.max(0, rect.width)}px`;
  overlayEl.style.height = `${Math.max(0, rect.height)}px`;

  const label = overlayEl.querySelector(`.${OVERLAY_LABEL_CLASS}`);
  if (label) {
    const tag = el.tagName?.toLowerCase() || "element";
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList?.length ? "." + [...el.classList].slice(0, 3).join(".") : "";
    label.textContent = `${tag}${id}${cls}`;
  }
}

function clearHighlight() {
  currentEl = null;
  if (overlayEl) {
    overlayEl.style.display = "none";
  }
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

async function copyToClipboard(text) {
  // 1) Tenta Clipboard API (geralmente funciona com gesto de usuário)
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // continua para fallback
  }

  // 2) Fallback com textarea + execCommand("copy")
  try {
    const ta = document.createElement("textarea");
    ta.value = text;

    // Minimiza impacto visual/layout
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.left = "-9999px";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.opacity = "0";

    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// Listener de mensagens do background
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PING") {
    sendResponse({ ok: true });
    return; // sem async
  }

  if (msg?.type === "SET_ACTIVE") {
    setActive(!!msg.active);
    sendResponse({ ok: true, active });
    return;
  }
});
