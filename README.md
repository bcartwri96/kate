# Hush

Mobile-first, on-device transcription using Cactus Whistle and the Cactus Needle WASM browser runtime. The Cloudflare Worker serves the static app; model inference and microphone capture run locally in the user's browser.

## Cloudflare Worker setup

Requirements: Node.js and Python 3.

```sh
npm install
npm run setup:needle
npm run dev
```

`setup:needle` downloads the official browser runtime (`needle.js`, `needle.wasm`, and `needle.h`) from `Cactus-Compute/needle3` and the Whistle `.cact` model from `Cactus-Compute/whistle` into `needle/`. Run it before local development and deployment.

To deploy:

```sh
npm run deploy
```

`wrangler.jsonc` configures the project root as an assets-only Worker Static Assets directory. `.assetsignore` keeps source and configuration files out of the public upload. The browser downloads the model from the Worker once and caches it in IndexedDB on the user's device. The deployed app does not upload microphone audio or transcript text.

## Local diagnostics

Run `npm run dev:debug` to start the separate local diagnostics Worker on `http://localhost:8791`. This config sets the `DEBUG` signal, while the production assets-only config does not; the browser also checks for a loopback hostname and the local status endpoint before sending anything.

- Open [`/debug`](http://localhost:8791/debug) for diagnostic events and words with timing, RMS, and VAD fields.
- Download the complete captured pre-inference microphone audio at [`/debug?audio=1`](http://localhost:8791/debug?audio=1).
- Clear the API's in-memory capture with `curl -X DELETE http://localhost:8791/debug` or the app's Clear convo button.

Audio and diagnostics stay in the local Wrangler process memory and disappear when it restarts or the conversation is cleared. Audio capture is capped at ten minutes; event and word records have fixed caps too. A capped or interrupted recording is marked incomplete and is not served as a complete WAV. The `/debug` handler and its client uploads are absent from production; unknown production paths return 404.

## Model/runtime notes

- Whistle weights: [Cactus-Compute/whistle](https://huggingface.co/Cactus-Compute/whistle), 16.9 MB `.cact` model.
- Browser runtime: Needle's official `wasm` platform bundle from [Cactus-Compute/needle3](https://huggingface.co/Cactus-Compute/needle3/tree/main/wasm).
- For a browser app, use the browser/Node platform bundle. Cloudflare's WASM-in-Worker runtime is a server-side WASM target; it would not satisfy client-side-only microphone/transcription behavior.

## Runtime flow

The app loads the official Emscripten bundle in a dedicated Web Worker, passes Whistle bytes to `needle_load`, captures microphone audio through an AudioWorklet, resamples it to 16 kHz mono, and feeds adaptive half-second/one-second chunks to `needle_stream_transcribe_process`. A compact WebRTC VAD compiled to WASM checks 10 ms frames in that worker, mutes non-speech frames while preserving the audio timeline, and filters returned words against the VAD decisions at their timestamps. The VAD retains a short lead-in and tail around speech. This keeps model inference off Safari's UI thread and reduces silence and background noise reaching Needle. VAD can still mistake singing or speech-like music for conversation. Confirmed words and the pending tail are rendered locally and transcript text is kept in browser storage. The browser adapter targets the C exports documented in `needle/needle.h` and present in the downloaded `needle.js` bundle.

The browser VAD uses the WebRTC VAD extracted as libfvad, compiled to a single-file WASM module and distributed under BSD-3-Clause; see [vad/THIRD_PARTY_NOTICES.md](vad/THIRD_PARTY_NOTICES.md). It does not download separate model weights.
