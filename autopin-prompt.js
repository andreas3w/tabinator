const hostEl = document.getElementById("host");
const oldTitleEl = document.getElementById("old-title");
const oldUrlEl = document.getElementById("old-url");
const newTitleEl = document.getElementById("new-title");
const newUrlEl = document.getElementById("new-url");
const keepOldBtn = document.getElementById("keep-old");
const keepNewBtn = document.getElementById("keep-new");

let pollHandle = null;

function displayLabel(tab) {
  if (!tab) {
    return "";
  }
  if (tab.title && tab.title.trim()) {
    return tab.title;
  }
  if (tab.url && tab.url.trim()) {
    return tab.url;
  }
  return "Untitled tab";
}

function renderState(state) {
  const pendingCount = state?.pendingCount ?? 0;
  if (!pendingCount || !state.oldTab || !state.newTab) {
    window.close();
    return;
  }

  const suffix = pendingCount > 1 ? ` (${pendingCount} queued)` : "";
  hostEl.textContent = `Host: ${state.hostname || "-"}${suffix}`;

  oldTitleEl.textContent = displayLabel(state.oldTab);
  oldUrlEl.textContent = state.oldTab.url || "";

  newTitleEl.textContent = displayLabel(state.newTab);
  newUrlEl.textContent = state.newTab.url || "";
}

function refresh() {
  chrome.runtime.sendMessage({ type: "getAutoPinConflictState" }, (state) => {
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
  renderState(state || {});
}

keepOldBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "keepAutoPinOld" }, handleActionResult);
});

keepNewBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "keepAutoPinNew" }, handleActionResult);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "autoPinConflictStateChanged") {
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
