const pendingInfoEl = document.getElementById("pending-info");
const tabListEl = document.getElementById("tab-list");
const closeOldestBtn = document.getElementById("close-oldest");
const dontOpenBtn = document.getElementById("dont-open");

let pollHandle = null;
let hasAutoFocusedCloseOldest = false;

function truncateLabel(title, url) {
  if (title && title.trim()) return title;
  if (url && url.trim()) return url;
  return "Untitled tab";
}

function renderState(state) {
  const pendingCount = state?.pendingCount ?? 0;
  if (!pendingCount) {
    pendingInfoEl.textContent = "No pending tabs in queue.";
  } else {
    const active = state.nextPendingTitle || state.nextPendingUrl || "(new tab)";
    pendingInfoEl.textContent = `Pending: ${active} | Queue: ${pendingCount}`;
  }

  tabListEl.innerHTML = "";
  const tabs = state?.tabs ?? [];

  if (!tabs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No unpinned tabs available.";
    tabListEl.appendChild(empty);
    closeOldestBtn.disabled = true;
    return;
  }

  closeOldestBtn.disabled = false;

  tabs.forEach((tab, index) => {
    const item = document.createElement("div");
    item.className = "tab-item";

    const label = document.createElement("div");
    label.className = "tab-label";
    const marker = index === 0 ? "Oldest" : `#${index + 1}`;
    label.innerHTML = `<small>${marker}</small>${escapeHtml(truncateLabel(tab.title, tab.url))}`;

    const closeButton = document.createElement("button");
    closeButton.className = "close-one";
    closeButton.textContent = "X";
    closeButton.title = "Close this tab";
    closeButton.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "closeSpecific", tabId: tab.id }, handleActionResult);
    });

    item.appendChild(label);
    item.appendChild(closeButton);
    tabListEl.appendChild(item);
  });

  if (!hasAutoFocusedCloseOldest) {
    closeOldestBtn.focus({ preventScroll: true });
    hasAutoFocusedCloseOldest = true;
  }
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function refresh() {
  chrome.runtime.sendMessage({ type: "getPromptState" }, (state) => {
    if (chrome.runtime.lastError) {
      return;
    }
    renderState(state || {});
  });
}

function handleActionResult(state) {
  if (chrome.runtime.lastError) {
    return;
  }

  const pendingCount = state?.pendingCount ?? 0;
  if (!pendingCount) {
    window.close();
    return;
  }

  renderState(state || {});
}

closeOldestBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "closeOldest" }, handleActionResult);
});

dontOpenBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "dontOpen" }, handleActionResult);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "promptStateChanged") {
    refresh();
  }
});

refresh();
pollHandle = setInterval(refresh, 1000);

window.addEventListener("beforeunload", () => {
  if (pollHandle) {
    clearInterval(pollHandle);
  }
});
