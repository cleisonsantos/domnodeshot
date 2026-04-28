// content.js
//
// Executa no contexto da página (content script) e implementa:
// - seleção visual precisa com overlay fixo
// - captura da imagem do elemento no clique
// - cópia para clipboard (imagem por padrão, HTML com Ctrl/Shift)
// - desativação automática após captura
//
// Melhorias de granularidade:
// - seleção por mousemove + elementsFromPoint (mais estável)
// - overlay posicionado pelo getBoundingClientRect
// - navegação de seleção por teclado (↑ pai, ↓ primeiro filho, ESC cancela)

let active = false;
let currentEl = null;
let overlayEl = null;
let pendingFrameOffsetRequests = new Map();
let frameOffsetRoutes = new Map();

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

  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  const clickedEl = ev.target instanceof Element ? ev.target : null;
  const el = currentEl || clickedEl;
  if (!(el instanceof Element)) return;

  const accelKey = ev.ctrlKey || ev.metaKey;

  await performCaptureAction(el, {
    doDownload: accelKey,
    includeHtmlInClipboard: !!(accelKey && ev.shiftKey)
  });
}

async function performCaptureAction(el, { doDownload = false, includeHtmlInClipboard = false } = {}) {
  const outerHTML = el.outerHTML;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = el.classList?.length ? "." + [...el.classList].join(".") : "";

  const r = el.getBoundingClientRect();
  const absoluteRect = await getAbsoluteViewportRect({
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height
  });
  const pageRect = {
    x: absoluteRect.x + absoluteRect.topScrollX,
    y: absoluteRect.y + absoluteRect.topScrollY,
    width: absoluteRect.width,
    height: absoluteRect.height
  };
  const viewportRect = {
    x: absoluteRect.x,
    y: absoluteRect.y,
    width: absoluteRect.width,
    height: absoluteRect.height
  };

  const baseName = `${tag}${el.id ? "-" + el.id : ""}-${Date.now()}`;

  setActive(false);
  chrome.runtime.sendMessage({ type: "SELECTION_DEACTIVATED" });
  await waitForNextPaint();

  let imageResult = null;
  try {
    imageResult = await chrome.runtime.sendMessage({
      type: "CAPTURE_ELEMENT_CDP",
      pageRect,
      viewportRect,
      devicePixelRatio: window.devicePixelRatio || 1,
      suggestedName: baseName,
      includeDataUrl: true,
      doDownload
    });
  } catch (err) {
    imageResult = { ok: false, error: String(err) };
  }

  let copied = false;
  let copiedType = "none";

  if (imageResult?.ok && imageResult?.dataUrl) {
    copied = includeHtmlInClipboard
      ? await copyImageAndHtmlToClipboard(imageResult.dataUrl, outerHTML)
      : await copyImageDataUrlToClipboard(imageResult.dataUrl);

    copiedType = copied ? (includeHtmlInClipboard ? "image+html" : "image") : "none";
  }

  if (!copied) {
    copied = await copyToClipboard(outerHTML);
    copiedType = copied ? "html-fallback" : "none";
  }

  console.log(
    `[DOM Selector] Capturado: ${tag}${id}${classes}`,
    {
      copied,
      copiedType,
      doDownload,
      includeHtmlInClipboard,
      imageResult,
      outerHTMLLength: outerHTML.length,
      element: el
    }
  );
}

async function onKeyDownCapture(ev) {
  if (!active) return;

  if (ev.key === "Escape" || ev.key === "Esc") {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    setActive(false);
    chrome.runtime.sendMessage({ type: "SELECTION_DEACTIVATED" });
    return;
  }

  if (!currentEl) return;

  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    const accelKey = ev.ctrlKey || ev.metaKey;

    await performCaptureAction(currentEl, {
      doDownload: accelKey,
      includeHtmlInClipboard: !!(accelKey && ev.shiftKey)
    });
    return;
  }

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

async function dataUrlToBlob(dataUrl) {
  const resp = await fetch(dataUrl);
  return await resp.blob();
}

async function copyImageDataUrlToClipboard(dataUrl) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      return false;
    }

    const blob = await dataUrlToBlob(dataUrl);
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type || "image/png"]: blob
      })
    ]);

    return true;
  } catch {
    return false;
  }
}

async function copyImageAndHtmlToClipboard(dataUrl, html) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      return false;
    }

    const blob = await dataUrlToBlob(dataUrl);
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type || "image/png"]: blob,
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([html], { type: "text/plain" })
      })
    ]);

    return true;
  } catch {
    return false;
  }
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

function createFrameRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getAllFrameElements() {
  return [...document.querySelectorAll("iframe, frame")];
}

function findChildFrameElement(sourceWindow) {
  for (const frameEl of getAllFrameElements()) {
    try {
      if (frameEl.contentWindow === sourceWindow) {
        return frameEl;
      }
    } catch {
      // ignora iframe inacessível; comparação pode falhar em alguns casos
    }
  }

  return null;
}

function forwardFrameOffsetRequestUpward(requestId, rect) {
  if (window.parent === window) {
    return;
  }

  window.parent.postMessage(
    {
      source: "domnodeshot-extension",
      type: "DOMNODESHOT_FRAME_OFFSET_REQUEST",
      requestId,
      rect
    },
    "*"
  );
}

async function getAbsoluteViewportRect(rect) {
  if (window.parent === window) {
    return {
      ...rect,
      topScrollX: window.scrollX,
      topScrollY: window.scrollY
    };
  }

  const requestId = createFrameRequestId();

  return await new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingFrameOffsetRequests.delete(requestId);
      resolve({
        ...rect,
        topScrollX: 0,
        topScrollY: 0
      });
    }, 1500);

    pendingFrameOffsetRequests.set(requestId, {
      resolve(payload) {
        clearTimeout(timeoutId);
        resolve(payload);
      }
    });

    forwardFrameOffsetRequestUpward(requestId, rect);
  });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || msg.source !== "domnodeshot-extension") return;

  if (msg.type === "DOMNODESHOT_FRAME_OFFSET_REQUEST") {
    const frameEl = findChildFrameElement(event.source);
    if (!frameEl) return;

    const frameRect = frameEl.getBoundingClientRect();
    const nextRect = {
      x: msg.rect.x + frameRect.left,
      y: msg.rect.y + frameRect.top,
      width: msg.rect.width,
      height: msg.rect.height
    };

    if (window.parent === window) {
      event.source?.postMessage(
        {
          source: "domnodeshot-extension",
          type: "DOMNODESHOT_FRAME_OFFSET_RESPONSE",
          requestId: msg.requestId,
          rect: nextRect,
          topScrollX: window.scrollX,
          topScrollY: window.scrollY
        },
        "*"
      );
      return;
    }

    frameOffsetRoutes.set(msg.requestId, event.source);
    forwardFrameOffsetRequestUpward(msg.requestId, nextRect);
    return;
  }

  if (msg.type === "DOMNODESHOT_FRAME_OFFSET_RESPONSE") {
    const pending = pendingFrameOffsetRequests.get(msg.requestId);
    if (pending) {
      pendingFrameOffsetRequests.delete(msg.requestId);
      pending.resolve({
        ...msg.rect,
        topScrollX: msg.topScrollX || 0,
        topScrollY: msg.topScrollY || 0
      });
      return;
    }

    const routeTarget = frameOffsetRoutes.get(msg.requestId);
    if (!routeTarget) return;

    frameOffsetRoutes.delete(msg.requestId);
    routeTarget?.postMessage(msg, "*");
  }
});

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
