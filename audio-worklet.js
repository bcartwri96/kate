class PcmCapture extends AudioWorkletProcessor {
  constructor(options) { super(); this.targetRate = options.processorOptions?.targetRate || 16000; this.ratio = sampleRate / this.targetRate; this.buffer = new Float32Array(8000); this.buffered = 0; this.nextSample = 0; }
  process(inputs) {
    const input = inputs[0]?.[0]; if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      if (i >= this.nextSample) { this.buffer[this.buffered++] = input[i]; this.nextSample += this.ratio; }
    }
    this.nextSample -= input.length;
    if (this.buffered === this.buffer.length) {
      const samples = this.buffer;
      this.buffer = new Float32Array(8000);
      this.buffered = 0;
      this.port.postMessage({ samples }, [samples.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
