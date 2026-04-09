let isCapturing = false;
let transcriptLines = [];
let pendingLine = "";

injectSidebar();

function injectSidebar() {
  if (document.getElementById("meet-ai-sidebar")) {
    return;
  }

  const sidebar = document.createElement("aside");
  sidebar.id = "meet-ai-sidebar";
  sidebar.innerHTML = `
    <div class="mas-header">
      <span class="mas-title">AI Assistant</span>
      <button id="mas-toggle" type="button">Start</button>
    </div>
    <div id="mas-status" class="mas-status">Idle</div>
    <section class="mas-section">
      <div class="mas-label">Live Transcript</div>
      <div id="mas-transcript" class="mas-transcript"></div>
    </section>
    <section class="mas-section">
      <div class="mas-label">Suggestions</div>
      <div id="mas-suggestions" class="mas-suggestions"></div>
    </section>
  `;
  document.body.appendChild(sidebar);

  const toggleBtn = document.getElementById("mas-toggle");
  toggleBtn?.addEventListener("click", onToggleCapture);
}

function onToggleCapture() {
  if (!isCapturing) {
    chrome.runtime.sendMessage({ type: "START_CAPTURE" });
    isCapturing = true;
    setStatus("Starting...");
    setToggleLabel("Stop");
    return;
  }

  chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
  isCapturing = false;
  pendingLine = "";
  setStatus("Stopped");
  setToggleLabel("Start");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSCRIPT_UPDATE") {
    renderTranscript(msg.text || "", Boolean(msg.isFinal));
  } else if (msg.type === "SUGGESTION_UPDATE") {
    renderSuggestions(Array.isArray(msg.suggestions) ? msg.suggestions : []);
  } else if (msg.type === "CAPTURE_STATE") {
    handleCaptureState(msg.state);
  } else if (msg.type === "ASSISTANT_ERROR") {
    setStatus(msg.error || "Unexpected error");
    isCapturing = false;
    setToggleLabel("Start");
  }
});

function handleCaptureState(state) {
  if (state === "CONNECTING") {
    setStatus("Connecting audio...");
    return;
  }
  if (state === "LIVE_CONNECTED") {
    setStatus("Connected. Initializing transcription...");
    return;
  }
  if (state === "READY") {
    setStatus("Listening");
    return;
  }
  if (state === "RECONNECTING") {
    setStatus("Reconnecting...");
    return;
  }
  if (state === "STOPPED") {
    setStatus("Stopped");
    return;
  }
}

function renderTranscript(text, isFinal) {
  const transcriptEl = document.getElementById("mas-transcript");
  if (!transcriptEl) {
    return;
  }

  if (!isFinal) {
    pendingLine = text;
  } else if (text.trim()) {
    transcriptLines.push(text.trim());
    pendingLine = "";
    if (transcriptLines.length > 120) {
      transcriptLines = transcriptLines.slice(-120);
    }
  }

  transcriptEl.innerHTML = "";
  transcriptLines.forEach((line) => {
    const div = document.createElement("div");
    div.className = "mas-line";
    div.textContent = line;
    transcriptEl.appendChild(div);
  });

  if (pendingLine) {
    const pending = document.createElement("div");
    pending.className = "mas-line mas-pending";
    pending.textContent = pendingLine;
    transcriptEl.appendChild(pending);
  }

  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  if (isCapturing) {
    setStatus("Listening");
  }
}

function renderSuggestions(suggestions) {
  const container = document.getElementById("mas-suggestions");
  if (!container) {
    return;
  }

  container.innerHTML = "";
  if (suggestions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mas-empty";
    empty.textContent = "No suggestions yet";
    container.appendChild(empty);
    return;
  }

  suggestions.forEach((text) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mas-chip";
    chip.textContent = text;
    chip.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        chip.classList.add("mas-copied");
        setTimeout(() => chip.classList.remove("mas-copied"), 1000);
      } catch (_) {
        setStatus("Clipboard blocked in this context.");
      }
    });
    container.appendChild(chip);
  });
}

function setStatus(text) {
  const statusEl = document.getElementById("mas-status");
  if (statusEl) {
    statusEl.textContent = text;
  }
}

function setToggleLabel(text) {
  const toggleBtn = document.getElementById("mas-toggle");
  if (toggleBtn) {
    toggleBtn.textContent = text;
  }
}
