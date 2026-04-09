import { GoogleGenAI } from "@google/genai";

let audioContext = null;
let tabStream = null;
let tabSource = null;
let workletNode = null;

let isCapturing = false;
let apiKey = "";
let activeTabId = null;
let partialTranscript = "";
const transcriptBuffer = [];
let suggestionDebounceId = null;
let pendingPcmSamples = [];
const PCM_BATCH_SAMPLES = 4000; // ~250ms at 16kHz

const LIVE_MODEL = "gemini-3.1-flash-live-preview";
const LIVE_MODEL_FALLBACK = "gemini-2.5-flash-native-audio-preview-12-2025";
const SUGGESTION_MODEL = "gemini-flash-lite-latest";
let currentLiveModel = LIVE_MODEL;

let liveSession = null;
let isLiveReady = false;
let reconnectTimerId = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 8;
let isConnectingLive = false;
let liveConnectionToken = 0;

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
  transcriptBuffer.length = 0;
  clearTimeout(suggestionDebounceId);
  suggestionDebounceId = null;
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
              "You are a transcription assistant. Prioritize accurate input transcription. Keep spoken responses extremely brief. You work for ENTAB Infotech"
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

        if (serverContent.turnComplete) {
          if (partialTranscript.trim()) {
            transcriptBuffer.push(partialTranscript.trim());
            if (transcriptBuffer.length > 100) {
              transcriptBuffer.shift();
            }
            forwardMessage({
              type: "TRANSCRIPT_UPDATE",
              tabId: activeTabId,
              text: partialTranscript,
              isFinal: true
            });
          }

          partialTranscript = "";
          clearTimeout(suggestionDebounceId);
          suggestionDebounceId = setTimeout(() => {
            triggerSuggestions().catch(() => {});
          }, 500);
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

async function triggerSuggestions() {
  if (!apiKey || transcriptBuffer.length === 0) {
    return;
  }

  const recentTranscript = transcriptBuffer.slice(-20).join("\n");
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${SUGGESTION_MODEL}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 200,
        temperature: 0.7
      },
      systemInstruction: {
        parts: [
          {
            text: "You generate 2-3 concise meeting replies. Return strictly JSON array of strings.always in english. remember you work for entab infotech"
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                "Transcript:\n" +
                recentTranscript +
                "\n\nGenerate reply suggestions under 15 words each."
            }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    return;
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  let suggestions = [];
  try {
    suggestions = JSON.parse(text);
  } catch (_) {
    suggestions = [];
  }

  if (!Array.isArray(suggestions)) {
    suggestions = [];
  }

  forwardMessage({
    type: "SUGGESTION_UPDATE",
    tabId: activeTabId,
    suggestions: suggestions.slice(0, 3).filter((item) => typeof item === "string" && item.trim())
  });
}

function forwardMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}
