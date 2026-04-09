const apiInput = document.getElementById("api-key-input");
const saveBtn = document.getElementById("save-btn");
const clearBtn = document.getElementById("clear-btn");
const statusEl = document.getElementById("status");

init();

async function init() {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (geminiApiKey) {
    apiInput.value = geminiApiKey;
    statusEl.textContent = "Saved";
  }
}

saveBtn.addEventListener("click", async () => {
  const key = apiInput.value.trim();
  if (!key) {
    statusEl.textContent = "Enter a valid key";
    return;
  }

  await chrome.storage.local.set({ geminiApiKey: key });
  statusEl.textContent = "Saved";
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("geminiApiKey");
  apiInput.value = "";
  statusEl.textContent = "Cleared";
});
