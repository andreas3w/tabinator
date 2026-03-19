const limitInput = document.getElementById("limit");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

const autoCloseToggle = document.getElementById("auto-close-toggle");
const patternListEl = document.getElementById("pattern-list");
const newPatternInput = document.getElementById("new-pattern");
const addPatternBtn = document.getElementById("add-pattern");
const resetPatternsBtn = document.getElementById("reset-patterns");
const autopinToggle = document.getElementById("autopin-toggle");
const autopinOnlyOneToggle = document.getElementById("autopin-only-one-toggle");
const autopinPatternListEl = document.getElementById("autopin-pattern-list");
const newAutopinPatternInput = document.getElementById("new-autopin-pattern");
const addAutopinPatternBtn = document.getElementById("add-autopin-pattern");
const resetAutopinPatternsBtn = document.getElementById("reset-autopin-patterns");
const openAutopinQuickBtn = document.getElementById("open-autopin-quick");
const autopinStatusEl = document.getElementById("autopin-status");

const DEFAULT_LIMIT = 5;
const AUTOPIN_QUICK_SLOT_COUNT = 5;

let currentPatterns = [];
let currentAutopinPatterns = [];

async function loadLimit() {
  const data = await chrome.storage.local.get({ unpinnedLimit: DEFAULT_LIMIT });
  limitInput.value = String(data.unpinnedLimit);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#a62222" : "#4f5d75";
}

function setAutopinStatus(message, isError = false) {
  if (!autopinStatusEl) {
    return;
  }
  autopinStatusEl.textContent = message;
  autopinStatusEl.style.color = isError ? "#f08989" : "#b3bccd";
}

async function saveLimit() {
  const parsed = Number.parseInt(limitInput.value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    setStatus("Enter a whole number between 1 and 100.", true);
    return;
  }

  await chrome.storage.local.set({ unpinnedLimit: parsed });
  setStatus("Saved.");
  chrome.runtime.sendMessage({ type: "limitUpdated" });
}

// --- Auto-close patterns ---

function renderPatterns() {
  patternListEl.innerHTML = "";
  if (!currentPatterns.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:12px;color:#b3bccd;padding:4px 0";
    empty.textContent = "No patterns configured.";
    patternListEl.appendChild(empty);
    return;
  }
  currentPatterns.forEach((pattern, index) => {
    const item = document.createElement("div");
    item.className = "pattern-item";

    const label = document.createElement("span");
    label.textContent = pattern;

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.textContent = "✕";
    btn.title = "Remove pattern";
    btn.addEventListener("click", () => removePattern(index));

    item.appendChild(label);
    item.appendChild(btn);
    patternListEl.appendChild(item);
  });
}

function renderAutopinPatterns() {
  autopinPatternListEl.innerHTML = "";
  if (!currentAutopinPatterns.length) {
    const empty = document.createElement("div");
    empty.style.cssText = "font-size:12px;color:#b3bccd;padding:4px 0";
    empty.textContent = "No patterns configured.";
    autopinPatternListEl.appendChild(empty);
    return;
  }
  currentAutopinPatterns.forEach((pattern, index) => {
    const item = document.createElement("div");
    item.className = "pattern-item";

    const label = document.createElement("span");
    const slotPrefix =
      index < AUTOPIN_QUICK_SLOT_COUNT ? `#${index + 1} ` : "";
    label.textContent = `${slotPrefix}${pattern}`;

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.textContent = "✕";
    btn.title = "Remove pattern";
    btn.addEventListener("click", () => removeAutopinPattern(index));

    item.appendChild(label);
    item.appendChild(btn);
    autopinPatternListEl.appendChild(item);
  });
}

function savePatterns() {
  chrome.runtime.sendMessage({
    type: "saveAutoClosePatterns",
    patterns: currentPatterns,
    enabled: autoCloseToggle.checked,
  });
}

function removePattern(index) {
  currentPatterns.splice(index, 1);
  renderPatterns();
  savePatterns();
}

function addPattern() {
  const raw = newPatternInput.value.trim();
  if (!raw) return;
  if (currentPatterns.includes(raw)) {
    newPatternInput.value = "";
    return;
  }
  currentPatterns.push(raw);
  newPatternInput.value = "";
  renderPatterns();
  savePatterns();
}

function saveAutopinSettings() {
  chrome.runtime.sendMessage({
    type: "saveAutoPinSettings",
    patterns: currentAutopinPatterns,
    enabled: autopinToggle.checked,
    onlyOne: autopinOnlyOneToggle.checked,
  });
}

function removeAutopinPattern(index) {
  currentAutopinPatterns.splice(index, 1);
  renderAutopinPatterns();
  saveAutopinSettings();
}

function addAutopinPattern() {
  const raw = newAutopinPatternInput.value.trim();
  if (!raw) return;
  if (currentAutopinPatterns.includes(raw)) {
    newAutopinPatternInput.value = "";
    return;
  }
  currentAutopinPatterns.push(raw);
  newAutopinPatternInput.value = "";
  renderAutopinPatterns();
  saveAutopinSettings();
  setAutopinStatus("");
}

function openAutopinQuickSlots() {
  if (!openAutopinQuickBtn) {
    return;
  }

  openAutopinQuickBtn.disabled = true;
  setAutopinStatus("Opening quick-slot tabs...");

  chrome.runtime.sendMessage({ type: "openAutoPinQuickSlots" }, (result) => {
    openAutopinQuickBtn.disabled = false;

    if (chrome.runtime.lastError) {
      setAutopinStatus("Could not open quick-slot tabs.", true);
      return;
    }

    if (!result?.ok) {
      setAutopinStatus(result?.error || "Could not open quick-slot tabs.", true);
      return;
    }

    const opened = result.openedCount ?? 0;
    const reused = result.reusedCount ?? 0;
    const skipped = result.skippedCount ?? 0;
    const parts = [`opened ${opened}`, `reused ${reused}`];
    if (skipped) {
      parts.push(`skipped ${skipped}`);
    }
    setAutopinStatus(`Quick slots ready: ${parts.join(", ")}.`);
  });
}

async function loadAutoCloseSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getAutoClosePatterns" }, (result) => {
      if (chrome.runtime.lastError) {
        resolve();
        return;
      }
      autoCloseToggle.checked = result?.enabled !== false;
      currentPatterns = Array.isArray(result?.patterns)
        ? [...result.patterns]
        : [];
      renderPatterns();
      resolve();
    });
  });
}

async function loadAutopinSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getAutoPinSettings" }, (result) => {
      if (chrome.runtime.lastError) {
        resolve();
        return;
      }
      autopinToggle.checked = result?.enabled === true;
      autopinOnlyOneToggle.checked = result?.onlyOne === true;
      currentAutopinPatterns = Array.isArray(result?.patterns)
        ? [...result.patterns]
        : [];
      renderAutopinPatterns();
      resolve();
    });
  });
}

addPatternBtn.addEventListener("click", addPattern);
newPatternInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addPattern();
});

autoCloseToggle.addEventListener("change", savePatterns);

addAutopinPatternBtn.addEventListener("click", addAutopinPattern);
newAutopinPatternInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addAutopinPattern();
});

autopinToggle.addEventListener("change", saveAutopinSettings);
autopinOnlyOneToggle.addEventListener("change", saveAutopinSettings);

resetPatternsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "resetAutoClosePatterns" }, (result) => {
    if (result?.ok && Array.isArray(result.patterns)) {
      currentPatterns = [...result.patterns];
      autoCloseToggle.checked = true;
      renderPatterns();
    }
  });
});

resetAutopinPatternsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "resetAutoPinSettings" }, (result) => {
    if (result?.ok && Array.isArray(result.patterns)) {
      currentAutopinPatterns = [...result.patterns];
      autopinToggle.checked = false;
      autopinOnlyOneToggle.checked = false;
      renderAutopinPatterns();
      setAutopinStatus("");
    }
  });
});

if (openAutopinQuickBtn) {
  openAutopinQuickBtn.addEventListener("click", openAutopinQuickSlots);
}

saveBtn.addEventListener("click", saveLimit);
limitInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveLimit();
  }
});

Promise.all([loadLimit(), loadAutoCloseSettings(), loadAutopinSettings()]).catch(
  () => setStatus("Could not load settings.", true),
);
