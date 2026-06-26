// content.js
//
// Executa no contexto da página (content script) e implementa:
// - seleção visual precisa com overlay fixo
// - captura da imagem do elemento no clique
// - cópia para clipboard, download direto ou abertura do editor conforme modificadores
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
const EDITOR_BLUR_RADIUS = 24;
const EDITOR_HISTORY_LIMIT = 50;
const EDITOR_SHAPE_COLORS = [
  { value: "#ef4444", label: "Red" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#22c55e", label: "Green" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#111827", label: "Black" },
  { value: "#ffffff", label: "White" }
];

let imageEditor = null;

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

  await performCaptureAction(el, {
    action: getCaptureActionFromEvent(ev, { allowEditor: true })
  });
}

function getCaptureActionFromEvent(ev, { allowEditor = false } = {}) {
  const accelKey = ev.ctrlKey || ev.metaKey;

  if (allowEditor && accelKey && ev.shiftKey) return "editor";
  if (ev.shiftKey) return "copy-html";
  if (accelKey) return "download";
  return "copy-image";
}

async function performCaptureAction(el, { action = "copy-image" } = {}) {
  const outerHTML = el.outerHTML;
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const classes = el.classList?.length ? "." + [...el.classList].join(".") : "";

  if (action === "copy-html") {
    setActive(false);
    chrome.runtime.sendMessage({ type: "SELECTION_DEACTIVATED" });
    await waitForNextPaint();

    const copiedHtml = await copyToClipboard(outerHTML);

    console.log(
      `[DOM Selector] HTML copiado: ${tag}${id}${classes}`,
      {
        copied: copiedHtml,
        copiedType: copiedHtml ? "html" : "none",
        action,
        outerHTMLLength: outerHTML.length,
        element: el
      }
    );
    return;
  }

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
  const preferVisibleTab = isRectFullyInsideViewport(viewportRect);

  const baseName = `${tag}${el.id ? "-" + el.id : ""}-${Date.now()}`;

  setActive(false);
  chrome.runtime.sendMessage({ type: "SELECTION_DEACTIVATED", keepCss: action === "editor" });
  await waitForNextPaint();

  let imageResult = null;
  try {
    imageResult = await chrome.runtime.sendMessage({
      type: "CAPTURE_ELEMENT_CDP",
      pageRect,
      viewportRect,
      devicePixelRatio: window.devicePixelRatio || 1,
      preferVisibleTab,
      suggestedName: baseName,
      includeDataUrl: true,
      doDownload: action === "download"
    });
  } catch (err) {
    imageResult = { ok: false, error: String(err) };
  }

  let copied = false;
  let copiedType = "none";

  if (imageResult?.ok && imageResult?.dataUrl) {
    if (action === "editor") {
      openImageEditor({
        dataUrl: imageResult.dataUrl,
        suggestedName: baseName
      });
    } else {
      copied = await copyImageDataUrlToClipboard(imageResult.dataUrl);
      copiedType = copied ? "image" : "none";
    }
  } else {
    if (action === "editor") {
      try {
        chrome.runtime.sendMessage({ type: "EDITOR_CLOSED" })?.catch?.(() => {});
      } catch {
        // Ignora runtime desconectado; o fallback abaixo ainda preserva o HTML.
      }
    }

    copied = await copyToClipboard(outerHTML);
    copiedType = copied ? "html-fallback" : "none";
  }

  console.log(
    `[DOM Selector] Capturado: ${tag}${id}${classes}`,
    {
      copied,
      copiedType,
      action,
      imageResult,
      outerHTMLLength: outerHTML.length,
      element: el
    }
  );
}

function openImageEditor({ dataUrl, suggestedName }) {
  closeImageEditor({ releaseCss: false });

  const root = document.createElement("div");
  root.className = "domnodeshot-editor-backdrop";
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "DomNodeShot image editor");

  const modal = document.createElement("section");
  modal.className = "domnodeshot-editor-modal";

  const toolbar = document.createElement("div");
  toolbar.className = "domnodeshot-editor-toolbar";

  const toolGroup = document.createElement("div");
  toolGroup.className = "domnodeshot-editor-toolbar-group";

  const highlightButton = createEditorButton("Highlight");
  const blurButton = createEditorButton("Blur");
  const cropButton = createEditorButton("Crop");

  const shapeGroup = document.createElement("div");
  shapeGroup.className = "domnodeshot-editor-shape-group";
  const shapeButton = createEditorButton("Shape");
  const shapeMenu = document.createElement("div");
  shapeMenu.className = "domnodeshot-shape-menu";
  shapeMenu.hidden = true;

  const shapeTypeGroup = document.createElement("div");
  shapeTypeGroup.className = "domnodeshot-shape-segmented";
  const shapeTypeButtons = {
    rect: createShapeOptionButton("rect", "Rect"),
    line: createShapeOptionButton("line", "Line"),
    arrow: createShapeOptionButton("arrow", "Arrow")
  };
  shapeTypeGroup.append(shapeTypeButtons.rect, shapeTypeButtons.line, shapeTypeButtons.arrow);

  const colorGroup = document.createElement("div");
  colorGroup.className = "domnodeshot-shape-colors";
  const colorButtons = {};
  for (const color of EDITOR_SHAPE_COLORS) {
    const button = createShapeColorButton(color);
    colorButtons[color.value] = button;
    colorGroup.appendChild(button);
  }

  const strokeWidthWrap = document.createElement("div");
  strokeWidthWrap.className = "domnodeshot-shape-size";
  const strokeWidthInput = document.createElement("input");
  strokeWidthInput.type = "range";
  strokeWidthInput.min = "2";
  strokeWidthInput.max = "24";
  strokeWidthInput.step = "1";
  strokeWidthInput.value = "4";
  const strokeWidthValue = document.createElement("span");
  strokeWidthValue.className = "domnodeshot-shape-size-value";
  strokeWidthValue.textContent = "4px";
  strokeWidthWrap.append(strokeWidthInput, strokeWidthValue);

  shapeMenu.append(
    createEditorField("Shape", shapeTypeGroup),
    createEditorField("Color", colorGroup),
    createEditorField("Size", strokeWidthWrap)
  );
  shapeGroup.append(shapeButton, shapeMenu);

  toolGroup.append(highlightButton, blurButton, cropButton, shapeGroup);

  const actionGroup = document.createElement("div");
  actionGroup.className = "domnodeshot-editor-toolbar-group";
  const resetButton = createEditorButton("Reset");
  const copyButton = createEditorButton("Copy image");
  const downloadButton = createEditorButton("Download PNG");
  const closeButton = createEditorButton("Close");
  closeButton.classList.add("domnodeshot-editor-close");
  actionGroup.append(resetButton, copyButton, downloadButton, closeButton);

  const status = document.createElement("div");
  status.className = "domnodeshot-editor-status";

  toolbar.append(toolGroup, actionGroup, status);

  const canvasWrap = document.createElement("div");
  canvasWrap.className = "domnodeshot-editor-canvas-wrap";

  const canvas = document.createElement("canvas");
  canvas.className = "domnodeshot-editor-canvas";
  canvas.tabIndex = 0;
  canvasWrap.appendChild(canvas);

  modal.append(toolbar, canvasWrap);
  root.appendChild(modal);
  document.documentElement.appendChild(root);

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) {
    root.remove();
    return;
  }

  const state = {
    root,
    canvas,
    ctx,
    img: null,
    suggestedName,
    tool: "highlight",
    shapeMenuOpen: false,
    shapeOptions: {
      shapeType: "rect",
      color: "#ef4444",
      strokeWidth: 4
    },
    crop: null,
    actions: [],
    history: [],
    isDrawing: false,
    dragStart: null,
    previewAction: null,
    buttons: {
      highlight: highlightButton,
      blur: blurButton,
      crop: cropButton,
      shape: shapeButton,
      reset: resetButton,
      copy: copyButton,
      download: downloadButton,
      close: closeButton
    },
    controls: {
      shapeMenu,
      shapeTypeButtons,
      colorButtons,
      strokeWidthInput,
      strokeWidthValue,
      status
    }
  };

  imageEditor = state;

  root.addEventListener("click", (ev) => {
    if (!state.shapeMenuOpen) return;
    const target = ev.target;
    if (
      state.controls.shapeMenu.contains(target) ||
      state.buttons.shape.contains(target)
    ) {
      return;
    }
    setShapeMenuOpen(false);
  });

  highlightButton.addEventListener("click", () => selectEditorTool("highlight"));
  blurButton.addEventListener("click", () => selectEditorTool("blur"));
  cropButton.addEventListener("click", () => selectEditorTool("crop"));
  shapeButton.addEventListener("click", () => {
    const wasOpen = state.shapeMenuOpen;
    selectEditorTool("shape");
    setShapeMenuOpen(!wasOpen);
  });
  resetButton.addEventListener("click", resetImageEditor);
  copyButton.addEventListener("click", () => copyEditorImage());
  downloadButton.addEventListener("click", () => downloadEditorImage());
  closeButton.addEventListener("click", closeImageEditor);

  for (const [shapeType, button] of Object.entries(shapeTypeButtons)) {
    button.addEventListener("click", () => {
      state.shapeOptions.shapeType = shapeType;
      updateEditorUi();
    });
  }

  for (const [color, button] of Object.entries(colorButtons)) {
    button.addEventListener("click", () => {
      state.shapeOptions.color = color;
      updateEditorUi();
    });
  }

  strokeWidthInput.addEventListener("input", () => {
    state.shapeOptions.strokeWidth = normalizeEditorStrokeWidth(strokeWidthInput.value);
    updateEditorUi();
  });
  strokeWidthInput.addEventListener("change", () => {
    state.shapeOptions.strokeWidth = normalizeEditorStrokeWidth(strokeWidthInput.value);
    strokeWidthInput.value = String(state.shapeOptions.strokeWidth);
    updateEditorUi();
  });

  canvas.addEventListener("pointerdown", onEditorPointerDown);
  canvas.addEventListener("pointermove", onEditorPointerMove);
  canvas.addEventListener("pointerup", onEditorPointerUp);
  canvas.addEventListener("pointercancel", onEditorPointerCancel);
  root.addEventListener("keydown", onEditorKeyDown, true);

  const img = new Image();
  img.onload = () => {
    if (imageEditor !== state) return;

    const width = Math.max(1, img.naturalWidth || img.width || 1);
    const height = Math.max(1, img.naturalHeight || img.height || 1);
    state.img = img;
    state.crop = { x: 0, y: 0, width, height };
    renderImageEditor();
    updateEditorUi();
    root.focus({ preventScroll: true });
  };
  img.onerror = () => {
    updateEditorStatus("Could not load captured image.");
  };
  img.src = dataUrl;

  updateEditorUi();
}

function closeImageEditor({ releaseCss = true } = {}) {
  if (!imageEditor) return;

  imageEditor.root?.remove();
  imageEditor = null;

  if (releaseCss) {
    try {
      chrome.runtime.sendMessage({ type: "EDITOR_CLOSED" })?.catch?.(() => {});
    } catch {
      // O editor pode ser fechado em paginas onde o runtime ja foi desconectado.
    }
  }
}

function createEditorButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "domnodeshot-editor-button";
  button.textContent = label;
  return button;
}

function createShapeOptionButton(value, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "domnodeshot-shape-option";
  button.dataset.shapeType = value;
  button.textContent = label;
  return button;
}

function createShapeColorButton(color) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "domnodeshot-shape-color";
  button.dataset.color = color.value;
  button.title = color.label;
  button.setAttribute("aria-label", color.label);
  button.style.setProperty("--domnodeshot-shape-color", color.value);
  return button;
}

function createEditorField(labelText, control) {
  const label = document.createElement("label");
  label.className = "domnodeshot-editor-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function selectEditorTool(tool) {
  if (!imageEditor) return;

  imageEditor.tool = tool;
  if (tool !== "shape") {
    setShapeMenuOpen(false);
  }

  updateEditorUi();
}

function setShapeMenuOpen(nextOpen) {
  if (!imageEditor) return;

  imageEditor.shapeMenuOpen = !!nextOpen;
  updateEditorUi();
}

function updateEditorUi() {
  const state = imageEditor;
  if (!state) return;

  for (const [tool, button] of Object.entries({
    highlight: state.buttons.highlight,
    blur: state.buttons.blur,
    crop: state.buttons.crop,
    shape: state.buttons.shape
  })) {
    button.classList.toggle("is-active", state.tool === tool);
    button.setAttribute("aria-pressed", state.tool === tool ? "true" : "false");
  }

  state.controls.shapeMenu.hidden = !state.shapeMenuOpen;
  state.controls.strokeWidthInput.value = String(state.shapeOptions.strokeWidth);
  state.controls.strokeWidthValue.textContent = `${state.shapeOptions.strokeWidth}px`;

  for (const [shapeType, button] of Object.entries(state.controls.shapeTypeButtons)) {
    const selected = state.shapeOptions.shapeType === shapeType;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }

  for (const [color, button] of Object.entries(state.controls.colorButtons)) {
    const selected = state.shapeOptions.color === color;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }

  const toolLabel = {
    highlight: "Highlight",
    blur: `Blur ${EDITOR_BLUR_RADIUS}px`,
    crop: "Crop",
    shape: `Shape: ${formatShapeType(state.shapeOptions.shapeType)}, ${getShapeColorLabel(state.shapeOptions.color)}, ${state.shapeOptions.strokeWidth}px`
  }[state.tool];

  updateEditorStatus(toolLabel || "");
}

function updateEditorStatus(text, options = {}) {
  if (!imageEditor?.controls?.status) return;
  const { type, duration } = options;
  const el = imageEditor.controls.status;
  clearTimeout(el._statusTimeout);
  el.textContent = text;
  el.classList.remove("is-success", "is-error");
  if (type === "success" || type === "error") {
    el.classList.add(type === "success" ? "is-success" : "is-error");
  }
  if (duration && Number.isFinite(duration)) {
    el._statusTimeout = setTimeout(() => {
      el.classList.remove("is-success", "is-error");
      if (el.textContent === text) {
        el.textContent = "";
      }
    }, duration);
  }
}

function formatShapeType(shapeType) {
  if (shapeType === "line") return "Line";
  if (shapeType === "arrow") return "Arrow";
  return "Rect";
}

function getShapeColorLabel(colorValue) {
  return EDITOR_SHAPE_COLORS.find((color) => color.value === colorValue)?.label || "Color";
}

function normalizeEditorStrokeWidth(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(24, Math.max(2, parsed));
}

function resetImageEditor() {
  const state = imageEditor;
  if (!state?.img || !hasEditorVisualChanges(state)) return;

  pushEditorHistory();
  state.actions = [];
  state.crop = getEditorFullImageRect(state);
  state.previewAction = null;
  renderImageEditor();
  updateEditorUi();
}

function hasEditorVisualChanges(state) {
  if (!state?.img || !state.crop) return false;

  const full = getEditorFullImageRect(state);
  return (
    state.actions.length > 0 ||
    state.crop.x !== full.x ||
    state.crop.y !== full.y ||
    state.crop.width !== full.width ||
    state.crop.height !== full.height
  );
}

function pushEditorHistory() {
  const state = imageEditor;
  if (!state?.crop) return;

  state.history.push({
    crop: { ...state.crop },
    actions: state.actions.map(cloneEditorAction)
  });

  if (state.history.length > EDITOR_HISTORY_LIMIT) {
    state.history.shift();
  }
}

function cloneEditorAction(action) {
  return {
    ...action,
    rect: action.rect ? { ...action.rect } : null,
    start: action.start ? { ...action.start } : null,
    end: action.end ? { ...action.end } : null
  };
}

function undoImageEditor() {
  const state = imageEditor;
  if (!state?.history.length) return;

  const previous = state.history.pop();
  state.crop = { ...previous.crop };
  state.actions = previous.actions.map(cloneEditorAction);
  state.previewAction = null;
  state.isDrawing = false;
  state.dragStart = null;
  renderImageEditor();
  updateEditorUi();
}

function getEditorFullImageRect(state) {
  const img = state?.img;
  return {
    x: 0,
    y: 0,
    width: Math.max(1, img?.naturalWidth || img?.width || 1),
    height: Math.max(1, img?.naturalHeight || img?.height || 1)
  };
}

function renderImageEditor() {
  const state = imageEditor;
  if (!state?.img || !state.crop) return;

  const crop = {
    x: Math.round(state.crop.x),
    y: Math.round(state.crop.y),
    width: Math.max(1, Math.round(state.crop.width)),
    height: Math.max(1, Math.round(state.crop.height))
  };
  state.crop = crop;

  if (state.canvas.width !== crop.width) state.canvas.width = crop.width;
  if (state.canvas.height !== crop.height) state.canvas.height = crop.height;

  const { ctx } = state;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.filter = "none";
  ctx.drawImage(
    state.img,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    state.canvas.width,
    state.canvas.height
  );

  for (const action of state.actions) {
    renderEditorAction(ctx, action, crop, false);
  }

  if (state.previewAction) {
    renderEditorAction(ctx, state.previewAction, crop, true);
  }

  ctx.restore();
}

function renderEditorAction(ctx, action, crop, isPreview) {
  if (!action?.rect) return;

  if (action.type === "crop-preview") {
    renderEditorCropPreview(ctx, action, crop);
    return;
  }

  if (action.type === "highlight") {
    renderEditorHighlight(ctx, action, crop);
    return;
  }

  if (action.type === "blur") {
    renderEditorBlur(ctx, action, crop);
    if (isPreview) {
      drawEditorRectOutline(ctx, toCanvasRect(action.rect, crop), "#ffffff", true);
    }
    return;
  }

  if (action.type === "shape") {
    renderEditorShape(ctx, action, crop);
  }
}

function renderEditorHighlight(ctx, action, crop) {
  const rect = toCanvasRect(action.rect, crop);
  ctx.save();
  ctx.fillStyle = "rgba(255, 240, 0, 0.45)";
  ctx.strokeStyle = "rgba(202, 138, 4, 0.9)";
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function renderEditorBlur(ctx, action, crop) {
  const rect = intersectRects(
    toCanvasRect(action.rect, crop),
    { x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height }
  );
  if (!rect) return;

  const snapshot = document.createElement("canvas");
  snapshot.width = ctx.canvas.width;
  snapshot.height = ctx.canvas.height;
  const snapshotCtx = snapshot.getContext("2d", { alpha: true });
  if (!snapshotCtx) return;

  snapshotCtx.drawImage(ctx.canvas, 0, 0);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.filter = `blur(${EDITOR_BLUR_RADIUS}px)`;
  ctx.drawImage(snapshot, 0, 0);
  ctx.restore();
}

function renderEditorCropPreview(ctx, action, crop) {
  const canvasRect = { x: 0, y: 0, width: ctx.canvas.width, height: ctx.canvas.height };
  const rect = intersectRects(toCanvasRect(action.rect, crop), canvasRect);
  if (!rect) return;

  ctx.save();
  ctx.fillStyle = "rgba(15, 23, 42, 0.32)";
  ctx.fillRect(0, 0, ctx.canvas.width, rect.y);
  ctx.fillRect(0, rect.y + rect.height, ctx.canvas.width, ctx.canvas.height - rect.y - rect.height);
  ctx.fillRect(0, rect.y, rect.x, rect.height);
  ctx.fillRect(rect.x + rect.width, rect.y, ctx.canvas.width - rect.x - rect.width, rect.height);

  drawEditorRectOutline(ctx, rect, "rgba(15, 23, 42, 0.95)", true, 4);
  drawEditorRectOutline(ctx, rect, "#ffffff", true, 2);
  ctx.restore();
}

function renderEditorShape(ctx, action, crop) {
  const rect = toCanvasRect(action.rect, crop);
  const shapeType = action.shapeType || "rect";

  ctx.save();
  ctx.strokeStyle = action.color || "#ef4444";
  ctx.lineWidth = normalizeEditorStrokeWidth(action.strokeWidth);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (shapeType === "line" || shapeType === "arrow") {
    drawEditorLineShape(ctx, action, crop, shapeType === "arrow");
  } else {
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }

  ctx.restore();
}

function drawEditorLineShape(ctx, action, crop, withArrowHead) {
  const start = toCanvasPoint(action.start || action.rect, crop);
  const end = toCanvasPoint(action.end || {
    x: action.rect.x + action.rect.width,
    y: action.rect.y + action.rect.height
  }, crop);

  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  if (!withArrowHead) return;

  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const headLength = Math.max(12, ctx.lineWidth * 3.5);
  const spread = Math.PI / 7;

  ctx.beginPath();
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - headLength * Math.cos(angle - spread),
    end.y - headLength * Math.sin(angle - spread)
  );
  ctx.moveTo(end.x, end.y);
  ctx.lineTo(
    end.x - headLength * Math.cos(angle + spread),
    end.y - headLength * Math.sin(angle + spread)
  );
  ctx.stroke();
}

function drawEditorRectOutline(ctx, rect, color, dashed = false, lineWidth = 2) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (dashed) ctx.setLineDash([8, 5]);
  const offset = lineWidth % 2 === 1 ? 0.5 : 0;
  ctx.strokeRect(
    Math.round(rect.x) + offset,
    Math.round(rect.y) + offset,
    Math.max(1, Math.round(rect.width)),
    Math.max(1, Math.round(rect.height))
  );
  ctx.restore();
}

function onEditorPointerDown(ev) {
  const state = imageEditor;
  if (!state?.img || ev.button !== 0) return;

  const point = getEditorCanvasPoint(ev, state);
  if (!point) return;

  ev.preventDefault();
  ev.stopPropagation();

  state.canvas.focus({ preventScroll: true });
  state.isDrawing = true;
  state.dragStart = point;
  state.previewAction = null;
  state.canvas.setPointerCapture?.(ev.pointerId);
}

function onEditorPointerMove(ev) {
  const state = imageEditor;
  if (!state?.isDrawing || !state.dragStart) return;

  const point = getEditorCanvasPoint(ev, state);
  if (!point) return;

  ev.preventDefault();
  state.previewAction = buildEditorAction(state, state.dragStart, point);
  renderImageEditor();
}

function onEditorPointerUp(ev) {
  const state = imageEditor;
  if (!state?.isDrawing || !state.dragStart) return;

  const point = getEditorCanvasPoint(ev, state);
  const action = point ? buildEditorAction(state, state.dragStart, point) : null;

  ev.preventDefault();
  state.canvas.releasePointerCapture?.(ev.pointerId);
  state.isDrawing = false;
  state.dragStart = null;
  state.previewAction = null;

  if (!action || !isUsableEditorAction(action)) {
    renderImageEditor();
    return;
  }

  pushEditorHistory();

  if (action.type === "crop-preview") {
    state.crop = action.rect;
  } else {
    state.actions.push(action);
  }

  renderImageEditor();
  updateEditorUi();
}

function onEditorPointerCancel(ev) {
  const state = imageEditor;
  if (!state) return;

  state.canvas.releasePointerCapture?.(ev.pointerId);
  state.isDrawing = false;
  state.dragStart = null;
  state.previewAction = null;
  renderImageEditor();
}

function buildEditorAction(state, startPoint, endPoint) {
  const rect = normalizeEditorRect(startPoint, endPoint, state.crop);
  if (!rect) return null;

  if (state.tool === "crop") {
    return { type: "crop-preview", rect };
  }

  if (state.tool === "blur") {
    return { type: "blur", rect };
  }

  if (state.tool === "shape") {
    return {
      type: "shape",
      rect,
      start: roundEditorPoint(startPoint),
      end: roundEditorPoint(endPoint),
      shapeType: state.shapeOptions.shapeType,
      color: state.shapeOptions.color,
      strokeWidth: state.shapeOptions.strokeWidth
    };
  }

  return { type: "highlight", rect };
}

function getEditorCanvasPoint(ev, state) {
  const bounds = state.canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height || !state.crop) return null;

  const x = ((ev.clientX - bounds.left) / bounds.width) * state.canvas.width;
  const y = ((ev.clientY - bounds.top) / bounds.height) * state.canvas.height;

  return {
    x: state.crop.x + clampNumber(x, 0, state.crop.width),
    y: state.crop.y + clampNumber(y, 0, state.crop.height)
  };
}

function normalizeEditorRect(startPoint, endPoint, limitRect) {
  if (!startPoint || !endPoint || !limitRect) return null;

  const minX = limitRect.x;
  const minY = limitRect.y;
  const maxX = limitRect.x + limitRect.width;
  const maxY = limitRect.y + limitRect.height;
  const x1 = clampNumber(Math.min(startPoint.x, endPoint.x), minX, maxX);
  const y1 = clampNumber(Math.min(startPoint.y, endPoint.y), minY, maxY);
  const x2 = clampNumber(Math.max(startPoint.x, endPoint.x), minX, maxX);
  const y2 = clampNumber(Math.max(startPoint.y, endPoint.y), minY, maxY);

  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.round(x2 - x1),
    height: Math.round(y2 - y1)
  };
}

function isUsableEditorRect(rect) {
  return !!rect && rect.width >= 4 && rect.height >= 4;
}

function isUsableEditorAction(action) {
  if (!action) return false;

  if (action.type === "shape" && (action.shapeType === "line" || action.shapeType === "arrow")) {
    if (!action.start || !action.end) return false;
    return Math.hypot(action.end.x - action.start.x, action.end.y - action.start.y) >= 6;
  }

  return isUsableEditorRect(action.rect);
}

function toCanvasRect(rect, crop) {
  return {
    x: rect.x - crop.x,
    y: rect.y - crop.y,
    width: rect.width,
    height: rect.height
  };
}

function toCanvasPoint(point, crop) {
  return {
    x: point.x - crop.x,
    y: point.y - crop.y
  };
}

function roundEditorPoint(point) {
  return {
    x: Math.round(point.x),
    y: Math.round(point.y)
  };
}

function intersectRects(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const width = x2 - x1;
  const height = y2 - y1;

  if (width <= 0 || height <= 0) return null;
  return { x: x1, y: y1, width, height };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function onEditorKeyDown(ev) {
  if (!imageEditor) return;

  const key = String(ev.key || "").toLowerCase();
  const accelKey = ev.ctrlKey || ev.metaKey;

  if (key === "escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closeImageEditor();
    return;
  }

  if (accelKey && key === "z" && !ev.shiftKey) {
    ev.preventDefault();
    ev.stopPropagation();
    undoImageEditor();
    return;
  }

  if (accelKey && key === "c") {
    ev.preventDefault();
    ev.stopPropagation();
    copyEditorImage();
  }
}

async function copyEditorImage() {
  const state = imageEditor;
  if (!state?.canvas) return false;

  try {
    state.previewAction = null;
    renderImageEditor();

    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard image API unavailable.");
    }

    const blob = await getEditorPngBlob(state);
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type || "image/png"]: blob
      })
    ]);

    updateEditorStatus("✓ Imagem copiada para a área de transferência.", { type: "success", duration: 2600 });
    return true;
  } catch (err) {
    console.warn("[DOM Selector] Falha ao copiar imagem editada:", err);
    updateEditorStatus("✗ Falha ao copiar a imagem.", { type: "error", duration: 4000 });
    return false;
  }
}

function getEditorPngBlob(state) {
  return new Promise((resolve, reject) => {
    state.canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not create PNG blob."));
      }
    }, "image/png");
  });
}

async function downloadEditorImage() {
  const state = imageEditor;
  if (!state?.canvas) return false;

  state.previewAction = null;
  renderImageEditor();

  const dataUrl = state.canvas.toDataURL("image/png");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_EDITED_IMAGE",
      dataUrl,
      suggestedName: state.suggestedName
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Download failed.");
    }

    updateEditorStatus("Download started.");
    return true;
  } catch (err) {
    console.warn("[DOM Selector] Download via background falhou, usando fallback:", err);
    downloadEditorImageFallback(dataUrl, state.suggestedName);
    updateEditorStatus("Download started.");
    return true;
  }
}

function downloadEditorImageFallback(dataUrl, suggestedName) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = `${String(suggestedName || "capture").replace(/[^a-zA-Z0-9._-]/g, "-")}.png`;
  anchor.style.display = "none";
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
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

    await performCaptureAction(currentEl, {
      action: getCaptureActionFromEvent(ev, { allowEditor: true })
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

function isRectFullyInsideViewport(rect) {
  if (!rect || typeof rect.x !== "number") return false;

  return (
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x + rect.width <= window.innerWidth &&
    rect.y + rect.height <= window.innerHeight
  );
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
