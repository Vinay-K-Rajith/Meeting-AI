import { GoogleGenAI } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
let session = null;
let gotMessage = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

session = await ai.live.connect({
  model: "gemini-3.1-flash-live-preview",
  config: {
    responseModalities: ["AUDIO"],
    inputAudioTranscription: {},
    systemInstruction: { parts: [{ text: "Transcribe user speech. Keep responses short." }] },
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }
    }
  },
  callbacks: {
    onopen: () => {
      console.log("open");
    },
    onmessage: (m) => {
      gotMessage = true;
      const sc = m?.serverContent || {};
      console.log(
        "msg",
        JSON.stringify({
          hasModelTurn: Boolean(sc.modelTurn),
          hasInputTx: Boolean(sc.inputTranscription?.text),
          hasOutputTx: Boolean(sc.outputTranscription?.text),
          turnComplete: Boolean(sc.turnComplete)
        })
      );
    },
    onerror: (e) => {
      console.log("error", e?.message || "unknown");
    },
    onclose: (e) => {
      console.log("close", e?.code, e?.reason || "");
    }
  }
});

await sleep(1200);
session.sendRealtimeInput({ text: "hello from probe" });
await sleep(1200);
session.sendRealtimeInput({
  audio: {
    data: Buffer.from(new Int16Array(3200).buffer).toString("base64"),
    mimeType: "audio/pcm;rate=16000"
  }
});
await sleep(3000);
session.close();
await sleep(300);
if (!gotMessage) {
  process.exit(2);
}
