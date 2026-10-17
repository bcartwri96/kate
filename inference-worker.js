let engine;
let vad;
let vadMemory;
let vadFramePointer;
let vadFrameCount = 0;
let lastVoiceFrame = -Infinity;
let positiveFrameStreak = 0;
const VAD_FRAME_SAMPLES = 160;
const VAD_MODE = 3;
const VAD_MIN_FRAME_RMS = 0.0015;
const VAD_REQUIRED_STREAK = 2;
const VAD_WORD_OVERLAP = 0.15;
const VAD_HISTORY_FRAMES = 30000; // Five minutes at 10 ms per frame.
const VAD_PREROLL_FRAMES = 10;
const VAD_HANGOVER_FRAMES = 20;
const vadHistory = new Uint8Array(VAD_HISTORY_FRAMES);

if (new URL(self.location.href).searchParams.get('debug') === '1') installDiagnosticConsole();
importScripts('/needle/needle.js');

function installDiagnosticConsole() {
  for (const level of ['debug', 'log', 'info', 'warn', 'error', 'table', 'group', 'groupCollapsed', 'trace']) {
    if (typeof console[level] !== 'function') continue;
    console[level] = (...args) => {
      const message = args.map(value => {
        if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (value == null) return String(value);
        if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.length}]`;
        try {
          return JSON.stringify(value, (key, item) => {
            if (ArrayBuffer.isView(item)) return `[${item.constructor.name} ${item.length}]`;
            if (item instanceof ArrayBuffer) return `[ArrayBuffer ${item.byteLength}]`;
            if (/^(audio|pcm|samples)$/i.test(key)) return '[audio omitted]';
            if (Array.isArray(item) && item.length > 100) return `[Array ${item.length}]`;
            return item;
          });
        } catch { return Object.prototype.toString.call(value); }
      }).join(' ').slice(0, 4000);
      self.postMessage({ type: 'diagnostic', event: { level, message } });
    };
  }
}

async function initializeVad() {
  const { default: createFvadModule } = await import('/vad/fvad.js');
  vadMemory = await createFvadModule();
  vad = vadMemory._fvad_new();
  if (!vad) throw new Error('Could not initialize WebRTC VAD.');
  if (vadMemory._fvad_set_sample_rate(vad, 16000) !== 0) {
    throw new Error('WebRTC VAD rejected the audio sample rate.');
  }
  if (vadMemory._fvad_set_mode(vad, VAD_MODE) !== 0) {
    throw new Error('WebRTC VAD rejected its sensitivity setting.');
  }
  vadFramePointer = vadMemory._malloc(VAD_FRAME_SAMPLES * 2);
  if (!vadFramePointer) throw new Error('Could not allocate WebRTC VAD audio memory.');
  self.postMessage({
    type: 'diagnostic',
    event: {
      level: 'info',
      message: `WebRTC VAD ready · WASM · mode ${VAD_MODE} · 10 ms frames · RMS floor ${VAD_MIN_FRAME_RMS} · ${VAD_REQUIRED_STREAK} consecutive frames · ${Math.round(VAD_WORD_OVERLAP * 100)}% word overlap · 100 ms lead-in · 200 ms tail`
    }
  });
}

function processVad(samples) {
  if (samples.length % VAD_FRAME_SAMPLES !== 0) {
    throw new Error('Audio block does not align to a 10 ms VAD frame.');
  }
  const frameTotal = samples.length / VAD_FRAME_SAMPLES;
  const decisions = new Uint8Array(frameTotal);
  const heapOffset = vadFramePointer >> 1;
  const firstFrame = vadFrameCount;
  const priorVoiceFrame = lastVoiceFrame;
  let voicedFrames = 0;

  for (let frame = 0; frame < frameTotal; frame++) {
    let cursor = heapOffset;
    const offset = frame * VAD_FRAME_SAMPLES;
    let energy = 0;
    for (let i = 0; i < VAD_FRAME_SAMPLES; i++) {
      const sample = samples[offset + i];
      energy += sample * sample;
      const scaled = Math.round(sample * 32768);
      vadMemory.HEAP16[cursor++] = Math.max(-32768, Math.min(32767, scaled));
    }
    const result = vadMemory._fvad_process(vad, vadFramePointer, VAD_FRAME_SAMPLES);
    if (result < 0) throw new Error('WebRTC VAD could not process an audio frame.');
    const energetic = Math.sqrt(energy / VAD_FRAME_SAMPLES) >= VAD_MIN_FRAME_RMS;
    positiveFrameStreak = result && energetic ? positiveFrameStreak + 1 : 0;
    const accepted = result && energetic && positiveFrameStreak >= VAD_REQUIRED_STREAK;
    decisions[frame] = accepted ? 1 : 0;
    voicedFrames += decisions[frame];
    vadHistory[(firstFrame + frame) % VAD_HISTORY_FRAMES] = decisions[frame];
    if (accepted) {
      lastVoiceFrame = firstFrame + frame;
    }
  }

  const filtered = new Float32Array(samples.length);
  let keptSamples = 0;
  let voiceFrameSoFar = priorVoiceFrame;
  for (let frame = 0; frame < frameTotal; frame++) {
    const absoluteFrame = firstFrame + frame;
    if (decisions[frame]) voiceFrameSoFar = absoluteFrame;
    let hasUpcomingVoice = false;
    const upcomingEnd = Math.min(frameTotal - 1, frame + VAD_PREROLL_FRAMES);
    for (let next = frame; next <= upcomingEnd; next++) {
      if (decisions[next]) { hasUpcomingVoice = true; break; }
    }
    const keep = decisions[frame] || absoluteFrame - voiceFrameSoFar <= VAD_HANGOVER_FRAMES || hasUpcomingVoice;
    if (!keep) continue;
    const offset = frame * VAD_FRAME_SAMPLES;
    filtered.set(samples.subarray(offset, offset + VAD_FRAME_SAMPLES), offset);
    keptSamples += VAD_FRAME_SAMPLES;
  }

  vadFrameCount += frameTotal;
  return {
    samples: filtered,
    voicedRatio: frameTotal ? voicedFrames / frameTotal : 0,
    keptRatio: samples.length ? keptSamples / samples.length : 0,
    recentVoice: vadFrameCount - 1 - lastVoiceFrame <= 50
  };
}

function wordOverlapsVoice(word, fallback) {
  if (word?.start == null || word?.end == null) return fallback;
  const start = Number(word?.start);
  const end = Number(word?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fallback;

  let first = Math.floor(Math.max(0, Math.min(start, end)) * 100);
  let last = Math.ceil(Math.max(start, end) * 100);
  // Needle can assign a zero-length timestamp to short words. Look nearby in
  // the VAD timeline so punctuation and brief words are checked fairly.
  if (last <= first) { first -= 5; last += 5; }
  first = Math.max(0, first);
  last = Math.max(first + 1, last);

  const oldestAvailable = Math.max(0, vadFrameCount - VAD_HISTORY_FRAMES);
  if (first < oldestAvailable) return true;
  let voiced = 0;
  const availableLast = Math.min(last, vadFrameCount);
  for (let frame = first; frame < availableLast; frame++) {
    voiced += vadHistory[frame % VAD_HISTORY_FRAMES];
  }
  const checkedFrames = Math.max(1, availableLast - first);
  return voiced >= Math.max(2, Math.ceil(checkedFrames * VAD_WORD_OVERLAP));
}

function applyVadToResult(data, vadResult) {
  const rawWords = Array.isArray(data.words) ? data.words : [];
  const fallback = vadResult.recentVoice;
  const decisions = rawWords.length
    ? rawWords.map(word => ({ ...word, displayed: wordOverlapsVoice(word, fallback) }))
    : data.text ? [{ word: data.text, start: null, end: null, displayed: fallback }] : [];
  data.word_decisions = decisions;
  data.words = rawWords.length ? decisions.filter(word => word.displayed) : [];
  if (rawWords.length) data.text = data.words.map(word => word.word).filter(Boolean).join(' ');
  else if (data.text && !fallback) data.text = '';
  if (!vadResult.recentVoice) data.pending = '';
  data.speech_ratio = vadResult.voicedRatio;
  data.vad_kept_ratio = vadResult.keptRatio;
}

function resetVad() {
  vadMemory._fvad_reset(vad);
  vadMemory._fvad_set_sample_rate(vad, 16000);
  vadMemory._fvad_set_mode(vad, VAD_MODE);
  vadFrameCount = 0;
  lastVoiceFrame = -Infinity;
  positiveFrameStreak = 0;
  vadHistory.fill(0);
}

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
      await initializeVad();
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
      const startedAt = performance.now();
      const vadResult = processVad(samples);
      const speechSamples = vadResult.samples;
      const inputPtr = engine._malloc(speechSamples.byteLength);
      const outputPtr = engine._malloc(65536);
      if (!inputPtr || !outputPtr) {
        if (inputPtr) engine._free(inputPtr);
        if (outputPtr) engine._free(outputPtr);
        throw new Error('Not enough memory to process audio.');
      }
      try {
        new Float32Array(engine.HEAPU8.buffer).set(speechSamples, inputPtr >> 2);
        const result = engine.ccall(
          'needle_stream_transcribe_process',
          'number',
          ['number', 'number', 'string', 'string', 'number', 'number'],
          [inputPtr, speechSamples.length, 'en', null, outputPtr, 65536]
        );
        const data = readResult(result, outputPtr);
        data.wall_ms = performance.now() - startedAt;
        data.rms = message.rms;
        data.chunk = message.chunk;
        applyVadToResult(data, vadResult);
        self.postMessage({ type: 'result', data, generation: message.generation });
      } finally {
        engine._free(inputPtr);
        engine._free(outputPtr);
      }
    }

    if (message.type === 'clear') {
      resetVad();
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
