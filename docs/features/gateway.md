# The Gateway

[← All features](../FEATURES.md)

One local server — `http://127.0.0.1:7878` — exposes the **OpenAI API** for every model
you've downloaded. Point any OpenAI SDK at `…/v1` with any (ignored) key.

![Gateway](../screenshots/06-gateway.png)

| Capability    | Method · Endpoint                            | Notes                                         |
| ------------- | -------------------------------------------- | --------------------------------------------- |
| Chat (text)   | `POST /v1/chat/completions`                  | streaming via `stream:true`                   |
| Vision        | `POST /v1/chat/completions`                  | `image_url` content parts (data URL or http)  |
| Text → Image  | `POST /v1/images` · `/v1/images/generations` | `{prompt, aspect_ratio?, resolution?, seed?}` |
| Image → Image | `POST /v1/images` · `/v1/images/edits`       | `input_references:[{image_url:{url}}]`        |
| Speech → Text | `POST /v1/audio/transcriptions`              | multipart `file` (whisper)                    |
| Text → Speech | `POST /v1/audio/speech`                      | `{input, voice?}` → `audio/wav` (Kokoro)      |
| Embeddings    | `POST /v1/embeddings`                        | local `all-MiniLM-L6-v2`, 384-dim             |
| Models        | `GET /v1/models`                             | the active model per modality                 |

- **Interactive docs**: `GET /docs` (Scalar) · **spec**: `GET /openapi.json`.
- **Load-on-demand**: models load when a request needs them and offload after — long
  requests return a `request_id` you can poll, so one machine serves every modality without
  cramming them all into RAM at once.
- **Headless**: run only the gateway (no UI/capture) with `OFFGRID_SERVER_ONLY=1` or
  `--server-only` — ideal for deploying the gateway on its own box.

```bash
# chat
curl http://127.0.0.1:7878/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"local","messages":[{"role":"user","content":"Explain RAG in one line."}]}'
# image
curl http://127.0.0.1:7878/v1/images -H 'Content-Type: application/json' \
  -d '{"prompt":"a foggy mountain cabin at dawn","aspect_ratio":"16:9"}' --output out.png
```
