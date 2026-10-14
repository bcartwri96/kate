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
const pastLink = document.querySelector('#pastLink');
const pastTranscript = document.querySelector('#pastTranscript');
const AUDIO_RATE = 16000;
const FAST_CHUNK_SAMPLES = AUDIO_RATE / 2;
const SAFE_CHUNK_SAMPLES = AUDIO_RATE;

let inferenceWorker;
let captureStream;
let audioContext;
let audioNode;
let sourceNode;
let frames = [];
let samplesBuffered = 0;
let streamChunkSamples = FAST_CHUNK_SAMPLES;
let inferenceBusy = false;
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
  inferenceWorker = new Worker('/inference-worker.js');
  let workerReady = false;
  await new Promise((resolve, reject) => {
    inferenceWorker.onmessage = event => {
      const message = event.data;
      if (message.type === 'ready') { workerReady = true; resolve(); }
      else if (message.type === 'error') {
        const error = new Error(message.error);
        if (workerReady) showError(error);
        else reject(error);
      }
      else if (message.type === 'result') {
        inferenceBusy = false;
        appendStreamResult(message.data);
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

function drainAudio() {
  if (!inferenceWorker || inferenceBusy || samplesBuffered === 0) return;
  const all = new Float32Array(samplesBuffered);
  let offset = 0;
  for (const frame of frames) { all.set(frame, offset); offset += frame.length; }
  frames = [];
  samplesBuffered = 0;
  inferenceBusy = true;
  inferenceWorker.postMessage({ type: 'audio', samples: all }, [all.buffer]);
}

async function startListening() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support microphone capture.');
  captureStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule('/audio-worklet.js');
  if (audioContext.state !== 'running') await audioContext.resume();
  if (audioContext.state !== 'running') throw new Error('Safari paused microphone processing. Tap Try again to resume.');
  sourceNode = audioContext.createMediaStreamSource(captureStream);
  audioNode = new AudioWorkletNode(audioContext, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  let receivedAudio = false;
  let resolveFirstAudio;
  const firstAudio = new Promise(resolve => { resolveFirstAudio = resolve; });
  audioNode.port.onmessage = event => {
    const pcm = event.data?.samples;
    if (!pcm?.length) return;
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
  audioNode.onprocessorerror = () => showError(new Error('Safari could not process microphone audio. Tap Try again.'));
  sourceNode.connect(audioNode);
  audioNode.connect(audioContext.destination);
  loadingText.textContent = 'Starting microphone...';
  await Promise.race([
    firstAudio,
    new Promise((_, reject) => setTimeout(() => reject(new Error('No microphone audio is reaching the speech engine. Check microphone access and tap Try again.')), 5000))
  ]);
}

async function boot() {
  retryButton.hidden = true;
  progressTrack.hidden = false;
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
  inferenceBusy = false;
  frames = [];
  samplesBuffered = 0;
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
