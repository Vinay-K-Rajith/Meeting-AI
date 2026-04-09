let audioContext = null;
let tabStream = null;
let tabSource = null;
let workletNode = null;
let liveSocket = null;

let isCapturing = false;
let apiKey = "";
let activeTabId = null;
let partialTranscript = "";
const transcriptBuffer = [];
let suggestionDebounceId = null;

const LIVE_MODEL = "gemini-3.1-flash-live-preview";
const LIVE_MODEL_FALLBACK = "gemini-2.5-flash";
const SUGGESTION_MODEL = "gemini-flash-lite-latest";
let currentLiveModel = LIVE_MODEL;

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

  // Keep Meet audio audible while we also process it.
  tabSource.connect(audioContext.destination);
  tabSource.connect(workletNode);

  workletNode.port.onmessage = (event) => {
    sendAudioChunkToGemini(event.data);
  };

  forwardMessage({
    type: "CAPTURE_STATE",
    tabId: activeTabId,
    state: "CONNECTING"
  });

  connectGeminiLive();
  isCapturing = true;
}

function stopPipeline() {
  isCapturing = false;
  partialTranscript = "";
  transcriptBuffer.length = 0;
  clearTimeout(suggestionDebounceId);
  suggestionDebounceId = null;

  if (liveSocket) {
    try {
      liveSocket.close(1000, "Stopped by user");
    } catch (_) {
      // No-op.
    }
    liveSocket = null;
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

function connectGeminiLive() {
  const wsUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(apiKey)}`;

  liveSocket = new WebSocket(wsUrl);
  const setupTimeoutId = setTimeout(() => {
    if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) {
      return;
    }
    forwardMessage({
      type: "ASSISTANT_ERROR",
      tabId: activeTabId,
      error:
        "Gemini Live setup timeout. Check API key restrictions, quota, and model access."
    });
  }, 8000);

  liveSocket.onopen = () => {
    forwardMessage({
      type: "CAPTURE_STATE",
      tabId: activeTabId,
      state: "LIVE_CONNECTED"
    });

    liveSocket.send(
      JSON.stringify({
        setup: {
          model: `models/${currentLiveModel}`,
          generationConfig: {
            responseModalities: ["TEXT"]
          },
          inputAudioTranscription: {},
          systemInstruction: {
            parts: [
              {
                text: "You are a silent transcription assistant. Only transcribe incoming speech."
              }
            ]
          }
        }
      })
    );
  };

  liveSocket.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    const serverContent = payload?.serverContent;
    if (payload?.setupComplete) {
      clearTimeout(setupTimeoutId);
      forwardMessage({
        type: "CAPTURE_STATE",
        tabId: activeTabId,
        state: "READY"
      });
      return;
    }

    if (!serverContent) {
      return;
    }

    // Some sessions may not emit setupComplete explicitly; any serverContent means the config was accepted.
    clearTimeout(setupTimeoutId);

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
  };

  liveSocket.onerror = () => {
    clearTimeout(setupTimeoutId);
    forwardMessage({
      type: "ASSISTANT_ERROR",
      tabId: activeTabId,
      error: "Gemini Live socket error."
    });
  };

  liveSocket.onclose = (event) => {
    clearTimeout(setupTimeoutId);
    if (!isCapturing) {
      return;
    }

    if (event.code !== 1000) {
      const closeReason = event.reason ? ` Reason: ${event.reason}` : "";

      // Retry once with fallback model when primary model may be unavailable.
      if (currentLiveModel === LIVE_MODEL) {
        currentLiveModel = LIVE_MODEL_FALLBACK;
      }

      forwardMessage({
        type: "CAPTURE_STATE",
        tabId: activeTabId,
        state: "RECONNECTING"
      });
      forwardMessage({
        type: "ASSISTANT_ERROR",
        tabId: activeTabId,
        error:
          `Gemini Live disconnected (code ${event.code}).` +
          `${closeReason} Retrying with model ${currentLiveModel}.`
      });
      setTimeout(() => {
        if (isCapturing) {
          connectGeminiLive();
        }
      }, 1500);
      return;
    }

    currentLiveModel = LIVE_MODEL;
  };
}

function sendAudioChunkToGemini(int16Chunk) {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) {
    return;
  }

  const bytes = new Uint8Array(int16Chunk.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64Data = btoa(binary);

  liveSocket.send(
    JSON.stringify({
      realtimeInput: {
        audio: {
          data: base64Data,
          mimeType: "audio/pcm;rate=16000"
        }
      }
    })
  );
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
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 200,
        temperature: 0.7
      },
      systemInstruction: {
        parts: [
          {
            text:
              "You generate 2-3 concise meeting replies. Return strictly JSON array of strings."
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
