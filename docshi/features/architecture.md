# Architecture (open core)

[← All features](../FEATURES.md)

This repo is the **open, AGPL-3.0 core** — the model runner, gateway, chat, projects,
artifacts, connectors, and catalog. Pro features live in a separate **private** package
loaded as a git submodule. The core **never imports pro**: pro registers itself through small
registries (an `activate()` pattern) and is simply absent here, so the open app builds and
runs entirely on its own. A build-time flag (`__OFFGRID_PRO__`) decides whether pro is
present, and `OFFGRID_PRO=0` simulates an unlicensed install locally.

## Stack

Electron 39 + React 19 + Tailwind v4 (electron-vite), `better-sqlite3-multiple-ciphers`
(encrypted local DB), `@lancedb/lancedb` (vectors), and bundled `llama.cpp` / `whisper.cpp`
/ `stable-diffusion.cpp` / `ffmpeg` in `resources/bin`. Shared `@offgrid/*` packages
(design, models, rag) come from the workspace.
