class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(1600);
    this.bufferIndex = 0;
    this.sourceRate = sampleRateFromGlobalScope();
    this.targetRate = 16000;
    this.resampleRatio = this.sourceRate / this.targetRate;
    this.resampleCursor = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }

    const channelData = input[0];
    // Precise fractional resampling so 44.1kHz and 48kHz both map correctly to 16kHz.
    while (this.resampleCursor < channelData.length) {
      const i0 = Math.floor(this.resampleCursor);
      const i1 = Math.min(i0 + 1, channelData.length - 1);
      const frac = this.resampleCursor - i0;
      const sample = channelData[i0] + (channelData[i1] - channelData[i0]) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.buffer[this.bufferIndex] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      this.bufferIndex += 1;

      if (this.bufferIndex >= this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.bufferIndex = 0;
      }

      this.resampleCursor += this.resampleRatio;
    }

    this.resampleCursor -= channelData.length;
    return true;
  }
}

function sampleRateFromGlobalScope() {
  return globalThis.sampleRate || 48000;
}

registerProcessor("pcm-processor", PCMProcessor);
