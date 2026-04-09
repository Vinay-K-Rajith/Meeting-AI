import { GoogleGenAI } from "@google/genai";

let audioContext = null;
let tabStream = null;
let tabSource = null;
let workletNode = null;

let isCapturing = false;
let apiKey = "";
let activeTabId = null;
let partialTranscript = "";
let outputSuggestionTranscript = "";
let finalizedSuggestions = [];
let pendingPcmSamples = [];
const PCM_BATCH_SAMPLES = 4000; // ~250ms at 16kHz

const LIVE_MODEL = "gemini-3.1-flash-live-preview";
const LIVE_MODEL_FALLBACK = "gemini-2.5-flash-native-audio-preview-12-2025";
let currentLiveModel = LIVE_MODEL;

let liveSession = null;
let isLiveReady = false;
let reconnectTimerId = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let isConnectingLive = false;
let liveConnectionToken = 0;

const ENTAB_KNOWLEDGE_BASE =
  "Entab Infotech is an Indian EdTech company with 23+ years in school ERP. " +
  "Its flagship platform is CampusCare, a cloud-based school management ERP used by 1200+ schools. " +
  "Core modules include student registration and lifecycle records, fee management and online collection, " +
  "exam and assessment workflows, lesson planning and assignments, parent-teacher communication portals, " +
  "library, HR, payroll, inventory, attendance, and bus GPS tracking. " +
  "The platform supports NEP 2020 aligned structures and competency-focused assessment, " +
  "and provides analytics dashboards for data-driven school decisions.";

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== "offscreen") {
    return;
  }

  if (msg.type === "START_CAPTURE") {
    apiKey = msg.apiKey || "";
    activeTabId = msg.tabId || null;
    startPipeline(msg.streamId).catch((error) => {
      forwardMessage({
        type: "ASSISTANT_ERROR",
        tabId: activeTabId,
        error: error?.message || "Failed to start offscreen pipeline."
      });
    });
    return;
  }

  if (msg.type === "STOP_CAPTURE") {
    stopPipeline();
  }
});

async function startPipeline(streamId) {
  if (isCapturing) {
    stopPipeline();
  }

  if (!apiKey) {
    throw new Error("Gemini API key missing.");
  }

  currentLiveModel = LIVE_MODEL;
  reconnectAttempt = 0;

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext({ sampleRate: 16000 });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL("pcm-processor.js"));

  tabSource = audioContext.createMediaStreamSource(tabStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

  // Keep Meet audio audible while we process it.
  tabSource.connect(audioContext.destination);
  tabSource.connect(workletNode);

  workletNode.port.onmessage = (event) => {
    if (!isLiveReady) {
      return;
    }
    queueAndSendAudio(event.data);
  };

  forwardMessage({
    type: "CAPTURE_STATE",
    tabId: activeTabId,
    state: "CONNECTING"
  });

  isCapturing = true;
  await connectGeminiLive();
}

function stopPipeline() {
  isCapturing = false;
  partialTranscript = "";
  outputSuggestionTranscript = "";
  finalizedSuggestions = [];
  clearTimeout(reconnectTimerId);
  reconnectTimerId = null;
  reconnectAttempt = 0;
  isLiveReady = false;
  pendingPcmSamples = [];
  isConnectingLive = false;
  liveConnectionToken += 1;

  if (liveSession) {
    try {
      liveSession.close();
    } catch (_) {
      // No-op.
    }
    liveSession = null;
  }

  forwardMessage({
    type: "CAPTURE_STATE",
    tabId: activeTabId,
    state: "STOPPED"
  });

  if (workletNode) {
    try {
      workletNode.disconnect();
    } catch (_) {
      // No-op.
    }
    workletNode = null;
  }

  if (tabSource) {
    try {
      tabSource.disconnect();
    } catch (_) {
      // No-op.
    }
    tabSource = null;
  }

  if (tabStream) {
    tabStream.getTracks().forEach((track) => track.stop());
    tabStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

async function connectGeminiLive() {
  if (isConnectingLive || !isCapturing) {
    return;
  }

  isConnectingLive = true;
  const connectionToken = ++liveConnectionToken;
  const primaryModel = currentLiveModel || LIVE_MODEL;
  const candidates = primaryModel === LIVE_MODEL ? [LIVE_MODEL, LIVE_MODEL_FALLBACK] : [primaryModel];

  let lastError = null;
  for (const candidate of candidates) {
    if (connectionToken !== liveConnectionToken || !isCapturing) {
      isConnectingLive = false;
      return;
    }
    try {
      await connectWithModel(candidate, connectionToken);
      currentLiveModel = candidate;
      reconnectAttempt = 0;
      isConnectingLive = false;
      return;
    } catch (error) {
      lastError = error;
      forwardMessage({
        type: "ASSISTANT_ERROR",
        tabId: activeTabId,
        error: `Live connect failed for ${candidate}: ${error?.message || "unknown error"}`
      });
    }
  }

  if (!isCapturing) {
    isConnectingLive = false;
    return;
  }

  isConnectingLive = false;
  scheduleReconnect(`Unable to establish Live session: ${lastError?.message || "unknown error"}`);
}

async function connectWithModel(model, connectionToken) {
  if (!apiKey) {
    throw new Error("Missing API key.");
  }

  const ai = new GoogleGenAI({ apiKey });

  isLiveReady = false;
  liveSession = await ai.live.connect({
    model,
    config: {
      responseModalities: ["AUDIO"],
      inputAudioTranscription: {},
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Zephyr"
          }
        }
      },
      systemInstruction: {
        parts: [
          {
            text:
              "You are a live meeting copilot for ENTAB Infotech. " +
              "After each user turn, generate exactly 3 high-quality response suggestions the user can say next. " +
              "The suggestions must be direct answers/statements the user can speak immediately, not follow-up questions. " +
              "Use assertive, professional, helpful language in business conversations. " +
              "Each suggestion must be one line, natural spoken English, under 18 words, and non-repetitive. " +
              "Never use question marks. Never ask the other person another question. " +
              "Prefer grounded answers based on this product knowledge: " +
              ENTAB_KNOWLEDGE_BASE +
              " " +
              "Output format must be exactly:\n" +
              "1) <suggestion>\n" +
              "2) <suggestion>\n" +
              "3) <suggestion>\n" +
              "Do not output anything except these 3 lines."
          }
        ]
      }
    },
    callbacks: {
      onopen: () => {
        if (connectionToken !== liveConnectionToken || !isCapturing) {
          return;
        }
        isLiveReady = true;
        clearTimeout(reconnectTimerId);
        reconnectTimerId = null;
        forwardMessage({
          type: "CAPTURE_STATE",
          tabId: activeTabId,
          state: "LIVE_CONNECTED"
        });
        forwardMessage({
          type: "CAPTURE_STATE",
          tabId: activeTabId,
          state: "READY"
        });
      },
      onmessage: (message) => {
        if (connectionToken !== liveConnectionToken || !isCapturing) {
          return;
        }
        const serverContent = message?.serverContent;
        if (!serverContent) {
          return;
        }

        const inputText = serverContent?.inputTranscription?.text;
        if (inputText) {
          partialTranscript = inputText;
          forwardMessage({
            type: "TRANSCRIPT_UPDATE",
            tabId: activeTabId,
            text: partialTranscript,
            isFinal: false
          });
        }

        const outputText = serverContent?.outputTranscription?.text;
        if (outputText) {
          outputSuggestionTranscript = mergeStreamingText(outputSuggestionTranscript, outputText);
          emitCurrentSuggestions();
        }

        if (serverContent.turnComplete) {
          if (partialTranscript.trim()) {
            forwardMessage({
              type: "TRANSCRIPT_UPDATE",
              tabId: activeTabId,
              text: partialTranscript,
              isFinal: true
            });
          }

          if (outputSuggestionTranscript.trim()) {
            const finalizedLines = extractSuggestionLines(outputSuggestionTranscript);
            if (finalizedLines.length > 0) {
              for (const line of finalizedLines) {
                const previous = finalizedSuggestions[finalizedSuggestions.length - 1] || "";
                if (previous !== line) {
                  finalizedSuggestions.push(line);
                }
              }
              if (finalizedSuggestions.length > 12) {
                finalizedSuggestions = finalizedSuggestions.slice(-12);
              }
            }
          }

          partialTranscript = "";
          outputSuggestionTranscript = "";
          emitCurrentSuggestions();
        }
      },
      onerror: (event) => {
        if (connectionToken !== liveConnectionToken || !isCapturing) {
          return;
        }
        isLiveReady = false;
        forwardMessage({
          type: "ASSISTANT_ERROR",
          tabId: activeTabId,
          error: `Gemini Live error: ${event?.message || "unknown error"}`
        });
      },
      onclose: (event) => {
        if (connectionToken !== liveConnectionToken) {
          return;
        }
        isLiveReady = false;
        liveSession = null;
        if (!isCapturing) {
          return;
        }
        const reason = event?.reason ? ` ${event.reason}` : "";
        scheduleReconnect(`Gemini Live disconnected (${event?.code ?? "?"}).${reason}`);
      }
    }
  });
}

function scheduleReconnect(detail) {
  if (isConnectingLive || !isCapturing) {
    return;
  }
  reconnectAttempt += 1;
  if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    isCapturing = false;
    forwardMessage({
      type: "ASSISTANT_ERROR",
      tabId: activeTabId,
      error: `${detail} Stopped after ${MAX_RECONNECT_ATTEMPTS} retries. Press Start again.`
    });
    forwardMessage({
      type: "CAPTURE_STATE",
      tabId: activeTabId,
      state: "STOPPED"
    });
    return;
  }

  const delayMs = Math.min(1000 * reconnectAttempt, 5000);

  forwardMessage({
    type: "CAPTURE_STATE",
    tabId: activeTabId,
    state: "RECONNECTING"
  });
  forwardMessage({
    type: "ASSISTANT_ERROR",
    tabId: activeTabId,
    error: `${detail} Retrying in ${Math.round(delayMs / 1000)}s with ${currentLiveModel}.`
  });

  clearTimeout(reconnectTimerId);
  reconnectTimerId = setTimeout(() => {
    if (isCapturing) {
      connectGeminiLive().catch(() => {});
    }
  }, delayMs);
}

function sendAudioChunkToGemini(int16Chunk) {
  if (!liveSession || !isLiveReady) {
    return;
  }

  const bytes = new Uint8Array(int16Chunk.buffer);
  const binary = uint8ToBinary(bytes);
  const base64Data = btoa(binary);

  try {
    liveSession.sendRealtimeInput({
      audio: {
        data: base64Data,
        mimeType: "audio/pcm;rate=16000"
      }
    });
  } catch (_) {
    // Ignore transient send failures during reconnect windows.
  }
}

function queueAndSendAudio(int16Chunk) {
  for (let i = 0; i < int16Chunk.length; i += 1) {
    pendingPcmSamples.push(int16Chunk[i]);
  }

  while (pendingPcmSamples.length >= PCM_BATCH_SAMPLES) {
    const batch = pendingPcmSamples.slice(0, PCM_BATCH_SAMPLES);
    pendingPcmSamples = pendingPcmSamples.slice(PCM_BATCH_SAMPLES);
    sendAudioChunkToGemini(new Int16Array(batch));
  }
}

function uint8ToBinary(uint8Array) {
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < uint8Array.length; i += chunkSize) {
    const sub = uint8Array.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...sub);
  }
  return binary;
}

function emitCurrentSuggestions() {
  const suggestions = finalizedSuggestions.slice(-6);
  const liveLines = extractSuggestionLines(outputSuggestionTranscript);
  if (liveLines.length > 0) {
    suggestions.push(...liveLines);
  }
  forwardMessage({
    type: "SUGGESTION_UPDATE",
    tabId: activeTabId,
    suggestions: uniqueLastN(suggestions, 3)
  });
}

function mergeStreamingText(previous, incoming) {
  const prev = (previous || "").trim();
  const next = (incoming || "").trim();
  if (!next) {
    return prev;
  }

  // Some streaming chunks are full replacements, others are incremental.
  if (!prev) {
    return next;
  }
  if (next.startsWith(prev)) {
    return next;
  }
  if (prev.startsWith(next)) {
    return prev;
  }

  const combined = `${prev} ${next}`.replace(/\s+/g, " ").trim();
  return combined;
}

function normalizeSuggestionLine(text) {
  if (!text || !text.trim()) {
    return "";
  }

  let cleaned = text.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  cleaned = cleaned.replace(/^\s*[-*•\d.)]+\s*/, "").trim();
  if (cleaned.length > 140) {
    cleaned = cleaned.slice(0, 140).trim();
  }
  return cleaned;
}

function extractSuggestionLines(text) {
  if (!text || !text.trim()) {
    return [];
  }

  const lines = text
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => normalizeSuggestionLine(line))
    .filter(Boolean)
    .map((line) => line.replace(/^\d+\)\s*/, "").trim());

  if (lines.length >= 2) {
    return uniqueLastN(lines, 3);
  }

  const byNumbering = text
    .split(/\s(?=\d+\))/g)
    .map((part) => normalizeSuggestionLine(part).replace(/^\d+\)\s*/, "").trim())
    .filter(Boolean);
  if (byNumbering.length >= 2) {
    return uniqueLastN(byNumbering, 3);
  }

  const bySentence = text
    .split(/[.!?]\s+/)
    .map((part) => normalizeSuggestionLine(part))
    .filter(Boolean);
  return uniqueLastN(bySentence, 3);
}

function uniqueLastN(items, n) {
  const seen = new Set();
  const reversed = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const value = items[i];
    if (!value || seen.has(value) || isQuestionStyle(value)) {
      continue;
    }
    seen.add(value);
    reversed.push(value);
    if (reversed.length >= n) {
      break;
    }
  }
  return reversed.reverse();
}

function isQuestionStyle(text) {
  const t = text.trim().toLowerCase();
  if (!t) {
    return false;
  }
  if (t.includes("?")) {
    return true;
  }
  return /^(what|why|how|when|where|who|which|can|could|would|should|is|are|do|does|did)\b/.test(t);
}

function forwardMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
