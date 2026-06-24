# Off Grid AI Desktop — agent guide

This is **Off Grid AI Desktop** — an Electron (macOS) desktop app. The product name is always **"Off Grid AI Desktop"** (never "Off Grid Desktop", "My Memories", etc.) — in window titles, OAuth client names, about screens, everywhere.

## Design — DESKTOP-FIRST, Off Grid brand

Full design doc: **`docs/DESIGN.md`**. The essentials, which OVERRIDE any mobile-first or monochrome assumptions:

- **Desktop-first.** Wide canvas: multi-column layouts, dense lists/tables, side panels, detail screens, hover affordances. Never design mobile-first or for narrow viewports. (The mobile app is a separate product with its own guide.)
- **Typeface: Menlo** (monospace) everywhere — terminal/brutalist.
- **Accent: emerald** — `#34D399` (dark) / `#059669` (light). THE accent for primary actions, active states, links, success. (Tailwind `green-500/400` is an acceptable stand-in but prefer the exact tokens.)
- **Base:** black / `#0A0A0A` + white; neutral grays for surfaces/borders/text tiers. Flat, sharp, dense.
- Tokens: `@offgrid/design`. Brand canon: `mobile/docs/design/DESIGN_PHILOSOPHY_SYSTEM.md` (brand only — desktop *layout* follows `docs/DESIGN.md`, desktop-first).
- Real brand logos (Simple Icons), no decorative tiles behind them; no gradients; no emojis in the UI.

## What this app is

A private, **local-first** layer that **sees** (screen capture → OCR → entities), **remembers** (observations/entities/memory), helps you **reflect** (mind-share / day), and **acts** (MCP connectors + approval-gated actions). Everything is processed on-device by a bundled local LLM (llama.cpp + gemma); nothing routes through a server we own.

Roadmap: **`ROADMAP_DESKTOP.md`** (this repo) and `../shared/ROADMAP.md`.

## Stack

Electron 39 + React 19 + Tailwind v4 + electron-vite; better-sqlite3; bundled `llama-server` (port 8439), `whisper.cpp`, `ffmpeg`, `sharp`. Local LLM is a reasoning model — pass `chat_template_kwargs:{enable_thinking:false}` + grammar-constrained `response_format` for structured output. userData dir is `~/Library/Application Support/Off Grid AI Desktop`.

## Conventions

- Verify changes with `npx tsc --noEmit` (main: `tsconfig.node.json`, web: `tsconfig.web.json`) before declaring done.
- Main-process changes need an app restart; renderer changes hot-reload.
- Don't over-restart — it interrupts capture.
