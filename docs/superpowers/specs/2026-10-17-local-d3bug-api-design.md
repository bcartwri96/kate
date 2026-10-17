# Local `/debug` API Design

## Goal

Provide a local-only diagnostic endpoint for Kate that exposes the captured conversation WAV, speech-engine diagnostics, and recognized words with timing. Remove the current on-page chunk-download/debug UI and routine console output. The endpoint is for development investigation and is not part of the deployed public app.

## Scope

- Add a small Worker handler for `GET /debug?status=1`, `GET /debug`, `GET /debug?audio=1`, `POST /debug`, and a clear operation associated with clearing the conversation.
- Keep all diagnostic data in memory in the local Wrangler Worker process. Restarting the process clears it.
- Accept diagnostic events and timed word records from the browser and retain the full captured microphone audio as WAV.
- Serve JSON containing diagnostic events and word records, and serve the full WAV on the audio query form.
- Restrict the handler to local Wrangler development and localhost requests. Enable it only when the separate local Wrangler config supplies `DEBUG: "1"`, and also require a loopback hostname. Production requests must return 404 and the endpoint must not be enabled by production configuration.
- Remove the visible chunk download links and routine debug logging from the normal app UI.
- Push source changes via Git after implementation; do not publish using `wrangler deploy`.

## API behavior

### `POST /debug`

Receives diagnostic updates from the app. The request body identifies its record type and contains structured event, words, incomplete-session, or audio data. Audio is encoded as WAV in the request so the endpoint stores the captured pre-inference microphone signal rather than transient per-chunk object URLs. The handler validates the content type and limits request size; the client may send audio incrementally so a long-running session does not require one unbounded upload.

The browser sends data only when the app is running on localhost and its status probe confirms the local Wrangler `DEBUG: "1"` signal. The regular deployed app does not send diagnostic data to any remote endpoint.

### `GET /debug`

Returns JSON with the retained diagnostic event list and recognized words, including each word's start/end time, chunk number, RMS, VAD metadata, and whether it was displayed when those fields are available. The response includes a WAV download URL and indicates whether audio has been captured.

### `GET /debug?status=1`

Returns `{ "enabled": true }` only when the local Wrangler Worker has `DEBUG: "1"` and the request hostname is loopback. The browser probes this endpoint before enabling uploads, in addition to checking its own hostname. The production assets-only configuration returns 404.

### `GET /debug?audio=1`

Returns the captured WAV with `audio/wav` content type and a download-friendly filename. If no audio has arrived, return a clear not-found response.

### Clear behavior

Clearing the conversation also clears the local diagnostic records and recording, preventing old records from being mixed with the next conversation. Worker restart also clears its in-memory state.

## Browser behavior

- Keep normal transcription and microphone capture behavior unchanged.
- Record a continuous mono WAV representation for the diagnostic endpoint, independent of whether the model emits any words.
- Send diagnostic events and word decisions to `/debug` only when the browser hostname is loopback and the Worker status probe confirms local debug mode.
- Remove per-chunk download links and normal-page debug tables/log output. Do not log audio payloads.
- Retain user-facing errors needed to explain microphone or model failures.

## Local-only and privacy constraints

- The endpoint must be guarded on the Worker side, not only hidden by the UI. It is enabled only when the local Wrangler config supplies `DEBUG: "1"` and the request hostname is loopback.
- Production configuration must not bind or expose diagnostic storage/handlers. Production requests to `/debug` return 404.
- Audio and diagnostics stay in process memory; nothing is written to disk or sent to a remote service. The API has no authentication because it is loopback-only and development-only.
- Cap retained diagnostic events and audio size/duration, returning an explicit error if a limit is reached rather than silently truncating a recording presented as complete.

## Error handling

- Malformed JSON, unsupported payload types, oversized uploads, and unavailable recordings return suitable 4xx responses with short plain-text explanations.
- If local upload fails, transcription continues; the local console may report a concise endpoint error, without printing transcript dumps or audio links.
- In production, all `/debug` methods resolve to 404.

## Verification

- Confirm local Wrangler serves the app and the local endpoint.
- Confirm `GET /debug` returns structured events/words after app activity and `GET /debug?audio=1` returns a WAV response that can be opened as audio.
- Confirm clearing a conversation empties both endpoint datasets.
- Confirm a production-style Worker configuration does not expose the endpoint.
- Confirm normal UI has no chunk links or debug tables, while user-facing status/error behavior remains intact.
- Review the final Git diff to ensure generated directories, model binaries, and local runtime data are not included. Push via Git only after these checks; do not run Wrangler deployment.

## Open implementation choice

Use the `DEBUG: "1"` variable in the separate local Wrangler config as the mode signal; do not set it in the production assets-only config. Combine it with a loopback-host check, and fail closed if either condition is missing. Set production unknown-path handling to 404 so `/debug` does not resolve to the SPA HTML shell.
