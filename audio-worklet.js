class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;
    this.buffer = new Float32Array(8000);
    this.buffered = 0;
    this.nextSample = 0;
    this.blocks = 0;
    this.emitted = 0;
    this.port.postMessage({ type: 'started', sampleRate });
  }
  process(inputs, outputs) {
    this.blocks++;
    // Keep the processor in the active audio graph without monitoring the mic.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const inputChannels = inputs[0]?.length || 0;
    const input = inputs[0]?.[0];
    if ((this.blocks & 127) === 0) this.port.postMessage({ type: 'diagnostic', blocks: this.blocks, inputChannels, emitted: this.emitted });
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      if (i >= this.nextSample) {
        this.buffer[this.buffered++] = input[i];
        this.nextSample += this.ratio;
        if (this.buffered === this.buffer.length) {
          const samples = this.buffer;
          this.buffer = new Float32Array(8000);
          this.buffered = 0;
          this.emitted++;
          this.port.postMessage({ samples }, [samples.buffer]);
        }
      }
    }
    this.nextSample -= input.length;
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
