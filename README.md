<p align="center">
  <img src="resources/icon.png" width="112" alt="Off Grid AI" />
</p>

<h1 align="center">Off Grid AI</h1>

<p align="center">
  <strong>Private, on-device AI. Your models, your data — no cloud, no accounts, no API keys.</strong>
</p>

<p align="center">
  Run open models — <em>text, vision, image, voice, and speech</em> — entirely on your machine,
  through one local OpenAI-compatible gateway.
</p>

<p align="center">
  <a href="https://github.com/off-grid-ai/desktop/releases/latest">Download for macOS</a> ·
  <a href="https://getoffgridai.co">getoffgridai.co</a> ·
  <a href="https://getoffgridai.co/early-access/">Pro early access</a>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/macOS-Apple%20Silicon-black" />
  <img alt="license" src="https://img.shields.io/badge/license-AGPL--3.0-blue" />
  <img alt="local" src="https://img.shields.io/badge/100%25-on--device-34D399" />
</p>

---

## What it is

Off Grid AI is a **local-first AI runtime** for your desktop. Download open models from the
built-in catalog (or any GGUF from Hugging Face) and use them across every modality — all
inference runs on your hardware via bundled `llama.cpp`, `stable-diffusion.cpp`,
`whisper.cpp`, and Kokoro. Nothing routes through a server we own; your conversations,
files, and models never leave your device.

It's also an **OpenAI-compatible gateway**: point any OpenAI client at
`http://127.0.0.1:7878/v1` (no key) and call chat, vision, image, audio, and embeddings
locally — or run it headless as just the gateway.

## Features (free & open source)

- **Chat** — text + vision, streaming, with a reasoning ("thinking") mode.
- **Image generation** — text→image and image→image via stable-diffusion.cpp (SDXL, etc.).
- **Voice** — speech-to-text (whisper) and text-to-speech (Kokoro), plus a hands-free voice mode.
- **Projects** — group chats, upload documents (txt/md/PDF/DOCX, audio, video) and chat grounded in them (RAG); per-project instructions.
- **Artifacts** — generate and preview HTML, React, SVG, Mermaid diagrams, and Markdown documents in a sandboxed canvas; saved per chat & project.
- **Connectors (MCP)** — add Model Context Protocol servers (none / token / OAuth), use them right inside chat. Preset catalog included.
- **Model catalog** — curated, size-bucketed recommendations + direct Hugging Face search; download, manage, and set the active model per modality.
- **The Gateway** — one OpenAI-compatible endpoint for everything; see below.
- **Auto-update** — signed releases update themselves.

## The Gateway

One local server (`http://127.0.0.1:7878`) speaks the OpenAI API:

| Capability | Endpoint |
|---|---|
| Chat (text + vision) | `POST /v1/chat/completions` |
| Text → Image | `POST /v1/images` (`/generations`, `/edits`) |
| Speech → Text | `POST /v1/audio/transcriptions` |
| Text → Speech | `POST /v1/audio/speech` |
| Embeddings | `POST /v1/embeddings` |
| Models | `GET /v1/models` |

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"Hello!"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:7878/v1", api_key="not-needed")
print(client.chat.completions.create(model="local",
      messages=[{"role":"user","content":"Hello!"}]).choices[0].message.content)
```

Interactive API reference + an OpenAPI spec are served at `/docs` and `/openapi.json`.
Run **just the gateway** (no UI/capture) with `OFFGRID_SERVER_ONLY=1` (or `--server-only`).

## Off Grid Pro — coming July 2026

The free app **runs** models. **Pro** adds the layer that *sees, remembers, and acts* —
always on, on-device:

- **Never forgets** — it quietly remembers everything you see and do.
- **Unified search** — find anything across your captured activity, meetings, and connectors.
- **Private CRM** — people, projects, and companies, auto-built with cross-source summaries.
- **Day · Reflect · Replay** — your day planned, where your time goes, rewind your screen.
- **Meetings** — record + transcribe locally.
- **Proactive secretary** — surfaces what matters and drafts actions (approval-gated).
- **Skills automation** — trigger → action (schedule / keyword / event).

→ **[Join early access](https://getoffgridai.co/early-access/)** (free) — or
**[pay now](https://getoffgridai.co/pay)** for lifetime free + first access when Pro ships.

## Install

Download the latest **macOS** DMG from [Releases](https://github.com/off-grid-ai/desktop/releases/latest)
(Apple Silicon, signed + notarized). Windows and Linux builds are in progress.

## Build from source

```bash
git clone https://github.com/off-grid-ai/desktop.git
cd desktop
npm install
npm run dev          # full app
npm run gateway      # headless gateway only (:7878)
npm run build:mac    # package a macOS app
```

Stack: Electron + React 19 + Tailwind v4 (electron-vite), `better-sqlite3-multiple-ciphers`
(encrypted local DB), `@lancedb/lancedb` (vectors), bundled `llama.cpp` / `whisper.cpp` /
`stable-diffusion.cpp` / `ffmpeg` in `resources/bin`. Shared `@offgrid/*` packages (design,
models, rag) come from the workspace.

## Architecture — open core

This repository is the **open, AGPL core**: the model runner, gateway, chat, projects,
artifacts, connectors, and the model catalog. Pro features live in a separate **private**
package loaded as a git submodule (`pro/`). The core **never imports pro** — pro registers
itself through small registries (an `activate()` pattern) and is simply absent in this build,
so the open app compiles and runs entirely on its own.

## Privacy

All model inference is local. Your conversations, documents, and models stay on your device
— there's no cloud inference, no account, and no API key. You can run it fully offline.

## License

[AGPL-3.0-only](LICENSE). © Off Grid AI / Wednesday Solutions, Inc.
