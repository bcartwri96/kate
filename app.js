const MODEL_URL = '/needle/whistle.cact';
const ENGINE_BASE = '/needle';
const DB_NAME = 'hush-local';
const MODEL_KEY = 'whistle-v1';
const loadingText = document.querySelector('#loadingText');
const progressTrack = document.querySelector('#progressTrack');
const progressFill = document.querySelector('#progressFill');
const retryButton = document.querySelector('#retryButton');
const liveTranscript = document.querySelector('#liveTranscript');
const transcriptText = document.querySelector('#transcriptText');
const pastLink = document.querySelector('#pastLink');
const pastTranscript = document.querySelector('#pastTranscript');
const AUDIO_RATE = 16000;
const FAST_CHUNK_SAMPLES = AUDIO_RATE / 2;
const SAFE_CHUNK_SAMPLES = AUDIO_RATE;

let engine;
let captureStream;
let audioContext;
let audioNode;
let sourceNode;
let frames = [];
let samplesBuffered = 0;
let streamChunkSamples = FAST_CHUNK_SAMPLES;
let streamTimer;
let confirmedText = '';
let pendingText = '';
let archivedText = loadArchivedText();
let savedText = loadSavedText();
let followTranscript = true;

function updateProgress(loaded, total) {
  if (!total) {
    progressFill.classList.add('indeterminate');
    progressTrack.removeAttribute('aria-valuenow');
    loadingText.textContent = 'Downloading model...';
    return;
  }
  const percent = Math.min(100, Math.round(loaded / total * 100));
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = `${percent}%`;
  progressTrack.setAttribute('aria-valuenow', String(percent));
  loadingText.textContent = percent === 100 ? 'Starting transcription...' : `Downloading model... ${percent}%`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('assets');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Local model storage is unavailable.'));
  });
}

async function getAsset(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('assets').objectStore('assets').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putAsset(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('assets', 'readwrite').objectStore('assets').put(value, key);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error || new Error('Could not cache model locally.'));
  });
}

function loadSavedText() {
  try { return localStorage.getItem('hush-transcript') || ''; } catch { return ''; }
}

function loadArchivedText() {
  try { return localStorage.getItem('hush-past') || ''; } catch { return ''; }
}

function keepLatestWords(text, limit) {
  const words = text.trim().split(/\s+/);
  if (words.length <= limit) return [text.trim(), ''];
  const splitAt = words.length - limit;
  return [words.slice(splitAt).join(' '), words.slice(0, splitAt).join(' ')];
}

function updatePast() {
  pastTranscript.hidden = !pastTranscript.hidden;
  pastLink.setAttribute('aria-expanded', String(!pastTranscript.hidden));
}

function renderText() {
  const current = [savedText, confirmedText].filter(Boolean).join(' ').trim();
  const [confirmed, newlyArchived] = keepLatestWords(current, 500);
  if (newlyArchived) {
    archivedText = [archivedText, newlyArchived].filter(Boolean).join(' ').trim();
    savedText = '';
    confirmedText = confirmed;
    try { localStorage.setItem('hush-past', archivedText); } catch {}
  }
  const all = [confirmed, pendingText].filter(Boolean).join(' ').trim();
  transcriptText.textContent = all;
  liveTranscript.hidden = !all;
  pastLink.hidden = !archivedText;
  pastTranscript.textContent = archivedText;
  try { localStorage.setItem('hush-transcript', [savedText, confirmedText].filter(Boolean).join(' ').trim()); } catch {}
  if (followTranscript) liveTranscript.scrollTop = liveTranscript.scrollHeight;
}

async function readResponse(response) {
  if (!response.ok) throw new Error(`Could not download Whistle (${response.status}).`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body?.getReader) {
    const blob = await response.blob();
    updateProgress(blob.size, total || blob.size);
    return blob;
  }
  const reader = response.body.getReader();
  const parts = [];
  let loaded = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    updateProgress(loaded, total);
  }
  updateProgress(loaded, total || loaded);
  return new Blob(parts, { type: 'application/octet-stream' });
}

async function loadEngineScript() {
  if (window.createNeedle) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${ENGINE_BASE}/needle.js`;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the Needle WASM runtime.'));
    document.head.append(script);
  });
  if (!window.createNeedle) throw new Error('Needle WASM runtime did not initialize.');
}

function loadCact(module, bytes) {
  const ptr = module._malloc(bytes.length);
  if (!ptr) throw new Error('Not enough memory to load Whistle.');
  try {
    module.HEAPU8.set(bytes, ptr);
    const result = module._needle_load(ptr, BigInt(bytes.length));
    if (result < 0) {
      const detail = module.ccall('needle_last_error', 'string', [], []);
      throw new Error(detail || 'Needle could not load Whistle.');
    }
  } finally {
    module._free(ptr);
  }
}

async function ensureModel() {
  loadingText.textContent = 'Checking this device...';
  progressFill.classList.add('indeterminate');
  progressFill.style.width = '';
  let model = await getAsset(MODEL_KEY).catch(() => null);
  if (!model) {
    const response = await fetch(MODEL_URL);
    model = await readResponse(response);
    try { await putAsset(MODEL_KEY, model); } catch { /* Use the downloaded bytes for this session. */ }
  } else {
    updateProgress(1, 1);
  }

  loadingText.textContent = 'Loading speech engine...';
  progressFill.classList.add('indeterminate');
  progressFill.style.width = '';
  await loadEngineScript();
  engine = await window.createNeedle({ locateFile: name => `${ENGINE_BASE}/${name}` });
  const bytes = new Uint8Array(await model.arrayBuffer());
  loadCact(engine, bytes);
}

function parseApiResult(result, bufferPtr, module) {
  if (result < 0) {
    const detail = module.ccall('needle_last_error', 'string', [], []);
    throw new Error(detail || 'Transcription failed.');
  }
  return JSON.parse(module.UTF8ToString(bufferPtr));
}

function streamProcess(samples) {
  const inputPtr = engine._malloc(samples.byteLength);
  const outputPtr = engine._malloc(65536);
  if (!inputPtr || !outputPtr) throw new Error('Not enough memory to process audio.');
  try {
    new Float32Array(engine.HEAPU8.buffer).set(samples, inputPtr >> 2);
    const count = engine.ccall('needle_stream_transcribe_process', 'number', ['number', 'number', 'string', 'string', 'number', 'number'], [inputPtr, samples.length, 'en', null, outputPtr, 65536]);
    return parseApiResult(count, outputPtr, engine);
  } finally {
    engine._free(inputPtr);
    engine._free(outputPtr);
  }
}

function streamStop() {
  const outputPtr = engine._malloc(65536);
  if (!outputPtr) return null;
  try {
    const count = engine._needle_stream_transcribe_stop(outputPtr, 65536);
    return parseApiResult(count, outputPtr, engine);
  } finally { engine._free(outputPtr); }
}

function appendStreamResult(data) {
  if (data.text) confirmedText = `${confirmedText} ${data.text}`.trim();
  pendingText = data.pending || '';
  // More frequent passes reduce the wait for two-pass agreement, but can fall
  // behind on slower phones. Adapt the cadence from measured WASM call time.
  const passMs = Math.max(Number(data.pass_ms) || 0, Number(data.wall_ms) || 0);
  if (passMs > 450) streamChunkSamples = SAFE_CHUNK_SAMPLES;
  else if (passMs > 0 && passMs < 300) streamChunkSamples = FAST_CHUNK_SAMPLES;
  renderText();
}

async function drainAudio() {
  if (!engine || samplesBuffered === 0) return;
  const all = new Float32Array(samplesBuffered);
  let offset = 0;
  for (const frame of frames) { all.set(frame, offset); offset += frame.length; }
  frames = [];
  samplesBuffered = 0;
  // Keep this drain's boundaries stable if the model changes cadence midway.
  const chunkSamples = streamChunkSamples;
  // Process short slices as they arrive so stable and pending text can refresh
  // faster than the C API's 30-second per-call upper bound.
  for (let start = 0; start < all.length; start += chunkSamples) {
    const startedAt = performance.now();
    const data = streamProcess(all.subarray(start, Math.min(start + chunkSamples, all.length)));
    data.wall_ms = performance.now() - startedAt;
    appendStreamResult(data);
  }
}

function makeWorklet() {
  const source = `class Capture extends AudioWorkletProcessor{constructor(){super();this.ratio=sampleRate/16000;this.next=0;this.out=[]}process(inputs){const a=inputs[0]?.[0];if(!a)return true;for(let i=0;i<a.length;i++){if(i>=this.next){this.out.push(a[i]);this.next+=this.ratio}}this.next-=a.length;if(this.out.length>=1600){this.port.postMessage(new Float32Array(this.out.splice(0,1600)))}return true}}registerProcessor('hush-capture',Capture);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  return audioContext.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
}

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support microphone capture.');
  captureStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule('/audio-worklet.js');
  sourceNode = audioContext.createMediaStreamSource(captureStream);
  audioNode = new AudioWorkletNode(audioContext, 'pcm-capture');
  audioNode.port.onmessage = event => {
    const pcm = event.data?.samples;
    if (!pcm?.length) return;
    frames.push(pcm);
    samplesBuffered += pcm.length;
    if (samplesBuffered >= streamChunkSamples) drainAudio().catch(showError);
  };
  sourceNode.connect(audioNode);
  loadingText.textContent = 'Listening...';
  progressTrack.hidden = true;
  liveTranscript.hidden = false;
}

async function boot() {
  retryButton.hidden = true;
  progressTrack.hidden = false;
  await ensureModel();
  await startListening();
}

function stopListening() {
  clearInterval(streamTimer);
  captureStream?.getTracks().forEach(track => track.stop());
  sourceNode?.disconnect();
  audioNode?.disconnect();
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  captureStream = audioContext = audioNode = sourceNode = null;
}

function showError(error) {
  console.error(error);
  stopListening();
  loadingText.textContent = error?.message || 'Something went wrong. Please try again.';
  progressTrack.hidden = false;
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = '0';
  retryButton.hidden = false;
}

retryButton.addEventListener('click', () => boot().catch(showError));
pastLink.addEventListener('click', event => { event.preventDefault(); updatePast(); });
liveTranscript.addEventListener('scroll', () => {
  const distance = liveTranscript.scrollHeight - liveTranscript.clientHeight - liveTranscript.scrollTop;
  followTranscript = distance < 36;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (savedText) renderText();
boot().catch(showError);
