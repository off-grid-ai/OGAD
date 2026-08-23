# Off Grid AI Desktop — Local Model Gateway API

Off Grid AI Desktop runs **one local HTTP server that speaks the OpenAI API**, on
`127.0.0.1:7878`. Every modality the app can do on-device — chat, vision, embeddings,
speech-to-text, text-to-speech, and image generation/editing — is exposed through it.

- **Base URL:** `http://127.0.0.1:7878/v1`
- **Auth:** none. The server is bound to loopback only (never exposed off the machine).
- **Compatibility:** OpenAI API surface. Point any OpenAI SDK at the base URL and drop the key.
- **Privacy:** everything runs on the bundled local models. Nothing leaves the device.

Check it's up:

```bash
curl http://127.0.0.1:7878/health
```

```json
{
  "name": "Off Grid AI Desktop — local model gateway",
  "openai_compatible": true,
  "base_url": "http://127.0.0.1:7878/v1",
  "docs": "http://127.0.0.1:7878/docs",
  "modalities": {
    "text": "ready",
    "vision_understanding": "ready",
    "embeddings": "ready",
    "transcription": "ready",
    "speech": "ready",
    "image_generation": "ready",
    "image_edit": "ready"
  },
  "image_models": ["..."],
  "image_reason": "..."
}
```

A modality reads `ready` or `not_installed`. Text, vision, embeddings, transcription and
speech are always ready (models download on first use). Image generation/edit report
`not_installed` with a `image_reason` until a diffusion model is present in the models dir.

`GET /docs` returns a plain-text quick reference. `GET /` and `/health` are identical.

---

## Capabilities at a glance

| Modality                 | Endpoint                                   | Method | Backend                        |
| ------------------------ | ------------------------------------------ | ------ | ------------------------------ |
| Text → Text              | `/v1/chat/completions`                     | POST   | llama-server (bundled VLM)     |
| Image → Text (vision)    | `/v1/chat/completions`                     | POST   | llama-server (VLM + mmproj)    |
| Text completion (legacy) | `/v1/completions`                          | POST   | llama-server                   |
| Embeddings               | `/v1/embeddings`                           | POST   | llama-server                   |
| List models              | `/v1/models`                               | GET    | llama-server                   |
| Speech → Text (STT)      | `/v1/audio/transcriptions`                 | POST   | whisper.cpp                    |
| Text → Speech (TTS)      | `/v1/audio/speech`                         | POST   | Kokoro-82M (ONNX)              |
| List TTS voices          | `/v1/audio/voices`                         | GET    | Kokoro-82M                     |
| Text → Image             | `/v1/images` (or `/v1/images/generations`) | POST   | stable-diffusion.cpp / Core ML |
| Image → Image            | `/v1/images` (or `/v1/images/edits`)       | POST   | stable-diffusion.cpp           |

This surface follows the [OpenRouter multimodal](https://openrouter.ai/docs/guides/overview/multimodal/overview)
conventions: images go in as `image_url` content parts (data URLs **or** `http(s)://` /
`file://` URLs — the gateway fetches and inlines them), and image generation/editing
shares one `/v1/images` endpoint with an `input_references` array for image-to-image.
The `/v1/images/generations` and `/v1/images/edits` routes remain as OpenAI-SDK aliases.

CORS is open (`*`) for local tools. All endpoints answer `OPTIONS` with `204`.

---

## 1. Text → Text (chat)

`POST /v1/chat/completions` — proxied straight to the bundled `llama-server`. Full
OpenAI chat semantics: streaming, temperature, `max_tokens`, stop, etc.

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "Write a haiku about local AI."}],
    "stream": false
  }'
```

Response is a standard OpenAI `chat.completion` object. Set `"stream": true` for SSE
`data:` chunks.

**Structured output.** The local model is a reasoning model. For clean JSON, pass a
grammar-constrained `response_format` and disable thinking:

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "schema": {
        /* ... */
      }
    }
  },
  "chat_template_kwargs": { "enable_thinking": false }
}
```

### With an OpenAI SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:7878/v1", api_key="not-needed")
r = client.chat.completions.create(model="local",
    messages=[{"role": "user", "content": "hello"}])
print(r.choices[0].message.content)
```

```javascript
import OpenAI from 'openai'
const client = new OpenAI({ baseURL: 'http://127.0.0.1:7878/v1', apiKey: 'not-needed' })
const r = await client.chat.completions.create({
  model: 'local',
  messages: [{ role: 'user', content: 'hello' }]
})
```

---

## 2. Image → Text (vision understanding)

Same `/v1/chat/completions` endpoint — add an `image_url` content part. The default
local vision model understands images via its mmproj projector. As on OpenRouter, the
`url` may be **either** a base64 data URL **or** a remote `http(s)://` / `file://` URL —
the gateway fetches remote images and inlines them before running the model (llama-server
can't fetch URLs itself).

```bash
# base64 data URL
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "What is in this image?" },
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
      ]
    }]
  }'
```

```bash
# remote URL — fetched and inlined for you
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{
      "role": "user",
      "content": [
        { "type": "text", "text": "Describe this photo." },
        { "type": "image_url", "image_url": { "url": "https://example.com/photo.jpg" } }
      ]
    }]
  }'
```

Multiple `image_url` parts in one message are supported. The response is a standard chat
completion — the assistant text is your image-to-text result.

---

## 3. Embeddings

`POST /v1/embeddings` — served on-device by `all-MiniLM-L6-v2` (the same embedder the
app's memory/RAG layer uses, so vectors are consistent). **384-dimensional**, mean-pooled
and L2-normalized. `input` is a string or an array of strings.

```bash
curl http://127.0.0.1:7878/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{ "model": "local", "input": ["text one", "text two"] }'
```

```json
{
  "object": "list",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0123, -0.0456, "...384 floats..."] },
    { "object": "embedding", "index": 1, "embedding": ["..."] }
  ],
  "model": "all-MiniLM-L6-v2",
  "usage": { "prompt_tokens": 0, "total_tokens": 0 }
}
```

---

## 4. Speech → Text (STT / transcription)

`POST /v1/audio/transcriptions` — `multipart/form-data`, bundled whisper.cpp. Audio is
converted to 16 kHz mono via ffmpeg and transcribed with auto language detection.

**Form fields**

| Field             | Required | Notes                                                            |
| ----------------- | -------- | ---------------------------------------------------------------- |
| `file`            | yes      | Audio file (wav, mp3, m4a, …). Max 200 MB.                       |
| `response_format` | no       | `json` (default) or `text`.                                      |
| `model`           | no       | Accepted for compatibility; the installed whisper model is used. |

```bash
curl http://127.0.0.1:7878/v1/audio/transcriptions \
  -F file=@meeting.wav \
  -F response_format=json
```

```json
{ "text": "the transcribed text" }
```

With `response_format=text` the body is the raw transcript (`Content-Type: text/plain`).

---

## 5. Text → Speech (TTS)

`POST /v1/audio/speech` — Kokoro-82M (Apache-2.0, multilingual), running on the bundled
onnxruntime. **Returns raw `audio/wav` bytes** by default (like OpenAI).

**JSON body**

| Field             | Required | Notes                                                                                                      |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `input`           | yes      | Text to speak. Capped at ~2000 chars per call. (`text` also accepted.)                                     |
| `voice`           | no       | Voice id, default `af_heart`. See `/v1/audio/voices`.                                                      |
| `response_format` | no       | Omit/`wav` → raw WAV bytes. `json`/`b64_json` → `{ "audio": "data:audio/wav;base64,…", "format": "wav" }`. |
| `model`           | no       | Accepted for compatibility.                                                                                |

```bash
# Raw WAV to a file
curl http://127.0.0.1:7878/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{ "input": "Hello from Off Grid.", "voice": "af_heart" }' \
  --output speech.wav
```

List voices:

```bash
curl http://127.0.0.1:7878/v1/audio/voices
# { "voices": ["af_heart", "af_bella", "am_michael", ...] }
```

> Note: OpenAI's `tts-1` returns mp3 by default. This gateway returns **WAV**. Pass
> `response_format: "json"` if your client expects a JSON envelope rather than raw bytes.

---

## 6. Text → Image & Image → Image (`/v1/images`)

`POST /v1/images` — one JSON endpoint for both text-to-image and image-to-image, matching
OpenRouter's image API. On-device diffusion via stable-diffusion.cpp (GGUF / safetensors)
or the Core ML ANE helper. Returns base64 PNG.

**JSON body**

| Field              | Required | Notes                                                                                                                                                                                                                                             |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`           | yes      | Text prompt.                                                                                                                                                                                                                                      |
| `input_references` | no       | Array — **presence makes it image-to-image.** Each item is `{ "type": "image_url", "image_url": { "url": "…" } }` (or a bare URL string). The `url` may be a data URL, `http(s)://`, or `file://`. The first reference is used as the init image. |
| `strength`         | no       | img2img only. 0–1, how far from the init image (default ~0.75). Lower = closer to original.                                                                                                                                                       |
| `aspect_ratio`     | no       | e.g. `"16:9"`, `"1:1"`. Combined with `resolution`.                                                                                                                                                                                               |
| `resolution`       | no       | `"1K"` (default), `"2K"`, or `"512"` — sets the long edge.                                                                                                                                                                                        |
| `size`             | no       | OpenAI-style `"WIDTHxHEIGHT"`, e.g. `"1024x1024"`.                                                                                                                                                                                                |
| `width` / `height` | no       | Explicit dimensions (numbers); override the above.                                                                                                                                                                                                |
| `negative_prompt`  | no       | Things to avoid. A sensible default is applied if omitted.                                                                                                                                                                                        |
| `steps`            | no       | Sampling steps. Per-model default (few-step turbo/lightning models use ~4–8).                                                                                                                                                                     |
| `seed`             | no       | Integer seed; omit or `-1` for random. The resolved seed is returned.                                                                                                                                                                             |
| `cfg_scale`        | no       | Guidance scale. Per-model default.                                                                                                                                                                                                                |
| `model`            | no       | Model filename in the models dir; otherwise the preferred installed model.                                                                                                                                                                        |
| `response_format`  | no       | `b64_json` (default) → base64 PNG. `url` → `file://` path on disk.                                                                                                                                                                                |

**Text-to-image:**

```bash
curl http://127.0.0.1:7878/v1/images \
  -H "Content-Type: application/json" \
  -d '{ "prompt": "a lighthouse at dusk, watercolor", "aspect_ratio": "16:9", "resolution": "1K" }'
```

**Image-to-image** (add `input_references`):

```bash
curl http://127.0.0.1:7878/v1/images \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "make it a snowy winter scene",
    "strength": 0.6,
    "input_references": [
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
    ]
  }'
```

**Response** (both cases):

```json
{
  "created": 1750000000,
  "data": [{ "b64_json": "iVBORw0KGgo...", "seed": 42, "model": "z-image-turbo.gguf" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Saved PNGs also persist under the app's `generated-images` directory. If no diffusion
model is installed the endpoint returns `501` with the reason (`GET /health` shows
`image_generation: "not_installed"` and an `image_reason`).

> Only one image generates at a time. The local LLM is briefly paused during generation
> so both models don't co-reside in unified memory (Apple Silicon). Expect a short delay.
> The few-step Z-Image turbo model is generation-only; image-to-image requires an
> SD/SDXL-class model.

### OpenAI-SDK aliases

For drop-in compatibility with `openai` SDKs, two aliases wrap the same engine:

- `POST /v1/images/generations` — JSON, same fields as `/v1/images` (text-to-image).
- `POST /v1/images/edits` — `multipart/form-data` with an `image` file, a `prompt`
  field, and optional `strength`, `size`, `negative_prompt`, `steps`, `seed`,
  `cfg_scale`, `model`. (A `mask` field is accepted but ignored — whole-image img2img,
  not masked inpainting.)

```bash
curl http://127.0.0.1:7878/v1/images/edits \
  -F image=@photo.png \
  -F prompt="make it a snowy winter scene" \
  -F strength=0.6
```

---

## Errors

Errors use the OpenAI shape:

```json
{ "error": { "message": "…", "type": "invalid_request_error" } }
```

| Status | Meaning                                                                          |
| ------ | -------------------------------------------------------------------------------- |
| `400`  | Bad request (missing field, wrong content type, invalid JSON).                   |
| `413`  | Upload exceeds the 200 MB cap.                                                   |
| `500`  | The model run failed (see `message`).                                            |
| `501`  | Modality not installed (e.g. no diffusion model, transcription runtime missing). |
| `502`  | llama-server not ready (chat/embeddings upstream unavailable).                   |

---

## Async & polling (request ids)

Every response carries an `X-Request-Id` header. **Any** POST can be run asynchronously —
useful for long jobs (image generation, first-run TTS) so the client never blocks or
times out. Opt in three ways:

- query: `POST /v1/images?async=true`
- body: `{ "async": true, ... }`
- header: `X-Async: true` (or `Prefer: respond-async`)

An async POST returns **`202 Accepted`** immediately with a request resource and a
`Location` header:

```json
{
  "request_id": "cee1c78f-…",
  "object": "request",
  "kind": "image",
  "status": "running",
  "poll_url": "/v1/images/cee1c78f-…"
}
```

**Polling is RESTful — you `GET` the request resource, there is no `/poll` verb.** Two
equivalent paths:

- Canonical: `GET /v1/requests/{request_id}`
- Per-collection resource: `GET /v1/images/{id}`, `GET /v1/embeddings/{id}`,
  `GET /v1/audio/speech/{id}`, `GET /v1/chat/completions/{id}`, `GET /v1/audio/transcriptions/{id}`

```bash
curl http://127.0.0.1:7878/v1/requests/cee1c78f-…
```

```json
{
  "request_id": "cee1c78f-…",
  "kind": "image",
  "status": "completed", // queued | running | completed | failed
  "created_at": 1782191813736,
  "updated_at": 1782191840000,
  "result": { "created": 1782191840, "data": [{ "b64_json": "…" }] }
}
```

When `status` is `completed`, `result` holds the same payload the synchronous call would
have returned; when `failed`, an `error` object is present. `GET /v1/requests` lists recent
requests. (Sync calls behave exactly as documented above — async is purely opt-in.)

## Performance, memory & timeouts

The gateway is built for a single machine running everything locally, so it manages
memory carefully (Apple Silicon shares RAM between CPU/GPU/ANE):

- **Models swap in and out — they are not all held resident.** The LLM (`llama-server`)
  is the always-warm core. Heavier models load only when needed and are released after:
  - **Image generation** pauses and frees the LLM before loading the diffusion model,
    then resumes the LLM when done. Only one image generates at a time (a second request
    gets `An image is already generating — please wait`).
  - **TTS** runs Kokoro in a short-lived isolated subprocess that is killed after each
    call, so the voice model is only resident while speaking.
  - **STT** runs whisper as a one-shot subprocess that exits when the transcript is ready.
- Because image generation can take tens of seconds (model load + diffusion), and first
  use of TTS downloads the voice model, **the gateway disables HTTP request/idle timeouts**
  — long calls will not be cut off mid-flight. Set a generous client-side timeout
  (≥120 s) for `/v1/images*` and the first `/v1/audio/speech` call.

## Backends & ports

| Service                       | Where                           | Used by                                       |
| ----------------------------- | ------------------------------- | --------------------------------------------- |
| `llama-server`                | `127.0.0.1:8439` (long-running) | chat, vision, completions, embeddings, models |
| `whisper.cpp` (`whisper-cli`) | one-shot subprocess             | transcription                                 |
| Kokoro-82M via `kokoro-js`    | in-process (onnxruntime)        | speech, voices                                |
| `sd-cli` / `coreml-sd`        | one-shot subprocess             | image generation & edits                      |

The gateway (`src/main/model-server.ts`) is the only port you call (`7878`); it proxies
or invokes the right backend per route. Models live in the app's `userData/models`
directory; install them from the in-app Models screen.
