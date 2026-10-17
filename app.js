const MODEL_URL = '/needle/whistle.cact';
const DB_NAME = 'hush-local';
const MODEL_KEY = 'whistle-v1';
const loadingText = document.querySelector('#loadingText');
const appShell = document.querySelector('#appShell');
const progressTrack = document.querySelector('#progressTrack');
const progressFill = document.querySelector('#progressFill');
const retryButton = document.querySelector('#retryButton');
const liveTranscript = document.querySelector('#liveTranscript');
const transcriptText = document.querySelector('#transcriptText');
const clearLink = document.querySelector('#clearLink');
const AUDIO_RATE = 16000;
const FAST_CHUNK_SAMPLES = AUDIO_RATE / 2;
const SAFE_CHUNK_SAMPLES = AUDIO_RATE;
const DEBUG_HOST = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
const DEBUG_QUEUE_LIMIT = 1024 * 1024;
let DEBUG_LOCAL = false;

let inferenceWorker;
let inferenceReady = false;
let captureStream;
let audioContext;
let audioNode;
let sourceNode;
let frames = [];
let samplesBuffered = 0;
let streamChunkSamples = FAST_CHUNK_SAMPLES;
let inferenceBusy = false;
let nextChunkId = 0;
let debugQueue = Promise.resolve();
let pendingDebugAudioBytes = 0;
let debugAudioStopped = false;
let debugFailureReported = false;
let confirmedText = '';
let pendingText = '';
let previousWordEnd = null;
let transcriptGeneration = 0;
let savedText = loadSavedText();
let followTranscript = true;

try { localStorage.removeItem('hush-past'); } catch {}

function reportDebugFailure(error) {
  if (debugFailureReported) return;
  debugFailureReported = true;
  console.warn(`[Kate] Local /debug upload failed; transcription continues (${error?.message || 'request failed'}).`);
}

function enqueueDebug(task) {
  if (!DEBUG_LOCAL) return Promise.resolve();
  debugQueue = debugQueue.then(task).catch(reportDebugFailure);
  return debugQueue;
}

function postDebugRecord(record) {
  if (!DEBUG_LOCAL) return;
  void enqueueDebug(async () => {
    const response = await fetch('/debug', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
}

function recordDebugEvent(event) {
  postDebugRecord({ type: 'event', event: { timestamp: new Date().toISOString(), ...event } });
}

function encodeWavSegment(samples) {
  const wav = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(wav);
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, AUDIO_RATE, true);
  view.setUint32(28, AUDIO_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([wav], { type: 'audio/wav' });
}

function recordDebugAudio(samples, generation) {
  if (!DEBUG_LOCAL || debugAudioStopped || generation !== transcriptGeneration) return;
  const byteLength = 44 + samples.length * 2;
  if (pendingDebugAudioBytes + byteLength > DEBUG_QUEUE_LIMIT) {
    debugAudioStopped = true;
    recordDebugEvent({ level: 'error', message: 'Local debug audio queue exceeded 1 MiB; recording is incomplete.' });
    postDebugRecord({ type: 'incomplete', reason: 'local audio queue overflow' });
    return;
  }
  const blob = encodeWavSegment(samples);
  pendingDebugAudioBytes += byteLength;
  void enqueueDebug(async () => {
    try {
      const response = await fetch('/debug?type=audio', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: blob });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (generation === transcriptGeneration) {
        debugAudioStopped = true;
        postDebugRecord({ type: 'incomplete', reason: 'local audio upload failed' });
      }
      throw error;
    } finally {
      if (generation === transcriptGeneration) pendingDebugAudioBytes = Math.max(0, pendingDebugAudioBytes - byteLength);
    }
  });
}

function clearDebugData() {
  if (!DEBUG_LOCAL) return;
  pendingDebugAudioBytes = 0;
  debugAudioStopped = false;
  debugFailureReported = false;
  void enqueueDebug(async () => {
    const response = await fetch('/debug', { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
}

function publishDebugClient() {
  window.KateDebug = DEBUG_LOCAL ? {
    event: recordDebugEvent,
    words: postDebugRecord,
    audio: recordDebugAudio,
    clear: clearDebugData
  } : undefined;
}

async function detectDebugMode() {
  DEBUG_LOCAL = false;
  publishDebugClient();
  if (!DEBUG_HOST) return;
  try {
    const response = await fetch('/debug?status=1', { cache: 'no-store' });
    if (!response.ok) return;
    DEBUG_LOCAL = (await response.json()).enabled === true;
    publishDebugClient();
  } catch {}
}

window.addEventListener('error', event => recordDebugEvent({ level: 'error', message: event.message || 'Window error', filename: event.filename, line: event.lineno, column: event.colno }));
window.addEventListener('unhandledrejection', event => recordDebugEvent({ level: 'error', message: event.reason?.message || String(event.reason || 'Unhandled promise rejection') }));

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

function keepLatestWords(text, limit) {
  const matches = [...text.matchAll(/\S+/g)];
  if (matches.length <= limit) return text.trim();
  return text.slice(matches[matches.length - limit].index).trim();
}

function clearConversation() {
  if (!window.confirm("You sure about this? It's unrecoverable. Ok to confirm deletion")) return;
  transcriptGeneration++;
  frames = [];
  samplesBuffered = 0;
  confirmedText = '';
  pendingText = '';
  previousWordEnd = null;
  savedText = '';
  followTranscript = true;
  liveTranscript.scrollTop = 0;
  try {
    localStorage.removeItem('hush-transcript');
    localStorage.removeItem('hush-past');
  } catch {}
  audioNode?.port.postMessage({ type: 'reset', generation: transcriptGeneration });
  if (inferenceReady) inferenceWorker?.postMessage({ type: 'clear' });
  clearDebugData();
  renderText();
}

function renderText() {
  const current = [savedText, confirmedText].filter(Boolean).join(' ').trim();
  confirmedText = keepLatestWords(current, 500);
  savedText = '';
  const all = keepLatestWords([confirmedText, pendingText].filter(Boolean).join(' ').trim(), 500);
  transcriptText.textContent = all;
  liveTranscript.hidden = !all;
  try { localStorage.setItem('hush-transcript', confirmedText); } catch {}
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
  inferenceWorker = new Worker(DEBUG_LOCAL ? '/inference-worker.js?debug=1' : '/inference-worker.js');
  let workerReady = false;
  await new Promise((resolve, reject) => {
    inferenceWorker.onmessage = event => {
      const message = event.data;
      if (message.type === 'ready') { workerReady = true; inferenceReady = true; resolve(); }
      else if (message.type === 'error') {
        const error = new Error(message.error);
        if (workerReady) showError(error);
        else reject(error);
      }
      else if (message.type === 'diagnostic') recordDebugEvent(message.event || message);
      else if (message.type === 'result') {
        inferenceBusy = false;
        if (message.generation === transcriptGeneration) {
          recordChunkResult(message.data);
          appendStreamResult(message.data);
        }
        if (samplesBuffered >= streamChunkSamples) drainAudio();
      }
    };
    inferenceWorker.onerror = () => {
      const error = new Error('The speech engine stopped unexpectedly.');
      if (workerReady) showError(error);
      else reject(error);
    };
    const bytes = model.arrayBuffer();
    bytes.then(buffer => inferenceWorker.postMessage({ type: 'init', model: buffer }, [buffer]), reject);
  });
}

function recordChunkResult(data) {
  const rms = Number(data.rms) || 0;
  const speechPercent = Math.round((Number(data.speech_ratio) || 0) * 100);
  const keptPercent = Math.round((Number(data.vad_kept_ratio) || 0) * 100);
  const words = Array.isArray(data.word_decisions)
    ? data.word_decisions
    : Array.isArray(data.words)
    ? data.words
    : data.text ? [{ word: data.text, start: null, end: null, displayed: true }] : [];
  const summary = words.length
    ? `chunk ${data.chunk} · VAD ${speechPercent}% speech, ${keptPercent}% audio passed · RMS ${rms.toFixed(4)}`
    : `chunk ${data.chunk}: no words; VAD ${speechPercent}% speech, ${keptPercent}% audio passed; RMS ${rms.toFixed(4)}`;
  recordDebugEvent({ level: words.length ? 'log' : 'info', message: summary });
  postDebugRecord({
    type: 'words',
    chunk: data.chunk,
    rms,
    speech_ratio: Number(data.speech_ratio) || 0,
    vad_kept_ratio: Number(data.vad_kept_ratio) || 0,
    words
  });
}

function appendStreamResult(data) {
  if (Array.isArray(data.words) && data.words.length) {
    let additions = '';
    for (const item of data.words) {
      const word = typeof item.word === 'string' ? item.word.trim() : '';
      if (!word) continue;
      const start = Number(item.start);
      const end = Number(item.end);
      const hasPriorText = Boolean(confirmedText || additions);
      const gap = previousWordEnd === null || !Number.isFinite(start) ? 0 : start - previousWordEnd;
      if (hasPriorText) additions += gap >= 0.1 ? '\n' : ' ';
      additions += word;
      previousWordEnd = Number.isFinite(end) ? end : null;
    }
    confirmedText += additions;
  } else if (data.text) {
    confirmedText = `${confirmedText} ${data.text}`.trim();
  }
  pendingText = data.pending || '';
  // More frequent passes reduce the wait for two-pass agreement, but can fall
  // behind on slower phones. Adapt the cadence from measured WASM call time.
  const passMs = Math.max(Number(data.pass_ms) || 0, Number(data.wall_ms) || 0);
  if (passMs > 450) streamChunkSamples = SAFE_CHUNK_SAMPLES;
  else if (passMs > 0 && passMs < 300) streamChunkSamples = FAST_CHUNK_SAMPLES;
  renderText();
}

function drainAudio() {
  if (!inferenceWorker || inferenceBusy || samplesBuffered === 0) return;
  const all = new Float32Array(samplesBuffered);
  let offset = 0;
  for (const frame of frames) { all.set(frame, offset); offset += frame.length; }
  let energy = 0;
  for (let i = 0; i < all.length; i++) energy += all[i] * all[i];
  const rms = Math.sqrt(energy / all.length);
  const chunk = ++nextChunkId;
  frames = [];
  samplesBuffered = 0;
  inferenceBusy = true;
  inferenceWorker.postMessage({ type: 'audio', samples: all, rms, chunk, generation: transcriptGeneration }, [all.buffer]);
}

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support microphone capture.');
  captureStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule('/audio-worklet.js');
  if (audioContext.state !== 'running') await audioContext.resume();
  if (audioContext.state !== 'running') throw new Error('Safari paused microphone processing. Tap Try again to resume.');
  sourceNode = audioContext.createMediaStreamSource(captureStream);
  audioNode = new AudioWorkletNode(audioContext, 'pcm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { generation: transcriptGeneration }
  });
  let receivedAudio = false;
  let resolveFirstAudio;
  let rejectFirstAudio;
  let workletDiagnostics = { started: false, blocks: 0, inputChannels: 0, emitted: 0 };
  const firstAudio = new Promise((resolve, reject) => { resolveFirstAudio = resolve; rejectFirstAudio = reject; });
  audioNode.port.onmessage = event => {
    if (event.data?.type === 'started') {
      workletDiagnostics.started = true;
      return;
    }
    if (event.data?.type === 'diagnostic') {
      workletDiagnostics = { ...workletDiagnostics, ...event.data };
      return;
    }
    if (event.data?.generation !== transcriptGeneration) return;
    const pcm = event.data?.samples;
    if (!pcm?.length) return;
    recordDebugAudio(pcm, event.data.generation);
    if (!receivedAudio) {
      receivedAudio = true;
      loadingText.textContent = 'Listening...';
      progressTrack.hidden = true;
      liveTranscript.hidden = false;
      appShell.classList.add('is-listening');
      resolveFirstAudio();
    }
    frames.push(pcm);
    samplesBuffered += pcm.length;
    if (samplesBuffered >= streamChunkSamples) drainAudio();
  };
  audioNode.onprocessorerror = () => rejectFirstAudio(new Error('The browser stopped the microphone audio processor. Tap Try again.'));
  sourceNode.connect(audioNode);
  audioNode.connect(audioContext.destination);
  loadingText.textContent = 'Starting microphone...';
  const track = captureStream.getAudioTracks()[0];
  let timeoutId;
  try {
    await Promise.race([
    firstAudio,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(
          `No microphone audio reached the speech engine (audio ${audioContext.state}; mic ${track?.readyState || 'missing'}${track?.muted ? ', muted' : ''}; worklet ${workletDiagnostics.started ? `${workletDiagnostics.blocks} blocks, ${workletDiagnostics.inputChannels} input channels, ${workletDiagnostics.emitted} chunks` : 'not started'}). Check microphone access and try again.`
        )), 5000);
      })
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function boot() {
  retryButton.hidden = true;
  progressTrack.hidden = false;
  await detectDebugMode();
  await ensureModel();
  await startListening();
}

function stopListening() {
  captureStream?.getTracks().forEach(track => track.stop());
  sourceNode?.disconnect();
  audioNode?.disconnect();
  if (audioContext && audioContext.state !== 'closed') audioContext.close();
  captureStream = audioContext = audioNode = sourceNode = null;
  inferenceWorker?.terminate();
  inferenceWorker = null;
  inferenceReady = false;
  inferenceBusy = false;
  frames = [];
  samplesBuffered = 0;
}

function showError(error) {
  recordDebugEvent({ level: 'error', message: error?.message || 'Something went wrong.', stack: error?.stack });
  stopListening();
  loadingText.textContent = error?.message || 'Something went wrong. Please try again.';
  progressTrack.hidden = false;
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = '0';
  retryButton.hidden = false;
}

retryButton.addEventListener('click', () => boot().catch(showError));
clearLink.addEventListener('click', clearConversation);
liveTranscript.addEventListener('scroll', () => {
  const distance = liveTranscript.scrollHeight - liveTranscript.clientHeight - liveTranscript.scrollTop;
  followTranscript = distance < 36;
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (savedText) renderText();
boot().catch(showError);
