// background.js (Manifest V3 - service worker)
//
// Responsável por:
// - ouvir o atalho (commands)
// - injetar content.js e styles.css quando necessário
// - manter o estado por aba (ativo/inativo)
// - solicitar ativação/desativação ao content script

const tabState = new Map(); // tabId -> boolean (ativo)

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-selector") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Páginas internas do Chrome não permitem injeção (chrome://, edge:// etc.)
  const url = tab.url || "";
  if (/^(chrome|edge|brave):\/\//i.test(url) || url.startsWith("chrome-extension://")) {
    console.info("[DOM Selector] Página restrita para extensões:", url);
    return;
  }

  const tabId = tab.id;
  const nextActive = !(tabState.get(tabId) === true);

  try {
    // Garante que o content script existe (se não existir, injeta).
    await ensureInjected(tabId);

    // Aplica/remove CSS conforme estado.
    if (nextActive) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["styles.css"]
      });
    } else {
      // removeCSS pode falhar em alguns cenários; tratamos no catch.
      await chrome.scripting.removeCSS({
        target: { tabId },
        files: ["styles.css"]
      });
    }

    // Pede para o content.js ativar/desativar listeners e UX.
    await chrome.tabs.sendMessage(tabId, { type: "SET_ACTIVE", active: nextActive });

    tabState.set(tabId, nextActive);
  } catch (err) {
    console.warn("Falha ao alternar modo de seleção:", err);
  }
});

// Mensagens vindas do content script:
// - SELECTION_DEACTIVATED: apenas sincroniza estado e remove CSS
// - CAPTURE_ELEMENT_CDP: captura o elemento completo via Chrome DevTools Protocol
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 1) Captura de imagem do elemento via CDP
  if (msg?.type === "CAPTURE_ELEMENT_CDP") {
    (async () => {
      const tabId = sender?.tab?.id;
      if (!tabId) {
        return { ok: false, error: "Sender inválido (sem tabId)." };
      }

      const pageRect = msg?.pageRect;
      const suggestedName = msg?.suggestedName;

      const downloadId = await captureAndDownloadElementViaCDP({
        tabId,
        pageRect,
        suggestedName
      });

      return { ok: true, downloadId };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err) }));

    // Mantém o canal aberto para resposta async
    return true;
  }

  // 2) Desativação automática após captura (HTML/Imagem)
  if (msg?.type === "SELECTION_DEACTIVATED") {
    const tabId = sender?.tab?.id;
    if (!tabId) return;

    tabState.set(tabId, false);

    chrome.scripting
      .removeCSS({
        target: { tabId },
        files: ["styles.css"]
      })
      .catch(() => {
        // Pode falhar em páginas que recarregaram; ignorar.
      });

    sendResponse?.({ ok: true });
  }
});

/**
 * Captura o elemento completo usando CDP (chrome.debugger).
 * Requer permissão "debugger" no manifest.
 */
async function captureAndDownloadElementViaCDP({ tabId, pageRect, suggestedName }) {
  if (!pageRect || typeof pageRect.x !== "number") {
    throw new Error("pageRect inválido enviado pelo content script.");
  }

  const safeName = sanitizeFilename(suggestedName || `capture-${Date.now()}`);
  const filename = `domnodeshot/${safeName}.png`;

  // Captura mais "justa" possível ao retângulo do elemento.
  const clip = {
    x: Math.max(0, Math.floor(pageRect.x)),
    y: Math.max(0, Math.floor(pageRect.y)),
    width: Math.max(1, Math.ceil(pageRect.width)),
    height: Math.max(1, Math.ceil(pageRect.height)),
    scale: 1
  };

  const dataUrl = await withDebugger(tabId, async (send) => {
    await send("Page.enable");

    // Em páginas com elementos muito altos, um único clip grande pode gerar
    // repetição do viewport. Capturamos em faixas e unimos no worker.
    const maxStripeHeight = 1024;
    const stripes = [];

    for (let offset = 0; offset < clip.height; offset += maxStripeHeight) {
      const stripeHeight = Math.min(maxStripeHeight, clip.height - offset);

      const result = await send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: clip.x,
          y: clip.y + offset,
          width: clip.width,
          height: stripeHeight,
          scale: 1
        }
      });

      stripes.push(result.data);
    }

    if (stripes.length === 1) {
      return `data:image/png;base64,${stripes[0]}`;
    }

    return await stitchPngBase64StripesToDataUrl(stripes, clip.width, clip.height);
  });

  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
  });

  return downloadId;
}

async function stitchPngBase64StripesToDataUrl(stripes, width, height) {
  if (!globalThis.OffscreenCanvas || !globalThis.createImageBitmap) {
    throw new Error("OffscreenCanvas/createImageBitmap indisponível para unir capturas.");
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Falha ao obter contexto 2D para montar captura.");

  let drawY = 0;

  for (const base64 of stripes) {
    const blob = base64ToBlob(base64, "image/png");
    const bitmap = await createImageBitmap(blob);

    ctx.drawImage(bitmap, 0, drawY);
    drawY += bitmap.height;

    if (typeof bitmap.close === "function") {
      bitmap.close();
    }
  }

  const mergedBlob = await canvas.convertToBlob({ type: "image/png" });
  const mergedBase64 = await blobToBase64(mergedBlob);
  return `data:image/png;base64,${mergedBase64}`;
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function sanitizeFilename(name) {
  return String(name)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80) || "capture";
}

// Injeção defensiva: tenta enviar "PING"; se não houver receiver, injeta.
async function ensureInjected(tabId) {
  const hasReceiver = await ping(tabId);
  if (hasReceiver) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  // Após injetar, confirmamos que está pronto.
  await ping(tabId);
}

function ping(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, () => {
      // Se não existe content script, teremos lastError.
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function withDebugger(tabId, fn) {
  const target = { tabId };

  await chrome.debugger.attach(target, "1.3");
  try {
    const send = (method, params = {}) =>
      chrome.debugger.sendCommand(target, method, params);

    return await fn(send);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // ignora (aba fechada, debugger já removido etc.)
    }
  }
}
