# Local `/debug` API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a development-only `/debug` API that serves the full microphone WAV and transcription diagnostics, while removing the normal UI's chunk links and debug dumps.

**Architecture:** A dedicated local Wrangler config runs a small module Worker in front of the existing static assets and marks diagnostics enabled with a local-only binding. The Worker accepts bounded, ordered WAV audio segments and structured event/word records in process memory; GET routes return JSON or a reconstructed whole-session WAV, while DELETE clears the session. Browser code sends these records only on localhost, and the production assets-only config remains without a Worker handler and returns 404 for unknown paths.

**Tech Stack:** Browser JavaScript, AudioWorklet PCM capture, Cloudflare Workers module syntax, Wrangler 4, Node.js built-in test runner, static asset binding.

**Spec:** [docs/superpowers/specs/2026-10-17-local-d3bug-api-design.md](../specs/2026-10-17-local-d3bug-api-design.md)

## Global Constraints

- “Keep all diagnostic data in memory in the local Wrangler Worker process. Restarting the process clears it.”
- “The browser sends data only when the app is running on localhost.”
- “Production configuration must not bind or expose diagnostic storage/handlers. Production requests to `/debug` return 404.”
- “Audio and diagnostics stay in process memory; nothing is written to disk or sent to a remote service.”
- “Cap retained diagnostic events and audio size/duration, returning an explicit error if a limit is reached rather than silently truncating a recording presented as complete.”
- “Push source changes via Git after implementation; do not publish using `wrangler deploy`.”
- Use the existing 16 kHz mono microphone samples; do not alter transcription/VAD tuning or introduce dependencies.

## Review Focus

- Non-local host or missing local-only binding: endpoint must return 404. Pin in Task 1's Node tests.
- Local hostname with the assets-only config: browser must see `/debug?status=1` as disabled and send no diagnostics. Pin with Task 1's status test and Task 2's local integration check.
- Malformed event JSON, unsupported methods/content types, and request body over limit: reject with a short 4xx response and do not mutate retained state. Pin in Task 1's Node tests.
- Audio cap reached mid-session: return an explicit limit error and never present truncated content as a complete WAV. Pin in Task 1's Node tests.
- Audio segments arriving while transcription results are posted: audio segment order must remain correct and WAV duration/data length must match. Pin with Task 1's ordering/cap tests and Task 2's local integration check.
- Clear/restart: DELETE and the app's Clear convo action must remove audio and diagnostics; restarting local Wrangler starts empty. Pin in Task 1's DELETE test and Task 2's manual integration check.

---

## File map

- Create `debug-worker.js`: local-only Worker route, in-memory session store, request validation, JSON and WAV responses, and static asset fallback.
- Create `wrangler.dev.jsonc`: local-only Worker entry point, `ASSETS` binding, `/debug` worker-first routing, and `DEBUG: "1"` marker. Production continues using `wrangler.jsonc` without that marker or a Worker entry point.
- Create `debug-worker.test.js`: Node built-in tests for route gating, records, WAV assembly, clearing, and body limits.
- Modify `package.json`: add `dev:debug` using the local config and `test` using `node --test`.
- Modify `.assetsignore`: prevent local-only Worker/config source from becoming public static assets in production.
- Modify `audio-worklet.js`: no signal-processing behavior changes; maintain its current 8,000-sample message cadence as the source of continuous debug audio.
- Modify `app.js`: localhost-only ordered WAV uploads and structured event/word records; remove chunk-link creation and routine debug console dumps; DELETE debug data when clearing the conversation.
- Modify `inference-worker.js`: post VAD-ready diagnostics to the app instead of writing routine debug output to the browser console.
- Modify `index.html` and `styles.css`: remove the chunk-download section and styles.
- Modify `wrangler.jsonc`: use a 404 fallback for unknown production paths so `/debug` cannot resolve to the SPA HTML shell.
- Modify `sw.js`: bump the asset cache version so users receive the UI and worker-client changes together.
- Modify `README.md`: document the local debug command, endpoints, limits, data lifetime, and that production has no debug API.

## Interfaces

- `debug-worker.js` exports `fetch(request, env)`. It routes `/debug` only when `env.DEBUG === "1"` and the request host is a loopback hostname; otherwise it returns 404. Other requests use `env.ASSETS.fetch(request)`.
- `GET /debug?status=1` returns `{ "enabled": true }` only after the Worker-side local signal and loopback checks pass; the browser additionally checks its own hostname before enabling any uploads.
- `POST /debug` with `Content-Type: application/json` accepts `{ "type": "event", "event": { ... } }` or `{ "type": "words", "chunk": number, "rms": number, "speech_ratio": number, "vad_kept_ratio": number, "words": [...] }`.
- It also accepts `{ "type": "incomplete", "reason": string }` to mark a client-capped session. The JSON response returns `incomplete: true` and the WAV endpoint returns 409.
- `POST /debug?type=audio` with `Content-Type: audio/wav` appends one complete short PCM16 mono WAV segment. The client posts segments sequentially; the Worker validates WAV format/sample rate/channels and joins PCM data for the downloadable full-session WAV.
- `GET /debug` returns `{ events, words, audio: { available, url, duration_seconds, bytes } }`.
- `GET /debug?audio=1` returns `audio/wav` and `Content-Disposition: attachment; filename="kate-conversation.wav"`.
- `DELETE /debug` clears all retained session state and returns 204.
- Limits: at most 10 minutes (19,200,000 PCM bytes at 16 kHz mono PCM16), 5,000 diagnostic events, 10,000 word decisions, and 64 KiB per JSON request. On reaching a limit, reject that request with 413 and mark the session as incomplete; the WAV endpoint must return 409 while incomplete.
- `window.KateDebug` in `app.js` is a local-only client helper with `event(record)`, `words(record)`, `audio(samples)`, and `clear()` methods. It queues audio uploads serially, caps pending audio at 1 MiB, and never queues audio in production. A queue overflow marks the local session incomplete and stops further debug-audio uploads without interrupting transcription.

### Task 1: Implement and test the local Worker API

**Files:**
- Create: `debug-worker.js`
- Create: `debug-worker.test.js`
- Create: `wrangler.dev.jsonc`
- Modify: `package.json`
- Modify: `.assetsignore`
- Modify: `wrangler.jsonc`

**Interfaces:** Implements the Worker routes and payload formats listed in **Interfaces** above. `debug-worker.test.js` imports the module Worker directly and invokes `fetch(new Request(...), env)`.

- [ ] **Step 1: Add failing tests for a non-local request and disabled binding**

Use Node's built-in `node:test` and `node:assert/strict`; assert both cases return 404 and do not create session data.

- [ ] **Step 2: Run the API tests and confirm the new cases fail**

Run: `node --test debug-worker.test.js`
Expected: FAIL because `debug-worker.js` does not yet exist.

- [ ] **Step 3: Implement the fail-closed route gate and static asset passthrough**

Add the Worker module with `DEBUG` and loopback checks; route non-API paths to `env.ASSETS.fetch(request)`.

- [ ] **Step 4: Add failing tests for status, JSON events/words, invalid JSON, wrong methods, and event/word count limits**

Assert valid records appear in GET JSON; malformed, unsupported, and over-limit requests return 4xx and do not exceed caps.

- [ ] **Step 5: Implement JSON ingestion, JSON GET, DELETE, and bounded in-memory state**

Set exact event/word limits from the Interfaces section; make DELETE reset all arrays, audio state, and incomplete flag.

- [ ] **Step 6: Add failing tests for WAV format checks, concatenation, audio cap, and incomplete recordings**

Construct short PCM16 WAV fixtures in the test file. Assert the returned WAV has a correct 44-byte header and concatenated PCM payload; invalid rate/channels/header gets 400; the cap gets 413 and subsequent audio GET gets 409.

- [ ] **Step 7: Implement sequential WAV segment ingestion and whole-session WAV download**

Validate RIFF/WAVE, PCM format 1, mono, 16 kHz, 16-bit samples. Retain segment PCM bytes, account against the 19,200,000-byte cap before append, and generate one correct WAV on GET.

- [ ] **Step 8: Configure a dedicated local Wrangler Worker and scripts**

`wrangler.dev.jsonc` uses `main: "debug-worker.js"`, existing static assets with binding `ASSETS`, worker-first routing for `"/debug"` and `"/debug/*"`, and `DEBUG: "1"`. Add `npm run dev:debug` and `npm test`. Exclude `debug-worker.js` and `wrangler.dev.jsonc` from deployed assets. In `wrangler.jsonc`, set `not_found_handling` to `"none"`; keep it assets-only and leave out `DEBUG`.

- [ ] **Step 9: Run Worker tests and verify config shape**

Run: `npm test`
Expected: PASS for gate, routes, body validation, limits, WAV reconstruction, and DELETE. Run: `npx wrangler types --config wrangler.dev.jsonc` only if supported without writing generated files; otherwise inspect `npx wrangler deploy --dry-run --config wrangler.dev.jsonc` and make no deployment.

### Task 2: Route app diagnostics and continuous audio to `/debug`

**Files:**
- Modify: `app.js`
- Modify: `inference-worker.js`
- Modify: `sw.js`

**Interfaces:** Uses `POST /debug` JSON and WAV formats and `DELETE /debug` from Task 1. Expose local-only `window.KateDebug` helper methods as listed above.

- [ ] **Step 1: Add a local-client predicate and event/word upload helper**

Only enable when hostname is `localhost`, `127.0.0.1`, or `::1` and `GET /debug?status=1` returns `{ "enabled": true }`; use same-origin fetch. Convert current `logChunkResult` fields into a structured `words` record; post VAD-ready, app error, `window.error`, and `unhandledrejection` records as events. Store timestamp, log level, and message as fields so GET JSON contains the diagnostic console output without routine transcript dumps in the developer console.

- [ ] **Step 2: Add a PCM16 WAV encoder for each worklet block**

Encode each 8,000-float block to a standalone 0.5-second mono 16 kHz WAV segment. Queue fetches so audio segment requests complete in source order. Limit queued-but-unsent audio to 1 MiB, mark the endpoint session incomplete on overflow, and stop further debug-audio uploads. Keep no second unbounded copy after a segment is accepted by fetch; report a concise endpoint failure locally and continue transcription.

- [ ] **Step 3: Connect the worklet stream to the local upload queue**

Forward each accepted `pcm` block to `KateDebug.audio(pcm)` before normal inference buffering. Ensure payload generation IDs are honored so stale samples from before Clear convo are not uploaded.

- [ ] **Step 4: Replace console dumps and per-chunk links with API records**

Remove `logChunkResult` console tables, `addAudioClip`, `createChunkAudioUrl`, the recent clip list, and pending audio copies used only for downloads. Preserve user-visible errors and model/microphone status; route diagnostic details to `/debug` only after the hostname check and status probe. Change VAD-ready output in `inference-worker.js` to a `diagnostic` postMessage consumed by the main thread. In local debug mode, route Needle worker console output to diagnostic messages instead of the developer console.

- [ ] **Step 5: Reset local diagnostics with Clear convo and update cache version**

Send `DELETE /debug` when clearing the transcript; ignore a failed debug clear so normal clear/transcription behavior still works. Increment `sw.js` cache version.

- [ ] **Step 6: Run existing API tests and inspect browser-client behavior**

Run: `npm test`
Expected: PASS. Manually verify with local Wrangler that audio segments upload in order, GET JSON records VAD/chunk/timed word fields, WAV is audible and continuous, clear empties the endpoint, normal transcription proceeds if endpoint requests fail, and production does not issue `/debug` requests.

### Task 3: Remove diagnostic UI and document local access

**Files:**
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `README.md`

**Interfaces:** User-visible transcript, loading, retry, and Clear convo behavior remains unchanged. Local diagnostics are accessible by opening `/debug`; WAV is available at `/debug?audio=1`.

- [ ] **Step 1: Remove the chunk download section and its styles**

Delete `audioClips`, summary, and list elements and remove `.audio-clips` and `.audio-clip-list` rules. Confirm no remaining app selectors reference the removed elements.

- [ ] **Step 2: Document local use and limitations**

Explain `npm run dev:debug`, GET JSON, WAV download URL, DELETE reset, localhost-only enforcement, in-memory lifetime, 10-minute cap, and that the ordinary production config does not provide this endpoint.

- [ ] **Step 3: Verify production routing and the rendered app**

Run `npm test`. Start the local debug Worker and verify app shell/assets load, `/debug` works only over loopback, and a production-style run of the assets-only config returns 404 for `/debug`. Confirm no chunk links or tables remain in the page.

### Task 4: Review and push the source change

**Files:**
- Review tracked changes only; do not include `.wrangler/`, `node_modules/`, model binaries, or local capture data.

- [ ] **Step 1: Review the final diff and repository status**

Run `git diff --check`, inspect the full staged diff, and confirm the local debug config and API tests are intentional source files.

- [ ] **Step 2: Commit the implementation**

Commit source and documentation changes with a message such as `feat: add local debug diagnostics endpoint`.

- [ ] **Step 3: Push the branch through Git**

Push the implementation commit to the configured Git remote. Do not run `wrangler deploy`.
