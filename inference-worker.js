importScripts('/needle/needle.js');

let engine;

function readResult(result, outputPtr) {
  if (result < 0) {
    const detail = engine.ccall('needle_last_error', 'string', [], []);
    throw new Error(detail || 'Transcription failed.');
  }
  return JSON.parse(engine.UTF8ToString(outputPtr));
}

self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      engine = await self.createNeedle({ locateFile: name => `/needle/${name}` });
      const model = new Uint8Array(message.model);
      const modelPtr = engine._malloc(model.length);
      if (!modelPtr) throw new Error('Not enough memory to load Whistle.');
      try {
        engine.HEAPU8.set(model, modelPtr);
        const loaded = engine._needle_load(modelPtr, BigInt(model.length));
        if (loaded < 0) {
          const detail = engine.ccall('needle_last_error', 'string', [], []);
          throw new Error(detail || 'Needle could not load Whistle.');
        }
      } finally {
        engine._free(modelPtr);
      }
      self.postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'audio') {
      const samples = message.samples;
      const inputPtr = engine._malloc(samples.byteLength);
      const outputPtr = engine._malloc(65536);
      if (!inputPtr || !outputPtr) {
        if (inputPtr) engine._free(inputPtr);
        if (outputPtr) engine._free(outputPtr);
        throw new Error('Not enough memory to process audio.');
      }
      try {
        new Float32Array(engine.HEAPU8.buffer).set(samples, inputPtr >> 2);
        const startedAt = performance.now();
        const result = engine.ccall(
          'needle_stream_transcribe_process',
          'number',
          ['number', 'number', 'string', 'string', 'number', 'number'],
          [inputPtr, samples.length, 'en', null, outputPtr, 65536]
        );
        const data = readResult(result, outputPtr);
        data.wall_ms = performance.now() - startedAt;
        self.postMessage({ type: 'result', data });
      } finally {
        engine._free(inputPtr);
        engine._free(outputPtr);
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'Speech engine failed.' });
  }
};
