importScripts('/needle/needle.js');

let engine;

async function fetchWasmBinary() {
  const response = await fetch('/needle/needle.wasm', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load Needle WASM (${response.status}).`);
  const contentType = response.headers.get('content-type') || 'unknown content type';
  const bytes = await response.arrayBuffer();
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (signature.length !== 4 || signature[0] !== 0 || signature[1] !== 0x61 || signature[2] !== 0x73 || signature[3] !== 0x6d) {
    throw new Error(`Needle WASM URL returned non-WASM data (${contentType}); refresh the app to update its cached files.`);
  }
  return bytes;
}

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
      const wasmBinary = await fetchWasmBinary();
      engine = await self.createNeedle({ wasmBinary, locateFile: name => `/needle/${name}` });
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
        self.postMessage({ type: 'result', data, generation: message.generation });
      } finally {
        engine._free(inputPtr);
        engine._free(outputPtr);
      }
    }

    if (message.type === 'clear') {
      const outputPtr = engine._malloc(65536);
      if (!outputPtr) throw new Error('Not enough memory to clear the conversation.');
      try {
        const result = engine.ccall(
          'needle_stream_transcribe_stop',
          'number',
          ['number', 'number'],
          [outputPtr, 65536]
        );
        if (result < 0) {
          const detail = engine.ccall('needle_last_error', 'string', [], []);
          throw new Error(detail || 'Could not reset the speech stream.');
        }
      } finally {
        engine._free(outputPtr);
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', error: error?.message || 'Speech engine failed.' });
  }
};
