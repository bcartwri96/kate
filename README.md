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

`wrangler.jsonc` configures the project root as an assets-only Worker Static Assets directory. `.assetsignore` keeps source and configuration files out of the public upload. The browser downloads the model from the Worker once and caches it in IndexedDB on the user's device; the app does not upload microphone audio or transcript text.

## Model/runtime notes

- Whistle weights: [Cactus-Compute/whistle](https://huggingface.co/Cactus-Compute/whistle), 16.9 MB `.cact` model.
- Browser runtime: Needle's official `wasm` platform bundle from [Cactus-Compute/needle3](https://huggingface.co/Cactus-Compute/needle3/tree/main/wasm).
- For a browser app, use the browser/Node platform bundle. Cloudflare's WASM-in-Worker runtime is a server-side WASM target; it would not satisfy client-side-only microphone/transcription behavior.

## Runtime flow

The app loads the official Emscripten bundle in a dedicated Web Worker, passes Whistle bytes to `needle_load`, captures microphone audio through an AudioWorklet, resamples it to 16 kHz mono, and feeds adaptive half-second/one-second chunks to `needle_stream_transcribe_process`. This keeps model inference off Safari's UI thread. Confirmed words and the pending tail are rendered locally and transcript text is kept in browser storage. The browser adapter targets the C exports documented in `needle/needle.h` and present in the downloaded `needle.js` bundle.
