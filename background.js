const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture and process Google Meet tab audio for Gemini transcription."
  });
}

async function startCapture(tabId) {
  await ensureOffscreenDocument();

  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  if (!geminiApiKey) {
    chrome.tabs.sendMessage(tabId, {
      type: "ASSISTANT_ERROR",
      error: "Gemini API key missing. Click extension icon and save key first."
    }).catch(() => {});
    return;
  }

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    target: "offscreen",
    tabId,
    streamId,
    apiKey: geminiApiKey
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "START_CAPTURE") {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      return;
    }

    startCapture(tabId).catch((error) => {
      chrome.tabs.sendMessage(tabId, {
        type: "ASSISTANT_ERROR",
        error: error?.message || "Failed to start audio capture."
      }).catch(() => {});
    });
    return;
  }

  if (msg.type === "STOP_CAPTURE") {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE", target: "offscreen" }).catch(() => {});
    return;
  }

  if (
    msg.type === "TRANSCRIPT_UPDATE" ||
    msg.type === "SUGGESTION_UPDATE" ||
    msg.type === "ASSISTANT_ERROR" ||
    msg.type === "CAPTURE_STATE"
  ) {
    const targetTabId = msg.tabId || sender?.tab?.id;
    if (!targetTabId) {
      return;
    }
    chrome.tabs.sendMessage(targetTabId, msg).catch(() => {});
  }
});
