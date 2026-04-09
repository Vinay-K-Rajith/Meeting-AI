import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

const CASES = [
  {
    id: "3.1-text-inputTx",
    model: "gemini-3.1-flash-live-preview",
    config: {
      responseModalities: ["TEXT"],
      inputAudioTranscription: {},
      systemInstruction: { parts: [{ text: "Transcribe only." }] }
    }
  },
  {
    id: "3.1-text-minimal",
    model: "gemini-3.1-flash-live-preview",
    config: {
      responseModalities: ["TEXT"]
    }
  },
  {
    id: "3.1-audio",
    model: "gemini-3.1-flash-live-preview",
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Zephyr" }
        }
      }
    }
  },
  {
    id: "2.5-native-text-inputTx",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    config: {
      responseModalities: ["TEXT"],
      inputAudioTranscription: {},
      systemInstruction: { parts: [{ text: "Transcribe only." }] }
    }
  },
  {
    id: "2.5-native-audio",
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Zephyr" }
        }
      }
    }
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runCase(testCase) {
  const result = {
    id: testCase.id,
    model: testCase.model,
    opened: false,
    messageSeen: false,
    error: "",
    closeCode: "",
    closeReason: "",
    ok: false
  };

  let session = null;

  try {
    session = await ai.live.connect({
      model: testCase.model,
      config: testCase.config,
      callbacks: {
        onopen: () => {
          result.opened = true;
        },
        onmessage: () => {
          result.messageSeen = true;
        },
        onerror: (e) => {
          result.error = e?.message || String(e) || "unknown-error";
        },
        onclose: (e) => {
          result.closeCode = String(e?.code ?? "");
          result.closeReason = e?.reason || "";
        }
      }
    });

    await sleep(1200);
    session.sendRealtimeInput({ text: "hello" });
    await sleep(1200);
    session.sendRealtimeInput({
      audio: {
        data: Buffer.from(new Int16Array(3200).buffer).toString("base64"),
        mimeType: "audio/pcm;rate=16000"
      }
    });
    await sleep(2200);
    result.ok = result.opened && !result.error && (result.closeCode === "" || result.closeCode === "1000");
  } catch (e) {
    result.error = e?.message || String(e) || "connect-threw";
  } finally {
    try {
      session?.close();
    } catch (_) {
      // no-op
    }
    await sleep(300);
  }

  return result;
}

async function main() {
  const results = [];
  for (const testCase of CASES) {
    const result = await runCase(testCase);
    results.push(result);
  }

  console.log("\nLive API matrix results:");
  for (const r of results) {
    console.log(
      [
        `- ${r.id}`,
        `model=${r.model}`,
        `opened=${r.opened}`,
        `msg=${r.messageSeen}`,
        `ok=${r.ok}`,
        r.closeCode ? `close=${r.closeCode}` : "",
        r.closeReason ? `reason="${r.closeReason}"` : "",
        r.error ? `error="${r.error}"` : ""
      ]
        .filter(Boolean)
        .join(" | ")
    );
  }
}

main().catch((e) => {
  console.error("Matrix run failed:", e?.message || e);
  process.exit(1);
});
