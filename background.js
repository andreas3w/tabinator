const DEFAULT_LIMIT = 5;
const SETTINGS_POPUP_PATH = "popup.html";
const PROMPT_POPUP_PATH = "prompt.html";
const AUTOPIN_PROMPT_POPUP_PATH = "autopin-prompt.html";
const NEW_TAB_URL = "chrome://newtab/";

const DEFAULT_AUTO_CLOSE_PATTERNS = [
  "chrome://newtab",
  "chrome://new-tab-page",
  "edge://newtab",
  "signin.aws.amazon.com",
  "us-east-1.signin.aws.amazon.com",
  "phd.awsapps.com",
  "github.com/login",
  "github.com/sessions",
];
const DEFAULT_AUTOPIN_PATTERNS = [];
const AUTOPIN_QUICK_SLOT_COUNT = 5;

let promptWindowId = null;
let autoPinPromptWindowId = null;
const pendingQueue = [];
const autoPinConflictQueue = [];

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

function getAutoClosePatterns() {
  return chrome.storage.local
    .get({
      autoClosePatterns: DEFAULT_AUTO_CLOSE_PATTERNS,
      autoCloseEnabled: true,
    })
    .then((v) => ({
      enabled: v.autoCloseEnabled !== false,
      patterns: Array.isArray(v.autoClosePatterns)
        ? v.autoClosePatterns
        : DEFAULT_AUTO_CLOSE_PATTERNS,
    }))
    .catch(() => ({ enabled: true, patterns: DEFAULT_AUTO_CLOSE_PATTERNS }));
}

function getAutoPinSettings() {
  return chrome.storage.local
    .get({
      autopinPatterns: DEFAULT_AUTOPIN_PATTERNS,
      autopinEnabled: false,
      autopinOnlyOneEnabled: false,
    })
    .then((v) => ({
      enabled: v.autopinEnabled === true,
      onlyOne: v.autopinOnlyOneEnabled === true,
      patterns: Array.isArray(v.autopinPatterns)
        ? v.autopinPatterns
        : DEFAULT_AUTOPIN_PATTERNS,
    }))
    .catch(() => ({
      enabled: false,
      onlyOne: false,
      patterns: DEFAULT_AUTOPIN_PATTERNS,
    }));
}

function normalizeAutopinPatterns(patterns) {
  if (!Array.isArray(patterns)) {
    return [];
  }

  return patterns
    .filter((pattern) => typeof pattern === "string")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function getAutopinQuickSlotPatterns(patterns) {
  return normalizeAutopinPatterns(patterns).slice(0, AUTOPIN_QUICK_SLOT_COUNT);
}

function getTabMatchUrl(tab) {
  return tab?.url || tab?.pendingUrl || "";
}

function patternToLaunchUrl(pattern) {
  const normalized = typeof pattern === "string" ? pattern.trim() : "";
  if (!normalized) {
    return "";
  }

  if (normalized.startsWith("*.")) {
    const wildcardBase = normalized.slice(2);
    if (!wildcardBase) {
      return "";
    }
    return `https://${wildcardBase}`;
  }

  if (normalized.includes("://")) {
    return normalized;
  }

  return `https://${normalized}`;
}

function tabMatchesAutoPinPattern(tab, pattern) {
  return urlMatchesPatterns(getTabMatchUrl(tab), [pattern]);
}

async function enforceAutoPinQuickSlotOrder(windowId, patterns) {
  if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  const quickPatterns = getAutopinQuickSlotPatterns(patterns);
  if (!quickPatterns.length) {
    return;
  }

  const usedTabIds = new Set();

  for (let slotIndex = 0; slotIndex < quickPatterns.length; slotIndex += 1) {
    const pattern = quickPatterns[slotIndex];
    const tabs = await chrome.tabs.query({ windowId });
    const candidate = tabs
      .filter((tab) => !isPromptTab(tab))
      .filter((tab) => !isExtensionInternalTab(tab))
      .find(
        (tab) =>
          Number.isInteger(tab.id) &&
          !usedTabIds.has(tab.id) &&
          tabMatchesAutoPinPattern(tab, pattern),
      );

    if (!candidate || !Number.isInteger(candidate.id)) {
      continue;
    }

    usedTabIds.add(candidate.id);

    if (!candidate.pinned) {
      await chrome.tabs.update(candidate.id, { pinned: true }).catch(() => {
        // Ignore if tab disappears during update.
      });
    }

    const latest = await getTabByIdSafe(candidate.id);
    if (!latest || latest.windowId !== windowId) {
      continue;
    }

    if (latest.index !== slotIndex) {
      await chrome.tabs.move(candidate.id, {
        windowId,
        index: slotIndex,
      }).catch(() => {
        // Ignore transient move failures.
      });
    }
  }
}

async function openAutoPinQuickSlotsInWindow(windowId) {
  if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) {
    return {
      ok: false,
      error: "No browser window is available.",
    };
  }

  const settings = await getAutoPinSettings();
  const quickPatterns = getAutopinQuickSlotPatterns(settings.patterns);

  if (!quickPatterns.length) {
    return {
      ok: false,
      error: "Add at least one auto-pin pattern first.",
    };
  }

  let openedCount = 0;
  let reusedCount = 0;
  let skippedCount = 0;
  const usedTabIds = new Set();

  for (let slotIndex = 0; slotIndex < quickPatterns.length; slotIndex += 1) {
    const pattern = quickPatterns[slotIndex];
    const tabs = await chrome.tabs.query({ windowId });
    const existing = tabs
      .filter((tab) => !isPromptTab(tab))
      .filter((tab) => !isExtensionInternalTab(tab))
      .find(
        (tab) =>
          Number.isInteger(tab.id) &&
          !usedTabIds.has(tab.id) &&
          tabMatchesAutoPinPattern(tab, pattern),
      );

    if (existing && Number.isInteger(existing.id)) {
      usedTabIds.add(existing.id);

      if (!existing.pinned) {
        await chrome.tabs.update(existing.id, { pinned: true }).catch(() => {
          // Ignore if tab disappears during update.
        });
      }

      const latest = await getTabByIdSafe(existing.id);
      if (latest && latest.windowId === windowId && latest.index !== slotIndex) {
        await chrome.tabs.move(existing.id, {
          windowId,
          index: slotIndex,
        }).catch(() => {
          // Ignore transient move failures.
        });
      }

      reusedCount += 1;
      continue;
    }

    const launchUrl = patternToLaunchUrl(pattern);
    if (!launchUrl) {
      skippedCount += 1;
      continue;
    }

    try {
      const created = await chrome.tabs.create({
        windowId,
        url: launchUrl,
        pinned: true,
        index: slotIndex,
        active: false,
      });
      if (Number.isInteger(created?.id)) {
        usedTabIds.add(created.id);
      }
      openedCount += 1;
    } catch {
      skippedCount += 1;
    }
  }

  await enforceAutoPinQuickSlotOrder(windowId, settings.patterns);

  return {
    ok: true,
    totalSlots: quickPatterns.length,
    openedCount,
    reusedCount,
    skippedCount,
  };
}

async function getLastFocusedWindowId() {
  try {
    const focused = await chrome.windows.getLastFocused({});
    if (focused && Number.isInteger(focused.id)) {
      return focused.id;
    }
  } catch {
    // Fall through.
  }

  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    const first = windows.find((window) => Number.isInteger(window.id));
    return first?.id ?? null;
  } catch {
    return null;
  }
}

async function enforceAutoPinQuickSlotsInAllWindows(patterns) {
  const quickPatterns = getAutopinQuickSlotPatterns(patterns);
  if (!quickPatterns.length) {
    return;
  }

  let windows = [];
  try {
    windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  } catch {
    return;
  }

  for (const window of windows) {
    if (!Number.isInteger(window?.id)) {
      continue;
    }
    await enforceAutoPinQuickSlotOrder(window.id, quickPatterns);
  }
}

async function enforceAutoPinQuickSlotsForWindowIfEnabled(windowId) {
  if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  const settings = await getAutoPinSettings();
  if (!settings.enabled || !settings.patterns.length) {
    return;
  }

  await enforceAutoPinQuickSlotOrder(windowId, settings.patterns);
}

function extractUrlParts(urlLike) {
  if (typeof urlLike !== "string" || !urlLike.trim()) {
    return { hostname: "", host: "" };
  }

  try {
    const parsed = new URL(urlLike);
    return {
      hostname: parsed.hostname.toLowerCase(),
      host: parsed.host.toLowerCase(),
    };
  } catch {
    try {
      const parsed = new URL(`http://${urlLike}`);
      return {
        hostname: parsed.hostname.toLowerCase(),
        host: parsed.host.toLowerCase(),
      };
    } catch {
      return { hostname: "", host: "" };
    }
  }
}

function domainPatternMatches(hostname, host, pattern) {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.includes(":")) {
    return Boolean(host) && host === normalized;
  }

  if (!hostname) {
    return false;
  }

  if (normalized.startsWith("*.")) {
    const baseDomain = normalized.slice(2);
    if (!baseDomain) {
      return false;
    }
    return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
  }

  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function urlMatchesPatterns(rawUrl, patterns) {
  const url = rawUrl.toLowerCase();
  const { hostname, host } = extractUrlParts(rawUrl);
  if (!url) return false;

  return patterns.some((pattern) => {
    if (typeof pattern !== "string") {
      return false;
    }

    const trimmed = pattern.trim();
    if (!trimmed) {
      return false;
    }

    if (trimmed.includes("://")) {
      return url.includes(trimmed.toLowerCase());
    }

    return domainPatternMatches(hostname, host, trimmed);
  });
}

function tabMatchesAutoClose(tab, patterns) {
  const rawUrl = tab.url || tab.pendingUrl || "";
  return urlMatchesPatterns(rawUrl, patterns);
}

function isPromptTab(tab) {
  return Boolean(
    tab?.url?.startsWith(chrome.runtime.getURL(PROMPT_POPUP_PATH)),
  );
}

function isExtensionInternalTab(tab) {
  return Boolean(
    tab?.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`),
  );
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
  const { tab: latest, requestedUrl: url } = await resolveLatestCreatedTab(tab);

  return {
    windowId: latest.windowId ?? tab.windowId,
    url: url || NEW_TAB_URL,
    openerTabId: latest.openerTabId ?? tab.openerTabId,
    index: Number.isInteger(latest.index) ? latest.index : tab.index,
    active: Boolean(latest.active ?? tab.active),
    title: latest.title || tab.title || "",
  };
}

async function resolveLatestCreatedTab(tab) {
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

  return { tab: latest, requestedUrl: url };
}

function notifyAutoPinConflictStateChanged() {
  chrome.runtime.sendMessage({ type: "autoPinConflictStateChanged" }).catch(() => {
    // Prompt may not be open.
  });
}

function conflictInvolvesTab(conflict, tabId) {
  if (!conflict || !Number.isInteger(tabId)) {
    return false;
  }
  if (conflict.newTabId === tabId || conflict.keepOldTabId === tabId) {
    return true;
  }
  return conflict.otherOldTabIds.includes(tabId);
}

function hasQueuedConflictForTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  return autoPinConflictQueue.some((entry) => conflictInvolvesTab(entry, tabId));
}

async function getTabByIdSafe(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function listAutoPinDuplicates(currentTabId, hostname) {
  if (!hostname || !Number.isInteger(currentTabId)) {
    return [];
  }

  const allTabs = await chrome.tabs.query({});
  return allTabs
    .filter((tab) => tab.id !== currentTabId)
    .filter((tab) => !isPromptTab(tab))
    .filter((tab) => !isExtensionInternalTab(tab))
    .map((tab) => ({
      id: tab.id,
      parts: extractUrlParts(tab.url || tab.pendingUrl || ""),
    }))
    .filter((tab) => tab.parts.hostname === hostname)
    .map((tab) => tab.id)
    .filter((id) => Number.isInteger(id))
    .sort((a, b) => a - b);
}

async function ensureAutoPinPromptOpen() {
  if (!autoPinConflictQueue.length) {
    return;
  }

  await syncActionUi(AUTOPIN_PROMPT_POPUP_PATH);

  try {
    if (typeof chrome.action.openPopup === "function") {
      const windowId = autoPinConflictQueue[0]?.windowId;
      if (typeof windowId === "number") {
        await chrome.action.openPopup({ windowId });
      } else {
        await chrome.action.openPopup();
      }
      notifyAutoPinConflictStateChanged();
      return;
    }
  } catch {
    // Fall through to window fallback.
  }

  if (autoPinPromptWindowId !== null) {
    try {
      await chrome.windows.update(autoPinPromptWindowId, { focused: true });
      notifyAutoPinConflictStateChanged();
      return;
    } catch {
      autoPinPromptWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(AUTOPIN_PROMPT_POPUP_PATH),
    type: "popup",
    width: 420,
    height: 320,
    focused: true,
  });

  autoPinPromptWindowId = win.id ?? null;
  notifyAutoPinConflictStateChanged();
}

async function closeAutoPinPromptIfIdle() {
  if (autoPinConflictQueue.length || autoPinPromptWindowId === null) {
    return;
  }

  try {
    await chrome.windows.remove(autoPinPromptWindowId);
  } catch {
    // Already closed.
  }

  autoPinPromptWindowId = null;
  await syncActionUi();
}

async function normalizeAutoPinConflicts() {
  let changed = false;

  for (let i = autoPinConflictQueue.length - 1; i >= 0; i -= 1) {
    const entry = autoPinConflictQueue[i];
    const [newTab, keepOldTab] = await Promise.all([
      getTabByIdSafe(entry.newTabId),
      getTabByIdSafe(entry.keepOldTabId),
    ]);

    if (!newTab || !keepOldTab) {
      autoPinConflictQueue.splice(i, 1);
      changed = true;
      continue;
    }

    const stillOpenOldIds = (
      await Promise.all(entry.otherOldTabIds.map((tabId) => getTabByIdSafe(tabId)))
    )
      .filter(Boolean)
      .map((tab) => tab.id)
      .filter((id) => Number.isInteger(id));

    if (stillOpenOldIds.length !== entry.otherOldTabIds.length) {
      entry.otherOldTabIds = stillOpenOldIds;
      changed = true;
    }
  }

  if (changed) {
    await syncActionUi();
    await closeAutoPinPromptIfIdle();
    notifyAutoPinConflictStateChanged();
  }
}

async function queueAutoPinConflict(currentTabId, hostname, duplicateIds) {
  if (!Number.isInteger(currentTabId) || !hostname || !duplicateIds.length) {
    return;
  }

  if (hasQueuedConflictForTab(currentTabId)) {
    return;
  }

  const keepOldTabId = duplicateIds[0];
  if (hasQueuedConflictForTab(keepOldTabId)) {
    return;
  }

  autoPinConflictQueue.push({
    hostname,
    newTabId: currentTabId,
    keepOldTabId,
    otherOldTabIds: duplicateIds.slice(1),
    windowId: null,
  });

  const newTab = await getTabByIdSafe(currentTabId);
  if (newTab && Number.isInteger(newTab.windowId)) {
    autoPinConflictQueue[autoPinConflictQueue.length - 1].windowId =
      newTab.windowId;
  }

  await ensureAutoPinPromptOpen();
}

async function applyAutoPinPolicyForTab(tab, explicitUrl) {
  if (!tab || tab.windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  if (isPromptTab(tab) || isExtensionInternalTab(tab)) {
    return;
  }

  if (!Number.isInteger(tab.id)) {
    return;
  }

  const settings = await getAutoPinSettings();
  if (!settings.enabled || !settings.patterns.length) {
    return;
  }

  const requestedUrl = explicitUrl || extractRequestedUrl(tab);
  if (!requestedUrl || !urlMatchesPatterns(requestedUrl, settings.patterns)) {
    return;
  }

  try {
    await chrome.tabs.update(tab.id, { pinned: true });
  } catch {
    return;
  }

  await enforceAutoPinQuickSlotOrder(tab.windowId, settings.patterns);

  if (!settings.onlyOne) {
    return;
  }

  const { hostname } = extractUrlParts(requestedUrl);
  const duplicateIds = await listAutoPinDuplicates(tab.id, hostname);
  if (!duplicateIds.length) {
    return;
  }

  await queueAutoPinConflict(tab.id, hostname, duplicateIds);
}

async function applyAutoPinPolicyOnCreated(tab) {
  const resolved = await resolveLatestCreatedTab(tab);
  await applyAutoPinPolicyForTab(resolved.tab, resolved.requestedUrl);
}

async function syncActionUi(forcedPopupPath = "") {
  const hasPending = pendingQueue.length > 0;
  const hasAutoPinConflict = autoPinConflictQueue.length > 0;
  const popup =
    forcedPopupPath ||
    (hasPending
      ? PROMPT_POPUP_PATH
      : hasAutoPinConflict
        ? AUTOPIN_PROMPT_POPUP_PATH
        : SETTINGS_POPUP_PATH);

  try {
    await chrome.action.setPopup({ popup });
  } catch {
    // Ignore UI sync failures.
  }

  try {
    const badgeCount = hasPending ? pendingQueue.length : autoPinConflictQueue.length;
    await chrome.action.setBadgeText({
      text: badgeCount ? String(Math.min(badgeCount, 99)) : "",
    });
    if (badgeCount) {
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

  await syncActionUi(PROMPT_POPUP_PATH);

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

async function tryAutoCloseTab(windowId, excludeTabId) {
  const { enabled, patterns } = await getAutoClosePatterns();
  if (!enabled || !patterns.length) return false;

  const unpinnedTabs = await listUnpinnedTabs(windowId);
  for (const candidate of unpinnedTabs) {
    if (candidate.id === excludeTabId) continue;
    if (tabMatchesAutoClose(candidate, patterns)) {
      try {
        await chrome.tabs.remove(candidate.id);
        return true;
      } catch {
        // Tab may already be gone, continue checking.
      }
    }
  }
  return false;
}

async function enforceLimitOnCreatedTab(tab) {
  if (!tab || tab.windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }

  if (isPromptTab(tab) || isExtensionInternalTab(tab)) {
    return;
  }

  await applyAutoPinPolicyOnCreated(tab);

  let latest = tab;
  try {
    if (Number.isInteger(tab.id)) {
      latest = await chrome.tabs.get(tab.id);
    }
  } catch {
    return;
  }

  if (latest.pinned) {
    return;
  }

  const limit = await getLimit();
  const unpinnedTabs = await listUnpinnedTabs(latest.windowId);

  if (unpinnedTabs.length <= limit) {
    return;
  }

  // Try to auto-close a matching tab before prompting the user.
  const autoClosed = await tryAutoCloseTab(latest.windowId, latest.id);
  if (autoClosed) {
    return;
  }

  const pendingEntry = await buildPendingEntry(latest);
  pendingQueue.push(pendingEntry);

  try {
    await chrome.tabs.remove(latest.id);
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

async function getAutoPinConflictState() {
  await normalizeAutoPinConflicts();
  const current = autoPinConflictQueue[0] || null;

  if (!current) {
    await closeAutoPinPromptIfIdle();
    await syncActionUi();
    return {
      pendingCount: 0,
      hostname: "",
      oldTab: null,
      newTab: null,
    };
  }

  const [oldTab, newTab] = await Promise.all([
    getTabByIdSafe(current.keepOldTabId),
    getTabByIdSafe(current.newTabId),
  ]);

  if (!oldTab || !newTab) {
    autoPinConflictQueue.shift();
    notifyAutoPinConflictStateChanged();
    return getAutoPinConflictState();
  }

  return {
    pendingCount: autoPinConflictQueue.length,
    hostname: current.hostname,
    oldTab: {
      id: oldTab.id,
      title: oldTab.title || "",
      url: oldTab.url || oldTab.pendingUrl || "",
      pinned: Boolean(oldTab.pinned),
    },
    newTab: {
      id: newTab.id,
      title: newTab.title || "",
      url: newTab.url || newTab.pendingUrl || "",
      pinned: Boolean(newTab.pinned),
    },
  };
}

async function closeTabsByIds(tabIds) {
  if (!Array.isArray(tabIds) || !tabIds.length) {
    return;
  }

  await Promise.all(
    tabIds
      .filter((tabId) => Number.isInteger(tabId))
      .map((tabId) =>
        chrome.tabs.remove(tabId).catch(() => {
          // Tab may already be gone.
        }),
      ),
  );
}

async function keepOldAutoPinConflict() {
  const current = autoPinConflictQueue.shift();
  if (!current) {
    await closeAutoPinPromptIfIdle();
    return false;
  }

  await closeTabsByIds([current.newTabId, ...current.otherOldTabIds]);
  const keepOldTab = await getTabByIdSafe(current.keepOldTabId);
  if (keepOldTab && !keepOldTab.pinned) {
    await chrome.tabs.update(keepOldTab.id, { pinned: true }).catch(() => {
      // Ignore if update fails.
    });
  }
  if (keepOldTab && Number.isInteger(keepOldTab.windowId)) {
    const settings = await getAutoPinSettings();
    await enforceAutoPinQuickSlotOrder(keepOldTab.windowId, settings.patterns);
  }

  await ensureAutoPinPromptOpen();
  await closeAutoPinPromptIfIdle();
  await syncActionUi();
  notifyAutoPinConflictStateChanged();
  return true;
}

async function keepNewAutoPinConflict() {
  const current = autoPinConflictQueue.shift();
  if (!current) {
    await closeAutoPinPromptIfIdle();
    return false;
  }

  await closeTabsByIds([current.keepOldTabId, ...current.otherOldTabIds]);
  const keepNewTab = await getTabByIdSafe(current.newTabId);
  if (keepNewTab && !keepNewTab.pinned) {
    await chrome.tabs.update(keepNewTab.id, { pinned: true }).catch(() => {
      // Ignore if update fails.
    });
  }
  if (keepNewTab && Number.isInteger(keepNewTab.windowId)) {
    const settings = await getAutoPinSettings();
    await enforceAutoPinQuickSlotOrder(keepNewTab.windowId, settings.patterns);
  }

  await ensureAutoPinPromptOpen();
  await closeAutoPinPromptIfIdle();
  await syncActionUi();
  notifyAutoPinConflictStateChanged();
  return true;
}

chrome.tabs.onCreated.addListener((tab) => {
  enforceLimitOnCreatedTab(tab).catch(() => {
    // Keep listener resilient.
  });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!changeInfo || typeof changeInfo.url !== "string" || !changeInfo.url) {
    return;
  }

  if (!tab || !Number.isInteger(tab.id)) {
    return;
  }

  applyAutoPinPolicyForTab(tab, changeInfo.url).catch(() => {
    // Keep listener resilient.
  });
});

chrome.tabs.onMoved.addListener((_tabId, moveInfo) => {
  if (!Number.isInteger(moveInfo?.windowId)) {
    return;
  }

  enforceAutoPinQuickSlotsForWindowIfEnabled(moveInfo.windowId).catch(() => {
    // Keep listener resilient.
  });
});

chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  if (!removeInfo || removeInfo.isWindowClosing) {
    return;
  }

  if (!Number.isInteger(removeInfo.windowId)) {
    return;
  }

  enforceAutoPinQuickSlotsForWindowIfEnabled(removeInfo.windowId).catch(() => {
    // Keep listener resilient.
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === promptWindowId) {
    promptWindowId = null;
    notifyPromptStateChanged();
  }

  if (windowId === autoPinPromptWindowId) {
    autoPinPromptWindowId = null;
    syncActionUi().catch(() => {
      // Ignore.
    });
    notifyAutoPinConflictStateChanged();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  syncActionUi().catch(() => {
    // Ignore.
  });
});

chrome.runtime.onStartup.addListener(() => {
  Promise.all([
    syncActionUi(),
    getAutoPinSettings().then((settings) =>
      settings.enabled && settings.patterns.length
        ? enforceAutoPinQuickSlotsInAllWindows(settings.patterns)
        : Promise.resolve(),
    ),
  ]).catch(() => {
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

  if (message.type === "getAutoPinConflictState") {
    getAutoPinConflictState().then(sendResponse);
    return true;
  }

  if (message.type === "keepAutoPinOld") {
    keepOldAutoPinConflict()
      .then(() => getAutoPinConflictState())
      .then(sendResponse);
    return true;
  }

  if (message.type === "keepAutoPinNew") {
    keepNewAutoPinConflict()
      .then(() => getAutoPinConflictState())
      .then(sendResponse);
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

  if (message.type === "getAutoClosePatterns") {
    getAutoClosePatterns().then(sendResponse);
    return true;
  }

  if (message.type === "saveAutoClosePatterns") {
    const patterns = Array.isArray(message.patterns) ? message.patterns : [];
    const enabled = message.enabled !== false;
    chrome.storage.local
      .set({ autoClosePatterns: patterns, autoCloseEnabled: enabled })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "resetAutoClosePatterns") {
    chrome.storage.local
      .set({
        autoClosePatterns: DEFAULT_AUTO_CLOSE_PATTERNS,
        autoCloseEnabled: true,
      })
      .then(() =>
        sendResponse({ ok: true, patterns: DEFAULT_AUTO_CLOSE_PATTERNS }),
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "getAutoPinSettings") {
    getAutoPinSettings().then(sendResponse);
    return true;
  }

  if (message.type === "saveAutoPinSettings") {
    const patterns = Array.isArray(message.patterns) ? message.patterns : [];
    const enabled = message.enabled === true;
    const onlyOne = message.onlyOne === true;
    chrome.storage.local
      .set({
        autopinPatterns: patterns,
        autopinEnabled: enabled,
        autopinOnlyOneEnabled: onlyOne,
      })
      .then(async () => {
        if (enabled && patterns.length) {
          await enforceAutoPinQuickSlotsInAllWindows(patterns);
        }
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "resetAutoPinSettings") {
    chrome.storage.local
      .set({
        autopinPatterns: DEFAULT_AUTOPIN_PATTERNS,
        autopinEnabled: false,
        autopinOnlyOneEnabled: false,
      })
      .then(() =>
        sendResponse({ ok: true, patterns: DEFAULT_AUTOPIN_PATTERNS }),
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === "openAutoPinQuickSlots") {
    getLastFocusedWindowId()
      .then((windowId) => {
        if (!Number.isInteger(windowId)) {
          return {
            ok: false,
            error: "No browser window is available.",
          };
        }
        return openAutoPinQuickSlotsInWindow(windowId);
      })
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: "Could not open tabs." }));
    return true;
  }
});

syncActionUi().catch(() => {
  // Ignore.
});
