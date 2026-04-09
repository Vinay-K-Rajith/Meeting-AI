class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(1600);
    this.bufferIndex = 0;
    this.downsampleAccumulator = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const channelData = input[0];
    const sampleRate = sampleRateFromGlobalScope();
    const needsDownsample = sampleRate > 16000;
    const ratio = needsDownsample ? Math.round(sampleRate / 16000) : 1;

    for (let i = 0; i < channelData.length; i += 1) {
      if (needsDownsample) {
        this.downsampleAccumulator += 1;
        if (this.downsampleAccumulator < ratio) {
          continue;
        }
        this.downsampleAccumulator = 0;
      }

      const clamped = Math.max(-1, Math.min(1, channelData[i]));
      this.buffer[this.bufferIndex] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      this.bufferIndex += 1;

      if (this.bufferIndex >= this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

function sampleRateFromGlobalScope() {
  return globalThis.sampleRate || 48000;
}

registerProcessor("pcm-processor", PCMProcessor);
