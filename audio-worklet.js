class PcmCapture extends AudioWorkletProcessor {
  constructor(options) { super(); this.targetRate = options.processorOptions?.targetRate || 16000; this.ratio = sampleRate / this.targetRate; this.buffer = []; this.nextSample = 0; }
  process(inputs) {
    const input = inputs[0]?.[0]; if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      if (i >= this.nextSample) { this.buffer.push(input[i]); this.nextSample += this.ratio; }
    }
    this.nextSample -= input.length;
    // Half-second frames let the UI surface Whistle's pending hypothesis sooner.
    if (this.buffer.length >= 8000) { this.port.postMessage({ samples: new Float32Array(this.buffer.splice(0, 8000)) }); }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
