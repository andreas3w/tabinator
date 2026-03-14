const limitInput = document.getElementById("limit");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

const autoCloseToggle = document.getElementById("auto-close-toggle");
const patternListEl = document.getElementById("pattern-list");
const newPatternInput = document.getElementById("new-pattern");
const addPatternBtn = document.getElementById("add-pattern");
const resetPatternsBtn = document.getElementById("reset-patterns");

const DEFAULT_LIMIT = 5;

let currentPatterns = [];

async function loadLimit() {
  const data = await chrome.storage.local.get({ unpinnedLimit: DEFAULT_LIMIT });
  limitInput.value = String(data.unpinnedLimit);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#a62222" : "#4f5d75";
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

addPatternBtn.addEventListener("click", addPattern);
newPatternInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addPattern();
});

autoCloseToggle.addEventListener("change", savePatterns);

resetPatternsBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "resetAutoClosePatterns" }, (result) => {
    if (result?.ok && Array.isArray(result.patterns)) {
      currentPatterns = [...result.patterns];
      autoCloseToggle.checked = true;
      renderPatterns();
    }
  });
});

saveBtn.addEventListener("click", saveLimit);
limitInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveLimit();
  }
});

Promise.all([loadLimit(), loadAutoCloseSettings()]).catch(() =>
  setStatus("Could not load settings.", true),
);
