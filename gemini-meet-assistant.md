# Gemini-Powered Google Meet Assistant — Chrome Extension Build Guide

> **First-principles approach:** Real-time transcription via Gemini Live API + contextual chat suggestions via Gemini Flash, all injected inside the Google Meet tab itself.

---

## 1. First-Principles Problem Decomposition

Before writing a single line of code, reason from the atoms up:

| Question | Answer |
|----------|--------|
| **What is the raw input?** | Audio bytes — tab audio (remote speakers) + microphone (you) |
| **What is the raw output?** | Text on screen inside Meet — live transcript + AI chat suggestions |
| **What transforms input → output?** | Two parallel Gemini models, each with a distinct job |
| **Where does processing live?** | In-browser. No external server needed (except Gemini API). |
| **What Chrome primitive captures tab audio?** | `chrome.tabCapture` — the only no-picker API for extensions |
| **Why can't a content script do this alone?** | Service workers can sleep and have no DOM; media streams need a persistent document |

The architecture resolves into **four isolated execution contexts**, each with exactly one job.

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  GOOGLE MEET TAB                                                 │
│                                                                  │
│  ┌─────────────────────────────────────┐                         │
│  │  Content Script (content.js)        │  ← Injected by extension│
│  │  • Renders floating sidebar UI      │                         │
│  │  • Shows live transcript            │                         │
│  │  • Shows chat suggestions           │                         │
│  │  • Sends "start" message on click   │                         │
│  └────────────────┬────────────────────┘                         │
└───────────────────┼──────────────────────────────────────────────┘
                    │ chrome.runtime.sendMessage / onMessage
┌───────────────────┼──────────────────────────────────────────────┐
│  SERVICE WORKER (background.js)                                  │
│  • Receives "start" → calls chrome.tabCapture.getMediaStreamId() │
│  • Creates offscreen document (if not already open)              │
│  • Forwards streamId to offscreen document                       │
│  • Routes messages between offscreen ↔ content script           │
└───────────────────┬──────────────────────────────────────────────┘
                    │ chrome.runtime.sendMessage
┌───────────────────┼──────────────────────────────────────────────┐
│  OFFSCREEN DOCUMENT (offscreen.html)  ← Hidden, persistent DOM  │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  AudioPipeline                                           │    │
│  │  1. getUserMedia({ chromeMediaSource: "tab", id })       │    │
│  │  2. AudioContext → AudioWorklet (pcm-processor.js)       │    │
│  │     • Downsamples Float32@48kHz → Int16 PCM@16kHz        │    │
│  │  3. Re-routes audio to AudioContext.destination          │    │
│  │     (so Meet audio keeps playing for you)                │    │
│  └────────────┬─────────────────────────────────────────────┘    │
│               │ raw PCM chunks (ArrayBuffer)                     │
│  ┌────────────▼──────────────┐  ┌──────────────────────────────┐ │
│  │  Gemini Live WebSocket    │  │  Gemini Flash (REST/stream)  │ │
│  │  (Transcription Engine)   │  │  (Suggestion Engine)         │ │
│  │                           │  │                              │ │
│  │  Model: gemini-3.1-flash  │  │  Model: gemini-2.5-flash     │ │
│  │         -live-preview     │  │  Input: rolling transcript   │ │
│  │                           │  │  Output: 1-3 short replies   │ │
│  │  Config:                  │  │                              │ │
│  │  • responseModalities:    │  │  Triggered: on every         │ │
│  │    TEXT (not AUDIO)       │  │  "turnComplete" event from   │ │
│  │  • inputAudioTranscription│  │  Live API                    │ │
│  │  • VAD: automatic         │  │                              │ │
│  │                           │  │  Output streamed back →      │ │
│  │  Output → inputTranscript │  │  content script via SW       │ │
│  └───────────────────────────┘  └──────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Message flow summary:**

```
User clicks "Start" in Meet sidebar
   → content.js → background.js (tabCapture streamId)
   → background.js → offscreen.js (streamId)
   → offscreen.js opens getUserMedia stream
   → AudioWorklet converts Float32 → PCM16
   → PCM chunks → Gemini Live WebSocket (wss://...)
   → inputTranscription events → background.js → content.js (transcript line)
   → on turnComplete → Gemini Flash REST call (rolling transcript as context)
   → suggestions → background.js → content.js (suggestion chips)
```

---

## 3. File Structure

```
meet-assistant/
├── manifest.json
├── background.js           ← Service worker (orchestrator)
├── content.js              ← UI injected into Meet tab
├── content.css             ← Sidebar styles
├── offscreen.html          ← Hidden persistent document
├── offscreen.js            ← Audio pipeline + both Gemini calls
├── pcm-processor.js        ← AudioWorklet: resampling Float32→PCM16
└── icons/
    └── icon128.png
```

---

## 4. `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Meet AI Assistant",
  "version": "1.0.0",
  "description": "Real-time transcription and chat suggestions in Google Meet",

  "permissions": [
    "tabCapture",
    "offscreen",
    "activeTab",
    "scripting",
    "storage"
  ],

  "host_permissions": [
    "https://meet.google.com/*"
  ],

  "background": {
    "service_worker": "background.js",
    "type": "module"
  },

  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ],

  "action": {
    "default_icon": { "128": "icons/icon128.png" }
  },

  "web_accessible_resources": [
    {
      "resources": ["offscreen.html", "pcm-processor.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

**Why these permissions:**
- `tabCapture` — only API that captures a tab's audio without a system picker
- `offscreen` — needed to create a hidden DOM document for persistent AudioContext
- `activeTab` — lets the user initiate capture via a gesture
- `scripting` — injects content script dynamically if needed

---

## 5. `background.js` — Service Worker (Orchestrator)

```javascript
// background.js
// Sole job: coordinate tabCapture + offscreen lifecycle + message routing.
// Does NOT hold audio data. Can sleep between events.

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Capture and process Google Meet tab audio for Gemini transcription",
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "START_CAPTURE") {
    handleStart(sender.tab.id).catch(console.error);
    return true; // async
  }

  if (msg.type === "STOP_CAPTURE") {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE", target: "offscreen" });
    return;
  }

  // Forward transcript / suggestion updates from offscreen → content script
  if (msg.type === "TRANSCRIPT_UPDATE" || msg.type === "SUGGESTION_UPDATE") {
    // Find the Meet tab and forward
    chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      });
    });
    return;
  }
});

async function handleStart(tabId) {
  await ensureOffscreen();

  // Must be called in the same turn as user gesture (from content script click)
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  // Retrieve API key from storage (set once by user in popup)
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");

  chrome.runtime.sendMessage({
    type: "START_CAPTURE",
    target: "offscreen",
    streamId,
    apiKey: geminiApiKey,
    tabId,
  });
}
```

**Key design decisions:**
- The service worker can and will be suspended by Chrome between events — that's fine because all stateful work (WebSocket connection, AudioContext) lives in the offscreen document.
- `getMediaStreamId()` MUST be called in response to a user gesture (the content script button click). This is a Chrome security constraint.

---

## 6. `offscreen.js` — Audio Pipeline + Gemini Integration

This is the most complex file. It does three things: capture audio, stream to Gemini Live, and call Gemini Flash for suggestions.

```javascript
// offscreen.js
// Lives in the offscreen document. Never sleeps. Owns the WebSocket and AudioContext.

let audioContext = null;
let liveWebSocket = null;
let transcriptBuffer = []; // rolling window for suggestion context
let suggestionDebounce = null;
let apiKey = null;

// ─── Message Listener ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") return;

  if (msg.type === "START_CAPTURE") {
    apiKey = msg.apiKey;
    startPipeline(msg.streamId).catch(console.error);
  }
  if (msg.type === "STOP_CAPTURE") {
    stopPipeline();
  }
});

// ─── 1. Audio Capture ───────────────────────────────────────────
async function startPipeline(streamId) {
  // Get the tab audio stream using the stream ID from tabCapture
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  // CRITICAL: Re-route audio back to speakers so user can still hear Meet
  audioContext = new AudioContext({ sampleRate: 16000 }); // Request 16kHz directly
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination); // keep Meet audio audible

  // Load AudioWorklet for PCM conversion
  await audioContext.audioWorklet.addModule(
    chrome.runtime.getURL("pcm-processor.js")
  );
  const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
  source.connect(workletNode);

  // Each message from worklet = one chunk of raw PCM16 bytes
  workletNode.port.onmessage = (e) => {
    sendAudioChunkToGemini(e.data); // e.data is Int16Array
  };

  // Connect Gemini Live WebSocket
  connectGeminiLive();
}

function stopPipeline() {
  liveWebSocket?.close();
  audioContext?.close();
  liveWebSocket = null;
  audioContext = null;
  transcriptBuffer = [];
}

// ─── 2. Gemini Live WebSocket (Transcription) ───────────────────
function connectGeminiLive() {
  const model = "gemini-2.5-flash-exp-native-audio-thinking-dialog"; 
  // Use latest: check https://ai.google.dev/gemini-api/docs/models
  // As of April 2026, gemini-3.1-flash-live-preview is also available

  const wsUrl =
    `wss://generativelanguage.googleapis.com/ws/` +
    `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent` +
    `?key=${apiKey}`;

  liveWebSocket = new WebSocket(wsUrl);

  liveWebSocket.onopen = () => {
    // Send setup config — TEXT response only, we only want transcription
    liveWebSocket.send(JSON.stringify({
      setup: {
        model: `models/${model}`,
        generation_config: {
          response_modalities: ["TEXT"],  // No audio output needed
        },
        // Enable input transcription (speech-to-text of what we send)
        input_audio_transcription: {},
        // System instruction to suppress model responses unless asked
        system_instruction: {
          parts: [{
            text: `You are a silent transcription assistant. Only transcribe audio. 
                   Do not reply, do not comment. Return only transcription events.`
          }]
        }
      },
    }));
  };

  liveWebSocket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const sc = msg.serverContent;
    if (!sc) return;

    // Handle real-time input transcription (what speakers said)
    if (sc.inputTranscription?.text) {
      const text = sc.inputTranscription.text;
      forwardToContentScript({ type: "TRANSCRIPT_UPDATE", text, isFinal: false });
    }

    // turnComplete = speaker finished a sentence → trigger suggestion
    if (sc.turnComplete) {
      forwardToContentScript({ type: "TRANSCRIPT_UPDATE", text: "", isFinal: true });
      // Debounce: don't spam suggestions on every word
      clearTimeout(suggestionDebounce);
      suggestionDebounce = setTimeout(() => triggerSuggestions(), 600);
    }
  };

  liveWebSocket.onerror = (e) => console.error("Gemini Live WS error:", e);
  liveWebSocket.onclose = () => console.log("Gemini Live WS closed");
}

// ─── 3. Send Audio Chunks ────────────────────────────────────────
function sendAudioChunkToGemini(int16Array) {
  if (!liveWebSocket || liveWebSocket.readyState !== WebSocket.OPEN) return;

  // Convert Int16Array → base64
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  const base64 = btoa(binary);

  liveWebSocket.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: base64,
        mimeType: "audio/pcm;rate=16000",
      },
    },
  }));
}

// ─── 4. Gemini Flash — Suggestion Engine ────────────────────────
async function triggerSuggestions() {
  if (transcriptBuffer.length === 0) return;

  const recentTranscript = transcriptBuffer.slice(-20).join("\n");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: `You are a meeting assistant. Based on the conversation transcript below,
suggest 2-3 short, natural replies or questions the user might want to say next.
Format: return only a JSON array of strings, e.g. ["Could you clarify X?", "I agree with that point.", "What's the timeline?"]
Keep each suggestion under 15 words. Be context-aware and helpful.`
          }]
        },
        contents: [{
          role: "user",
          parts: [{ text: `Meeting transcript (last few exchanges):\n\n${recentTranscript}\n\nSuggest replies:` }]
        }],
        generation_config: {
          response_mime_type: "application/json",
          max_output_tokens: 200,
          temperature: 0.7,
        }
      }),
    }
  );

  const data = await response.json();
  try {
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const suggestions = JSON.parse(raw);
    forwardToContentScript({ type: "SUGGESTION_UPDATE", suggestions });
  } catch (e) {
    console.warn("Suggestion parse error:", e);
  }
}

// ─── 5. Update transcript buffer ────────────────────────────────
function forwardToContentScript(msg) {
  // Also maintain transcript buffer for suggestion context
  if (msg.type === "TRANSCRIPT_UPDATE" && msg.isFinal && msg.text) {
    transcriptBuffer.push(msg.text);
    if (transcriptBuffer.length > 50) transcriptBuffer.shift(); // cap at 50 lines
  }
  chrome.runtime.sendMessage(msg).catch(() => {});
}
```

---

## 7. `pcm-processor.js` — AudioWorklet (The Critical Bridge)

This runs in a dedicated audio thread. Its job: convert Chrome's native Float32 audio to Gemini's required Int16 PCM at 16kHz.

```javascript
// pcm-processor.js
// Runs in AudioWorkletGlobalScope — no DOM, no fetch, no imports

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Buffer to accumulate ~100ms worth of samples before sending
    // At 16kHz: 1600 samples = 100ms. Reduces WS message frequency.
    this._buffer = new Int16Array(1600);
    this._bufferIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // Float32Array, one channel

    for (let i = 0; i < channelData.length; i++) {
      // Float32 [-1.0, 1.0] → Int16 [-32768, 32767]
      const s = Math.max(-1, Math.min(1, channelData[i]));
      this._buffer[this._bufferIndex++] = s < 0 ? s * 32768 : s * 32767;

      if (this._bufferIndex >= this._buffer.length) {
        // Send a copy (buffer will be reused)
        this.port.postMessage(this._buffer.slice());
        this._bufferIndex = 0;
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor("pcm-processor", PCMProcessor);
```

**Why AudioWorklet over ScriptProcessorNode:**
- `ScriptProcessorNode` runs on the main thread and causes audio glitches under load
- `AudioWorklet` runs in a dedicated real-time audio thread — crucial for smooth 16kHz streaming

**Note on sample rate:** If `AudioContext({ sampleRate: 16000 })` is not honored by Chrome, the worklet will receive 48kHz audio. In that case, add a downsampling step inside `process()`:

```javascript
// Simple 3:1 downsample for 48kHz → 16kHz
// Take every 3rd sample (good enough for voice; use a proper FIR filter for production)
if (i % 3 === 0) {
  this._buffer[this._bufferIndex++] = ...
}
```

---

## 8. `content.js` — UI Injected Into Meet

```javascript
// content.js
// Injected into every meet.google.com tab.
// Renders a floating sidebar and communicates with background.js.

let isCapturing = false;
const sidebar = createSidebar();
document.body.appendChild(sidebar);

function createSidebar() {
  const el = document.createElement("div");
  el.id = "meet-ai-sidebar";
  el.innerHTML = `
    <div class="mas-header">
      <span class="mas-title">AI Assistant</span>
      <button id="mas-toggle">▶ Start</button>
    </div>
    <div class="mas-section">
      <div class="mas-label">Live Transcript</div>
      <div id="mas-transcript"></div>
    </div>
    <div class="mas-section">
      <div class="mas-label">Suggestions</div>
      <div id="mas-suggestions"></div>
    </div>
  `;
  return el;
}

document.getElementById("mas-toggle").addEventListener("click", () => {
  if (!isCapturing) {
    chrome.runtime.sendMessage({ type: "START_CAPTURE" });
    document.getElementById("mas-toggle").textContent = "⏹ Stop";
    isCapturing = true;
  } else {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    document.getElementById("mas-toggle").textContent = "▶ Start";
    isCapturing = false;
  }
});

// Listen for updates from background.js (forwarded from offscreen)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "TRANSCRIPT_UPDATE") {
    updateTranscript(msg.text, msg.isFinal);
  }
  if (msg.type === "SUGGESTION_UPDATE") {
    renderSuggestions(msg.suggestions);
  }
});

let pendingLine = "";

function updateTranscript(text, isFinal) {
  const container = document.getElementById("mas-transcript");

  if (!isFinal) {
    // Update the current in-progress line
    let pending = container.querySelector(".mas-pending");
    if (!pending) {
      pending = document.createElement("div");
      pending.className = "mas-line mas-pending";
      container.appendChild(pending);
    }
    pending.textContent = text;
  } else {
    // Finalize: remove pending class
    const pending = container.querySelector(".mas-pending");
    if (pending) pending.classList.remove("mas-pending");
    // Auto-scroll
    container.scrollTop = container.scrollHeight;
  }
}

function renderSuggestions(suggestions) {
  const container = document.getElementById("mas-suggestions");
  container.innerHTML = "";
  suggestions.forEach((s) => {
    const chip = document.createElement("div");
    chip.className = "mas-chip";
    chip.textContent = s;
    chip.addEventListener("click", () => {
      // Copy to clipboard on click
      navigator.clipboard.writeText(s);
      chip.classList.add("mas-copied");
      setTimeout(() => chip.classList.remove("mas-copied"), 1500);
    });
    container.appendChild(chip);
  });
}
```

---

## 9. `content.css` — Sidebar Styles

```css
#meet-ai-sidebar {
  position: fixed;
  top: 80px;
  right: 16px;
  width: 300px;
  max-height: 70vh;
  background: rgba(32, 33, 36, 0.96);
  color: #e8eaed;
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  font-family: 'Google Sans', sans-serif;
  font-size: 13px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  backdrop-filter: blur(8px);
}

.mas-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255,255,255,0.1);
}

.mas-title { font-weight: 600; font-size: 14px; }

#mas-toggle {
  background: #1a73e8;
  color: white;
  border: none;
  padding: 4px 12px;
  border-radius: 20px;
  cursor: pointer;
  font-size: 12px;
}

.mas-section {
  padding: 10px 14px;
  flex: 1;
  overflow-y: auto;
  min-height: 80px;
  max-height: 45vh;
}

.mas-label {
  font-size: 11px;
  color: #9aa0a6;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.mas-line {
  line-height: 1.5;
  margin-bottom: 4px;
  padding: 2px 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}

.mas-pending { color: #aecbfa; font-style: italic; }

.mas-chip {
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 8px;
  padding: 6px 10px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background 0.15s;
  line-height: 1.4;
}

.mas-chip:hover { background: rgba(255,255,255,0.15); }
.mas-chip.mas-copied { background: rgba(52,168,83,0.3); }
```

---

## 10. `offscreen.html`

```html
<!DOCTYPE html>
<html>
<head><title>Meet AI Offscreen</title></head>
<body>
  <!-- Hidden document. Hosts AudioContext + WebSocket. No visible UI. -->
  <script src="offscreen.js"></script>
</body>
</html>
```

---

## 11. Audio Format — The Most Critical Detail

This is where most implementations break. Get this exactly right:

| Parameter | Value | Why |
|-----------|-------|-----|
| Format | Raw PCM | No containers (no WAV header, no MP3) |
| Bit depth | 16-bit signed integer | Gemini requirement |
| Sample rate | 16 kHz | Gemini input spec (`audio/pcm;rate=16000`) |
| Endianness | Little-endian | x86 native; Gemini spec |
| Channels | Mono | 1 channel only |
| MIME type | `audio/pcm;rate=16000` | Must be set on every chunk |
| Chunk size | ~100ms (1,600 samples) | Balance: too small = WS overhead, too large = latency |
| Chrome default | Float32 @ 48kHz | Must be converted by AudioWorklet |
| Gemini output | 24kHz PCM | Not needed (we use TEXT output only) |

**The conversion chain:**

```
Chrome AudioContext
  └─ Float32Array @ 48kHz (or 16kHz if AudioContext sampleRate is honored)
      └─ AudioWorklet pcm-processor.js
          └─ Int16Array @ 16kHz (downsampled + clamped)
              └─ base64 encoded
                  └─ JSON { realtimeInput: { audio: { data, mimeType } } }
                      └─ Gemini Live WebSocket
```

---

## 12. Model Selection Strategy

| Model | Use Case | Config |
|-------|----------|--------|
| `gemini-3.1-flash-live-preview` | Transcription (Live API) | `responseModalities: ["TEXT"]`, `inputAudioTranscription: {}` |
| `gemini-2.5-flash` | Chat suggestions (REST) | `responseMimeType: "application/json"`, `temperature: 0.7` |

**Why TEXT-only for Live API?**
You don't need Gemini to speak back. Requesting TEXT instead of AUDIO eliminates audio decoding overhead and token costs. The `inputAudioTranscription` field gives you the speaker's words as text events.

**Why a separate Flash model for suggestions?**
The Live API WebSocket is a persistent stateful session optimized for continuous audio. Injecting a complex reasoning task into it adds latency and cost. A separate REST call to Gemini Flash on `turnComplete` events decouples the two concerns cleanly.

---

## 13. Handling the Two Audio Sources (Tab + Mic)

The current design captures **tab audio only** (remote participants). To also transcribe yourself:

```javascript
// In offscreen.js, alongside the tab stream:
const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

// Mix both into Gemini Live — it handles multi-speaker natively
const micSource = audioContext.createMediaStreamSource(micStream);
micSource.connect(workletNode); // same worklet, same WS

// Or: separate worklet for mic → label transcript lines by source
// (tag by detecting silence gaps: tab vs mic rarely overlap)
```

**Speaker diarization:** Gemini Live does not natively label "Speaker A" vs "Speaker B" from a mixed stream. For basic diarization, use VAD (Voice Activity Detection) timing — tab audio and mic audio will rarely overlap, so you can tag based on which source had activity.

---

## 14. Session Management & Limits

The Gemini Live API has session limits:

| Limit | Value | Mitigation |
|-------|-------|------------|
| Audio-only session | 15 minutes | Auto-reconnect with session resumption tokens |
| Context window | ~1M tokens | Summarize older transcript before reconnect |
| Concurrent sessions (paid) | Check your quota | One session per meeting |

**Auto-reconnect pattern:**

```javascript
// In connectGeminiLive():
liveWebSocket.onclose = (e) => {
  if (isCapturing && e.code !== 1000) {
    console.log("Reconnecting Gemini Live in 2s...");
    // Seed new session with last N lines of transcript for context
    setTimeout(() => connectGeminiLive(transcriptBuffer.slice(-10)), 2000);
  }
};
```

For sessions beyond 15 minutes, use the **session resumption** feature:
```javascript
// In setup config:
session_resumption: { handle: previousHandle || undefined }

// Server will return:
// { sessionResumptionUpdate: { newHandle: "...", resumable: true } }
// Store this handle and use on reconnect
```

---

## 15. Security: API Key Handling

**Never hardcode the API key.** The correct flow:

1. Create a small popup (`popup.html`) where user pastes their Gemini API key once
2. Store in `chrome.storage.local` (encrypted at rest by Chrome, local to extension)
3. Pass from background.js to offscreen.js via runtime message (in-process, not network)
4. Offscreen.js uses it directly in WS URL and fetch calls

```javascript
// popup.js
document.getElementById("save").addEventListener("click", () => {
  const key = document.getElementById("api-key").value.trim();
  chrome.storage.local.set({ geminiApiKey: key }, () => {
    document.getElementById("status").textContent = "Saved ✓";
  });
});
```

For production, use **ephemeral tokens** instead:
```
Your backend → POST https://generativelanguage.googleapis.com/v1beta/ephemeralTokens
             ← { token: "...", expireTime: "..." }
Extension → uses token in WS URL instead of API key
Token expires after ~1 hour
```

This prevents API key exposure even if the extension is reverse-engineered.

---

## 16. Debugging Checklist

| Issue | Debug Step |
|-------|-----------|
| No audio captured | Check `chrome://extensions` → inspect offscreen.html → console for getUserMedia errors |
| WebSocket closes immediately | Verify API key; check WS URL model name is valid |
| Transcript is empty | Confirm `inputAudioTranscription: {}` is in setup config |
| Audio inaudible during capture | Ensure `source.connect(audioContext.destination)` is present |
| PCM sounds distorted | Check sample rate; verify Float32→Int16 conversion math |
| Suggestions not appearing | Add `console.log` after fetch in `triggerSuggestions`; check JSON.parse output |
| Service worker sleeping | Move all stateful code to offscreen.js; SW should only orchestrate |
| Content script not loading | Verify `host_permissions` includes `https://meet.google.com/*` |

---

## 17. Complete Build Steps

```bash
# 1. Create directory
mkdir meet-assistant && cd meet-assistant

# 2. Create all files as described above
# (manifest.json, background.js, content.js, content.css,
#  offscreen.html, offscreen.js, pcm-processor.js)

# 3. Add a 128x128 icon
mkdir icons
# Place icon128.png in icons/

# 4. Load in Chrome
# → chrome://extensions
# → Enable "Developer mode" (top right toggle)
# → "Load unpacked" → select meet-assistant folder

# 5. Open a Google Meet
# → The sidebar appears on the right
# → Click "▶ Start" to begin capture
# → Speak or have others speak
# → Transcript and suggestions appear in real time
```

---

## 18. Cost Estimation (Paid Gemini API)

Gemini Live API pricing (as of early 2026) is based on audio input tokens:

| Component | Usage per 1-hour meeting | Estimated cost |
|-----------|--------------------------|----------------|
| Gemini Live (transcription, text output) | ~3,600s audio → ~450K tokens | ~$0.50–$1.50 |
| Gemini Flash (suggestions, ~20 calls) | ~5K tokens total | < $0.01 |
| **Total per meeting** | | **~$0.50–$2.00** |

Optimize cost: only stream audio to Gemini Live when VAD detects speech (use the built-in VAD or a local `AudioWorkletNode` silence detector).

---

## 19. Extending the Extension

| Feature | How |
|---------|-----|
| **Action items** | After meeting, send full transcript to Gemini Flash with "extract action items" prompt |
| **Speaker labels** | Use separate mic vs tab worklet nodes; label transcript lines accordingly |
| **Custom vocabulary** | Add glossary to Live API system instruction |
| **Meeting notes export** | Store transcript in `chrome.storage.local`; add "Export" button in sidebar |
| **Summarize on demand** | Button in sidebar → sends last N transcript lines to Gemini Flash |
| **Translate** | Add language toggle; set `speech_config.language_code` in Live API config |

---

## 20. Known Chrome MV3 Constraints

- **Service worker can sleep** — keep all media and WS in offscreen.js, never in background.js
- **One offscreen document per extension** — all audio processing must share it
- **tabCapture requires user gesture** — cannot auto-start when Meet opens
- **Tab close stops stream** — re-capture requires new user gesture
- **HTTPS only** — tabCapture only works on secure origins (Meet is always HTTPS, ✓)
- **Cross-origin restrictions** — Gemini API domain must be in `host_permissions` or called from offscreen (not content script due to CSP)

---

*Last updated: April 2026. Gemini model names change frequently — always verify at https://ai.google.dev/gemini-api/docs/models before deploying.*
