---
title: "Fully Open Source, Fully Private: How Off Grid AI Desktop Keeps Your AI On-Device"
published: true
description: AGPL open source, everything on-device, no account, no telemetry, no API keys. What private actually means, and why open source is the proof.
tags: ai, privacy, opensource, security
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/fully-open-source-private-ai.jpg
---

Most "private AI" apps ask you to trust a privacy policy you cannot read and a server you cannot inspect. Your prompts, documents, and screenshots still travel to someone else's machine, and you take their word for what happens next. Off Grid AI Desktop is a free, open-source app where your data never leaves your Mac or PC, and the source code is right there to prove it.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source (AGPL-3.0), runs offline. No account, no telemetry.

## "Private" has been watered down

Cloud vendors use the word freely. They mean encryption in transit, an account you can delete, a toggle that turns off training. Your data still leaves your machine. You are trusting a promise.

Off Grid means something stricter. The data does not move. The model runs on your hardware, reads your local files, and writes its answers back to your disk. There is no server we own in the path, because there is no server at all.

That is a different claim, and it is one you can check yourself.

## What runs locally, and how

The whole stack is on-device, processed by bundled engines.

- **Chat and reasoning.** A `llama.cpp` server runs local GGUF models like Gemma and Qwen.
- **Image generation.** `stable-diffusion.cpp` runs SDXL and Z-Image on your GPU.
- **Voice.** `whisper.cpp` for speech to text, Kokoro-82M for text to speech.
- **Documents.** On-device embeddings and a local vector store power RAG, so you chat with your own PDFs and get cited sources.
- **Storage.** `better-sqlite3` keeps everything in a local database in your user data folder.

No request goes out to a model API, because the model is on your disk.

## What "no account" buys you

There is no sign-up, no login, no email. That is not a convenience feature. It is a privacy guarantee.

No account means no central profile that ties your prompts to your identity. No password to breach. No "export my data" request to file, because the data was never collected. You open the app and it works, the way a text editor works.

There is also no telemetry. The app does not count your sessions, time your generations, or report crashes to us. And there are no API keys, because there is no third party to authenticate against.

## How capture stays honest

The one feature that watches your screen is the one that has to earn the most trust. Here is how it is built.

Screen capture is opt-in, per device. It is off until you turn it on. While it runs, a recording indicator is visible, so the machine never watches you silently. The captured frame becomes OCR text, and the local model distills it into observations and entities. The same opt-in rule covers the meeting recorder, which records screen video, system audio, and mic only after an explicit start, with the indicator showing, then transcribes locally with whisper.

You decide when the app sees anything. The default is that it sees nothing.

## How connectors stay private

MCP connectors let the app talk to tools like Notion, Linear, and Jira or Confluence. That sounds like the moment your data would leave. It does not.

The split is simple. Connectors fetch the data. The on-device model reasons over it. The reasoning never goes to a cloud model, because the model is local.

And the app never acts on your behalf without you. Actions are approval-gated. There is an approval queue and an audit log. The model proposes; you approve; the log records what happened. Action items detected from your communication are reviewable and never auto-sent.

## Why open source is the trust mechanism

A closed app that promises privacy is asking for faith. An open app under AGPL-3.0 is offering evidence.

| Claim | Closed cloud app | Off Grid AI Desktop |
|---|---|---|
| "Your data is private" | Trust the policy | Read the source |
| Where the model runs | Their servers | Your machine |
| What it sends home | Unknown | Nothing (verify it) |
| Who can audit it | The vendor | Anyone |
| If they change the terms | You find out later | The license stays AGPL |

AGPL matters specifically. It requires that modifications stay open, so a forked or hosted version cannot quietly close the source and start collecting data. The guarantee travels with the code.

You do not have to read every line. The point is that someone can, and that the binary is built from a tree you can inspect. Run a network monitor next to the app and watch it stay quiet with the model loaded.

## A local gateway, still on your machine

Off Grid ships an OpenAI-compatible API at `http://127.0.0.1:7878/v1`. Your own scripts and editor plugins can use the local models through it. The address is `127.0.0.1`, so the traffic never leaves the loopback interface. Same shape as a cloud API, none of the exposure.

## Getting started

1. Open [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop) and read the code if you want.
2. Download or clone, then install for macOS or Windows.
3. Launch the app, open the models browser, and download a GGUF model.
4. Start chatting offline. Turn on capture only if and when you want it.
5. Point a network monitor at it and confirm it stays quiet.

## What is coming

- Cross-device sync over a private mesh, so paired devices share memory without a server in the middle.
- Using the local gateway from other paired devices over that mesh.
- More bundled open-weight models.

## FAQ

### Q: Is it really free and open source?
Yes. AGPL-3.0. The source is public and you can build from it.

### Q: Does anything leave my machine?
No. The local stack here runs offline. No telemetry, no account, no API keys.

### Q: How do I know capture is not always on?
It is opt-in per device and shows a visible indicator while running. It is off by default.

### Q: Do MCP connectors send my data to the cloud?
No. Connectors fetch data; the on-device model reasons over it. Actions are approval-gated with an audit log.

### Q: Why does the AGPL license matter to me?
It keeps the code open even if someone forks or hosts it, so the privacy guarantee cannot be quietly stripped out.

### Q: Can I verify the privacy claim myself?
Yes. Read the source, and watch the network with a monitor while the app runs offline.

Private because of how it is built, open so you can confirm it. **[See the source on GitHub →](https://github.com/off-grid-ai/desktop)**
