const limitInput = document.getElementById("limit");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

const DEFAULT_LIMIT = 5;

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

saveBtn.addEventListener("click", saveLimit);
limitInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    saveLimit();
  }
});

loadLimit().catch(() => setStatus("Could not load settings.", true));
