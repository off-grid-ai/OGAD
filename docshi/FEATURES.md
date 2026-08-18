# Off Grid AI — Features

A deep dive on everything the free, open-source app does. All of it runs **on your
device** — no cloud inference, no account, no API key. Each feature has its own page:

<p align="center"><img src="screenshots/08-onboarding.png" alt="Off Grid AI" width="720" /></p>

## The studio

| Feature                                          | What it does                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| [The Gateway](features/gateway.md)               | One local OpenAI-compatible API for every model — chat, vision, image, audio, embeddings. |
| [Chat](features/chat.md)                         | Text + vision + reasoning, streaming, tabs, tools, voice mode, project scoping.           |
| [Image generation](features/image-generation.md) | Text→image and image→image (SDXL GGUFs), styles, LoRA, live previews.                     |
| [Voice & speech](features/voice.md)              | Speech→text (whisper) and text→speech (Kokoro), hands-free voice mode.                    |
| [Projects (RAG)](features/projects.md)           | Group chats, upload docs, chat grounded in them with cited retrieval.                     |
| [Artifacts](features/artifacts.md)               | HTML / React / SVG / Mermaid / Markdown rendered in a sandboxed canvas.                   |
| [Connectors (MCP)](features/connectors.md)       | Add Model Context Protocol servers (none / token / OAuth), use them in chat.              |
| [Models](features/models.md)                     | Curated, size-bucketed catalog + Hugging Face search; per-modality active model.          |

## Platform

| Topic                                                | What it covers                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [Privacy & data](features/privacy.md)                | 100% local inference, encryption at rest, fully offline.        |
| [Architecture (open core)](features/architecture.md) | The AGPL core, the `pro/` submodule, and the `activate()` seam. |
| [Off Grid Pro](features/pro.md)                      | The sees / remembers / acts layer — **coming July 2026**.       |

---

> New here? Start with [the Gateway](features/gateway.md) (point any OpenAI client at
> `http://127.0.0.1:7878/v1`) or just open [Chat](features/chat.md).
