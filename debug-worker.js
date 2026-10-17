const MAX_JSON_BYTES = 64 * 1024;
const MAX_EVENTS = 5000;
const MAX_WORDS = 10000;
const MAX_AUDIO_BYTES = 19_200_000;

let session = createSession();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isDebugPath = url.pathname === '/debug' || url.pathname.startsWith('/debug/');
    if (isDebugPath) {
      if (env.DEBUG !== '1' || !isLoopback(url.hostname)) return new Response('Not found', { status: 404 });
      if (url.pathname !== '/debug') return new Response('Not found', { status: 404 });
      return handleDebugRequest(request, url);
    }
    return env.ASSETS.fetch(request);
  }
};

function createSession() {
  return { events: [], words: [], wordCount: 0, audioParts: [], audioBytes: 0, incomplete: false };
}

async function handleDebugRequest(request, url) {
  if (request.method === 'GET') {
    if (url.searchParams.get('audio') === '1') return getAudioResponse();
    return jsonResponse({
      events: session.events,
      words: session.words,
      audio: {
        available: session.audioBytes > 0,
        url: '/debug?audio=1',
        duration_seconds: session.audioBytes / 32000,
        bytes: session.audioBytes
      },
      incomplete: session.incomplete
    });
  }

  if (request.method === 'DELETE') {
    session = createSession();
    return new Response(null, { status: 204 });
  }

  if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, POST, DELETE' } });
  if (url.searchParams.get('type') === 'audio') return appendAudio(request);
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return new Response('Expected application/json.', { status: 415 });
  }

  const body = await readBoundedBody(request, MAX_JSON_BYTES);
  if (body.oversized) {
    session.incomplete = true;
    return new Response('Diagnostic request exceeds 64 KiB.', { status: 413 });
  }

  let record;
  try {
    record = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return new Response('Malformed JSON.', { status: 400 });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return new Response('Expected a JSON object.', { status: 400 });

  if (record.type === 'event') {
    if (!record.event || typeof record.event !== 'object' || Array.isArray(record.event)) return new Response('Expected an event object.', { status: 400 });
    if (session.events.length >= MAX_EVENTS) {
      session.incomplete = true;
      return new Response('Diagnostic event limit reached.', { status: 413 });
    }
    session.events.push(record.event);
    return new Response(null, { status: 204 });
  }

  if (record.type === 'words') {
    if (!Array.isArray(record.words)) return new Response('Expected a words array.', { status: 400 });
    if (session.wordCount + record.words.length > MAX_WORDS) {
      session.incomplete = true;
      return new Response('Diagnostic word limit reached.', { status: 413 });
    }
    const { type, ...wordRecord } = record;
    session.words.push(wordRecord);
    session.wordCount += record.words.length;
    return new Response(null, { status: 204 });
  }

  return new Response('Unsupported diagnostic record type.', { status: 400 });
}

async function appendAudio(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('audio/wav')) {
    return new Response('Expected audio/wav.', { status: 415 });
  }
  const body = await readBoundedBody(request, MAX_AUDIO_BYTES + 44);
  if (body.oversized) {
    session.incomplete = true;
    return new Response('Audio session exceeds ten minutes.', { status: 413 });
  }
  const pcm = parsePcmWav(body.bytes);
  if (!pcm) return new Response('Expected mono 16 kHz PCM16 WAV audio.', { status: 400 });
  if (session.audioBytes + pcm.byteLength > MAX_AUDIO_BYTES) {
    session.incomplete = true;
    return new Response('Audio session exceeds ten minutes.', { status: 413 });
  }
  session.audioParts.push(pcm);
  session.audioBytes += pcm.byteLength;
  return new Response(null, { status: 204 });
}

function parsePcmWav(bytes) {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' || ascii(36, 4) !== 'data') return null;
  const pcmLength = bytes.byteLength - 44;
  if (view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 16000 ||
      view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== pcmLength || pcmLength % 2 !== 0) return null;
  return bytes.slice(44);
}

function getAudioResponse() {
  if (session.incomplete) return new Response('Audio capture is incomplete.', { status: 409 });
  if (!session.audioBytes) return new Response('Audio has not been captured.', { status: 404 });
  const wav = new Uint8Array(44 + session.audioBytes);
  const view = new DataView(wav.buffer);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + session.audioBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, session.audioBytes, true);
  let offset = 44;
  for (const part of session.audioParts) { wav.set(part, offset); offset += part.byteLength; }
  return new Response(wav, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.byteLength),
      'Content-Disposition': 'attachment; filename="kate-conversation.wav"',
      'Cache-Control': 'no-store'
    }
  });
}

async function readBoundedBody(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) return { oversized: true, bytes: new Uint8Array() };
  const reader = request.body?.getReader();
  if (!reader) return { oversized: false, bytes: new Uint8Array() };
  const parts = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { oversized: true, bytes: new Uint8Array() };
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return { oversized: false, bytes };
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
