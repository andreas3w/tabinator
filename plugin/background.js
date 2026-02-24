const DEFAULT_LIMIT = 5;
const SETTINGS_POPUP_PATH = "popup.html";
const PROMPT_POPUP_PATH = "prompt.html";
const NEW_TAB_URL = "chrome://newtab/";

let promptWindowId = null;
const pendingQueue = [];

function getLimit() {
  return chrome.storage.local
    .get({ unpinnedLimit: DEFAULT_LIMIT })
    .then((v) => {
      const parsed = Number.parseInt(v.unpinnedLimit, 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return DEFAULT_LIMIT;
      }
      return Math.min(parsed, 100);
    })
    .catch(() => DEFAULT_LIMIT);
}

function isPromptTab(tab) {
  return Boolean(tab?.url?.startsWith(chrome.runtime.getURL(PROMPT_POPUP_PATH)));
}

function isExtensionInternalTab(tab) {
  return Boolean(tab?.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`));
}

async function listUnpinnedTabs(windowId) {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs
    .filter((tab) => !tab.pinned)
    .filter((tab) => !isPromptTab(tab))
    .filter((tab) => !isExtensionInternalTab(tab))
    .sort((a, b) => a.id - b.id);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRequestedUrl(tab) {
  if (typeof tab?.pendingUrl === "string" && tab.pendingUrl) {
    return tab.pendingUrl;
  }
  if (typeof tab?.url === "string" && tab.url) {
    return tab.url;
  }
  return "";
}

function isPlaceholderUrl(url) {
  return !url || url === "about:blank" || url.startsWith("chrome://newtab");
}

async function buildPendingEntry(tab) {
  let latest = tab;
  let url = extractRequestedUrl(latest);

  // Middle-click and some scripted opens can populate URL a moment after onCreated.
  if (isPlaceholderUrl(url) && typeof tab?.id === "number") {
    await sleep(120);
    try {
      latest = await chrome.tabs.get(tab.id);
      url = extractRequestedUrl(latest);
    } catch {
      // Keep original fallback values.
    }
  }

  return {
    windowId: latest.windowId ?? tab.windowId,
    url: url || NEW_TAB_URL,
    openerTabId: latest.openerTabId ?? tab.openerTabId,
    index: Number.isInteger(latest.index) ? latest.index : tab.index,
    active: Boolean(latest.active ?? tab.active),
    title: latest.title || tab.title || "",
  };
}

async function syncActionUi() {
  const hasPending = pendingQueue.length > 0;
  const popup = hasPending ? PROMPT_POPUP_PATH : SETTINGS_POPUP_PATH;

  try {
    await chrome.action.setPopup({ popup });
  } catch {
    // Ignore UI sync failures.
  }

  try {
    await chrome.action.setBadgeText({ text: hasPending ? String(Math.min(pendingQueue.length, 99)) : "" });
    if (hasPending) {
      await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    }
  } catch {
    // Ignore UI sync failures.
  }
}

function notifyPromptStateChanged() {
  chrome.runtime.sendMessage({ type: "promptStateChanged" }).catch(() => {
    // Prompt may not be open.
  });
}

async function openPromptWindowFallback() {
  if (!pendingQueue.length) {
    return;
  }

  if (promptWindowId !== null) {
    try {
      await chrome.windows.update(promptWindowId, { focused: true });
      return;
    } catch {
      promptWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PROMPT_POPUP_PATH),
    type: "popup",
    width: 460,
    height: 600,
    focused: true,
  });

  promptWindowId = win.id ?? null;
}

async function openPromptSurface() {
  if (!pendingQueue.length) {
    return;
  }

  await syncActionUi();

  try {
    if (typeof chrome.action.openPopup === "function") {
      const windowId = pendingQueue[0]?.windowId;
      if (typeof windowId === "number") {
        await chrome.action.openPopup({ windowId });
      } else {
        await chrome.action.openPopup();
      }
      notifyPromptStateChanged();
      return;
    }
  } catch {
    // Fall through to window fallback.
  }

  await openPromptWindowFallback();
  notifyPromptStateChanged();
}

async function closeFallbackPromptIfIdle() {
  if (pendingQueue.length || promptWindowId === null) {
    return;
  }

  try {
    await chrome.windows.remove(promptWindowId);
  } catch {
    // Ignore if already closed.
  }

  promptWindowId = null;
}

async function enforceLimitOnCreatedTab(tab) {
  if (!tab || tab.pinned || tab.windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  if (isPromptTab(tab) || isExtensionInternalTab(tab)) {
    return;
  }

  const limit = await getLimit();
  const unpinnedTabs = await listUnpinnedTabs(tab.windowId);

  if (unpinnedTabs.length <= limit) {
    return;
  }

  const pendingEntry = await buildPendingEntry(tab);
  pendingQueue.push(pendingEntry);

  try {
    await chrome.tabs.remove(tab.id);
  } catch {
    // If the tab already closed itself, keep the queued request anyway.
  }

  await openPromptSurface();
}

async function openNextPending() {
  if (!pendingQueue.length) {
    return;
  }

  const next = pendingQueue.shift();

  try {
    await chrome.tabs.create({
      windowId: next.windowId,
      url: next.url,
      openerTabId: next.openerTabId,
      index: next.index,
      active: next.active,
    });
  } catch {
    // Fall back if opener/index/window is invalid.
    try {
      await chrome.tabs.create({
        url: next.url,
        active: true,
      });
    } catch {
      // Drop if creation fails.
    }
  }
}

async function finalizePromptFlow(reopenPrompt) {
  await syncActionUi();

  if (pendingQueue.length && reopenPrompt) {
    await openPromptSurface();
  }

  await closeFallbackPromptIfIdle();
  notifyPromptStateChanged();
}

async function closeSpecificAndOpenNext(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    return false;
  }

  await openNextPending();
  await finalizePromptFlow(true);
  return true;
}

async function closeOldestAndOpenNext() {
  if (!pendingQueue.length) {
    await finalizePromptFlow(false);
    return false;
  }

  const targetWindowId = pendingQueue[0].windowId;
  const tabs = await listUnpinnedTabs(targetWindowId);
  const oldest = tabs[0];

  if (!oldest) {
    pendingQueue.shift();
    await finalizePromptFlow(true);
    return false;
  }

  return closeSpecificAndOpenNext(oldest.id);
}

async function dontOpenNext() {
  if (pendingQueue.length) {
    pendingQueue.shift();
  }

  await finalizePromptFlow(true);
  return true;
}

async function getPromptState() {
  const targetWindowId = pendingQueue[0]?.windowId;
  const tabs = targetWindowId ? await listUnpinnedTabs(targetWindowId) : [];
  const next = pendingQueue[0] || null;

  return {
    pendingCount: pendingQueue.length,
    nextPendingUrl: next?.url || "",
    nextPendingTitle: next?.title || "",
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
    })),
  };
}

chrome.tabs.onCreated.addListener((tab) => {
  enforceLimitOnCreatedTab(tab).catch(() => {
    // Keep listener resilient.
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === promptWindowId) {
    promptWindowId = null;
    notifyPromptStateChanged();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  syncActionUi().catch(() => {
    // Ignore.
  });
});

chrome.runtime.onStartup.addListener(() => {
  syncActionUi().catch(() => {
    // Ignore.
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "getPromptState") {
    getPromptState().then(sendResponse);
    return true;
  }

  if (message.type === "closeOldest") {
    closeOldestAndOpenNext().then(() => getPromptState().then(sendResponse));
    return true;
  }

  if (message.type === "closeSpecific") {
    closeSpecificAndOpenNext(message.tabId)
      .then(() => getPromptState())
      .then(sendResponse);
    return true;
  }

  if (message.type === "dontOpen") {
    dontOpenNext().then(() => getPromptState().then(sendResponse));
    return true;
  }

  if (message.type === "limitUpdated") {
    if (pendingQueue.length) {
      openPromptSurface().then(() => getPromptState().then(sendResponse));
      return true;
    }
    syncActionUi().then(() => getPromptState().then(sendResponse));
    return true;
  }
});

syncActionUi().catch(() => {
  // Ignore.
});
