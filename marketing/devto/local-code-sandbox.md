---
title: "A Local Code Sandbox: Run AI-Generated Code Safely On-Device (No Cloud)"
published: true
description: Off Grid AI Desktop renders model-written HTML, JS, and React in a sandboxed iframe with no network and no file access. On-device, no cloud.
tags: ai, privacy, javascript, opensource
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/local-code-sandbox.jpg
---

Every modern laptop ships with a browser engine that can run untrusted code in a locked box. That same sandbox sits idle while you paste AI-generated snippets into a cloud playground that logs everything you send it. Off Grid AI Desktop is a free, open-source app that runs a local code sandbox directly on your machine, with no network and no file access.

**[GitHub →](https://github.com/off-grid-ai/desktop)** Free, open-source, runs offline.

## The problem with running AI code

You ask a model to build a small UI. It hands back a block of React. Now what.

Option one: paste it into a browser console or a fresh HTML file. You read it line by line first, because you have no idea what it does. Option two: drop it into a cloud playground. Fast, but every keystroke leaves your machine and lands on someone else's server.

Both options leak. Cloud playgrounds see your code and often your prompt. Local files give the script your filesystem. Neither is what you want for code you did not write.

Off Grid AI Desktop gives you a third path. The model writes the code on-device. The code runs on-device. The sandbox cannot reach the internet and cannot read a single file.

## What you need

This runs on macOS and Windows. The sandbox itself is light. The local model that writes the code is the part that wants memory.

| Tier | Hardware | What you get |
|---|---|---|
| Minimum | 16 GB RAM (Apple Silicon or a recent PC), 10 GB free disk | Small models write HTML and simple JS; preview renders instantly |
| Recommended | 24 GB+ unified memory (Mac) or an 8 GB+ GPU (NVIDIA/Vulkan) | Larger models write React components and Mermaid diagrams without stalling |

The preview pane is just a sandboxed browser frame. It costs almost nothing to render. Your hardware budget goes to the model.

## What Off Grid AI Desktop can do here

Ask the local model for a component, a chart, or a layout. It writes the code. The app renders it live in a sandboxed iframe, and you flip between the source and the running result.

<!-- GIF: user asks the local model for a React counter, code streams in, preview renders it live -->

You get:

- **A live preview of model-written HTML, SVG, JS, and React.** You see the thing run, not a description of it.
- **A Code/Preview toggle.** Read the source, then watch it execute. One click between them.
- **Download.** Save the output and use it wherever you want.
- **Mermaid diagrams.** Ask for a flowchart in plain English, get a rendered diagram.

<!-- GIF: Code/Preview toggle flipping back and forth on a rendered chart -->

The point is speed with a hard safety boundary. You read code when you want to. You do not have to read it to know it cannot phone home or touch your disk.

## How the sandbox works

The preview runs inside a sandboxed iframe. Two restrictions matter most.

No network access. The frame cannot make a fetch call, load a remote script, or open a socket. If the model writes code that tries to beacon out, the call goes nowhere.

No file access. The frame cannot read your home directory, your documents, or anything else on disk. It runs in its own walled box with nothing behind it.

So when the model writes React, where does React come from. Not a CDN. The runtimes ship inside the app.

## Offline runtimes, no CDN

Most live-preview tools pull React, a JSX compiler, and a diagram library from a content delivery network at render time. That means a network call every time you preview, and a hard dependency on being online.

Off Grid AI Desktop bundles those runtimes in app resources:

- **React (UMD build)** for components.
- **Babel-standalone** to compile JSX in the browser frame.
- **Mermaid** for diagrams.

They live on disk inside the app. No CDN, no fetch, no version that changes under you. The preview renders the same way on a plane as it does at your desk. This is also why the no-network rule does not break anything: the frame never needed the network in the first place.

```text
model writes code  ->  Code/Preview toggle  ->  sandboxed iframe
                                                  no network
                                                  no file access
                                                  bundled React + Babel + Mermaid
```

## A practical tip: read the code, then trust the box

The natural worry with AI code is that it does something you did not ask for. A normal sandbox asks you to audit every line before you run it. This one inverts the order.

Flip to Preview first. The frame has no network and no disk, so even hostile code has nothing to act on. Watch the behavior. If you like it, flip to Code and read the source, then download. You audit because you want clean code, not because you are scared of it.

For React work, keep components self-contained. The bundled UMD build covers React itself. Ask the model to write standard hooks and JSX rather than reaching for an obscure third-party package the bundle does not carry.

## Privacy: stronger than a cloud playground

A cloud playground sees your prompt, your code, and your edits. Many keep them. Your draft of a half-working idea becomes a row in someone's database.

Off Grid AI Desktop sees none of that, because there is no server in the loop. The model runs on your machine. The sandbox runs on your machine. Off Grid AI Desktop is open source under AGPL-3.0, takes no account, sends no telemetry, and works with your network cable unplugged. The code you generate is yours and stays on your disk.

## Getting started

1. Clone or download from GitHub: https://github.com/off-grid-ai/desktop
2. Install the app on macOS or Windows.
3. Launch it and pick a local model from the built-in models browser.
4. Open a chat and ask for something visual. Try "build a small React card component" or "draw a flowchart for a login flow in Mermaid."
5. When the code arrives, flip to Preview to watch it run, then to Code to read it. Download if you want it.

## What's coming

- More bundled runtimes so the sandbox covers a wider range of model output.
- A shared local API so other on-device tools can reuse the same preview.
- Cross-device sync so a sandbox you build on one machine shows up on another, still without a cloud middleman.

## FAQ

### Q: Is it really free?

Yes. Off Grid AI Desktop is free and open source under AGPL-3.0. No account, no card.

### Q: Can the AI code reach the internet from the preview?

No. The sandboxed iframe has no network access. A fetch call or remote script load from inside the preview goes nowhere.

### Q: Can the preview read my files?

No. The frame has no file access. It cannot read your home folder or anything else on disk.

### Q: Does it need to be online to render React?

No. React, Babel-standalone, and Mermaid are bundled in app resources. There is no CDN call, so the preview works fully offline.

### Q: What can the model write and preview?

HTML, SVG, plain JavaScript, React components, and Mermaid diagrams. Flip between Code and Preview, and download the result.

### Q: Mac or Windows?

Both. The app runs on macOS (Apple Silicon) and Windows (CUDA or Vulkan GPU, with CPU fallback).

Run AI-generated code without handing it your network or your files. **[Off Grid AI Desktop on GitHub →](https://github.com/off-grid-ai/desktop)**
