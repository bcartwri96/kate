import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from './debug-worker.js';

const env = debug => ({
  DEBUG: debug,
  ASSETS: { fetch: async () => new Response('asset') }
});
const localEnv = env('1');
const localUrl = path => `http://localhost${path}`;

function wavBytes({ sampleRate = 16000, channels = 1, bits = 16, pcm = new Uint8Array([0x34, 0x12]) } = {}) {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const write = (offset, value) => { for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bits / 8, true);
  view.setUint16(32, channels * bits / 8, true);
  view.setUint16(34, bits, true);
  write(36, 'data');
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

beforeEach(async () => {
  await worker.fetch(new Request(localUrl('/debug'), { method: 'DELETE' }), localEnv);
});

test('hides debug routes when the Wrangler DEBUG signal is absent', async () => {
  const response = await worker.fetch(new Request('http://localhost/debug'), env(undefined));
  assert.equal(response.status, 404);
});

test('hides debug routes outside loopback even when DEBUG is enabled', async () => {
  const response = await worker.fetch(new Request('https://kate.example/debug'), env('1'));
  assert.equal(response.status, 404);
});

test('passes non-debug requests through to static assets', async () => {
  const response = await worker.fetch(new Request(localUrl('/app.js')), localEnv);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset');
});

test('reports debug enabled only from the local Worker configuration', async () => {
  const enabled = await worker.fetch(new Request(localUrl('/debug?status=1')), localEnv);
  const disabled = await worker.fetch(new Request(localUrl('/debug?status=1')), env(undefined));
  assert.deepEqual(await enabled.json(), { enabled: true });
  assert.equal(disabled.status, 404);
});

test('stores event and timed word records in the JSON response', async () => {
  const event = { timestamp: 123, level: 'info', message: 'VAD ready' };
  const words = { chunk: 7, rms: 0.02, speech_ratio: 0.5, vad_kept_ratio: 0.8, words: [{ word: 'Hi.', start: 1, end: 1.2, displayed: true }] };
  await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'event', event }) }), localEnv);
  await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'words', ...words }) }), localEnv);
  const response = await worker.fetch(new Request(localUrl('/debug')), localEnv);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    events: [event],
    words: [words],
    audio: { available: false, url: '/debug?audio=1', duration_seconds: 0, bytes: 0 },
    incomplete: false
  });
});

test('rejects malformed JSON, unsupported content types, and methods', async () => {
  const malformed = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), localEnv);
  const unsupported = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }), localEnv);
  const wrongMethod = await worker.fetch(new Request(localUrl('/debug'), { method: 'PUT' }), localEnv);
  assert.equal(malformed.status, 400);
  assert.equal(unsupported.status, 415);
  assert.equal(wrongMethod.status, 405);
});

test('rejects oversized diagnostic JSON and marks the session incomplete', async () => {
  const body = JSON.stringify({ type: 'event', event: { message: 'x'.repeat(65536) } });
  const response = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body }), localEnv);
  assert.equal(response.status, 413);
  const data = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(data.events.length, 0);
  assert.equal(data.incomplete, true);
});

test('rejects event and word records that exceed their caps without partial storage', async () => {
  for (let i = 0; i < 5000; i++) {
    const response = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'event', event: { i } }) }), localEnv);
    assert.equal(response.status, 204);
  }
  const tooManyEvents = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'event', event: { i: 5000 } }) }), localEnv);
  assert.equal(tooManyEvents.status, 413);
  let data = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(data.events.length, 5000);
  assert.equal(data.incomplete, true);

  await worker.fetch(new Request(localUrl('/debug'), { method: 'DELETE' }), localEnv);
  const manyWords = Array.from({ length: 10001 }, (_, i) => ({ word: String(i), start: i, end: i + 1 }));
  const tooManyWords = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'words', chunk: 1, words: manyWords }) }), localEnv);
  assert.equal(tooManyWords.status, 413);
  data = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(data.words.length, 0);
  assert.equal(data.incomplete, true);
});

test('DELETE clears diagnostic and audio session state', async () => {
  await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'event', event: { message: 'saved' } }) }), localEnv);
  const response = await worker.fetch(new Request(localUrl('/debug'), { method: 'DELETE' }), localEnv);
  assert.equal(response.status, 204);
  const data = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(data.events.length, 0);
  assert.equal(data.incomplete, false);
});

test('marks audio incomplete when the client reports an upload queue overflow', async () => {
  const response = await worker.fetch(new Request(localUrl('/debug'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'incomplete', reason: 'local audio queue overflow' }) }), localEnv);
  assert.equal(response.status, 204);
  const data = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(data.incomplete, true);
  assert.equal((await worker.fetch(new Request(localUrl('/debug?audio=1')), localEnv)).status, 409);
});

test('concatenates valid WAV segments into a downloadable whole-session WAV', async () => {
  const first = wavBytes({ pcm: new Uint8Array([1, 2, 3, 4]) });
  const second = wavBytes({ pcm: new Uint8Array([5, 6]) });
  for (const wav of [first, second]) {
    const response = await worker.fetch(new Request(localUrl('/debug?type=audio'), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav }), localEnv);
    assert.equal(response.status, 204);
  }
  const json = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(json.audio.available, true);
  assert.equal(json.audio.bytes, 6);
  assert.equal(json.audio.duration_seconds, 6 / 32000);

  const response = await worker.fetch(new Request(localUrl('/debug?audio=1')), localEnv);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^audio\/wav/);
  assert.match(response.headers.get('content-disposition'), /kate-conversation\.wav/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.length, 50);
  assert.equal(new DataView(bytes.buffer).getUint32(40, true), 6);
  assert.deepEqual(bytes.slice(44), new Uint8Array([1, 2, 3, 4, 5, 6]));
});

test('rejects invalid WAV format and absent recordings', async () => {
  const unavailable = await worker.fetch(new Request(localUrl('/debug?audio=1')), localEnv);
  assert.equal(unavailable.status, 404);
  for (const options of [{ sampleRate: 44100 }, { channels: 2 }, { bits: 8 }]) {
    const response = await worker.fetch(new Request(localUrl('/debug?type=audio'), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wavBytes(options) }), localEnv);
    assert.equal(response.status, 400);
  }
  const wrongType = await worker.fetch(new Request(localUrl('/debug?type=audio'), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: wavBytes() }), localEnv);
  assert.equal(wrongType.status, 415);
});

test('rejects audio beyond the ten-minute cap and does not serve a partial WAV', async () => {
  const pcm = new Uint8Array(19_200_002);
  const tooLarge = wavBytes({ pcm });
  const response = await worker.fetch(new Request(localUrl('/debug?type=audio'), { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: tooLarge }), localEnv);
  assert.equal(response.status, 413);
  const json = await (await worker.fetch(new Request(localUrl('/debug')), localEnv)).json();
  assert.equal(json.audio.available, false);
  assert.equal(json.incomplete, true);
  const audio = await worker.fetch(new Request(localUrl('/debug?audio=1')), localEnv);
  assert.equal(audio.status, 409);
});
