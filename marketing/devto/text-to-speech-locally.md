---
title: How to Run Text-to-Speech Locally on Your Desktop in 2026 (Kokoro, Offline Voice)
published: false
description: Run open-weight TTS on your own Mac or PC with Kokoro-82M. Per-message Speak and an auto-speak voice mode, on-device, no cloud TTS API.
tags: ai, privacy, tts, opensource
cover_image:
---

Kokoro-82M is a text-to-speech model with 82 million parameters, small enough to fit in a few hundred megabytes, yet it produces voices that hold up against systems many times its size. That quality sits idle while you pay per character to a cloud TTS API that meters every word you synthesize. Off Grid AI Desktop is a free, open-source app that runs Kokoro directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API key, no text leaving your machine.

## Why local text-to-speech matters

Cloud TTS bills by usage. A long article, a book chapter, a daily digest read aloud, those characters add up, and the meter keeps running. Worse, every line you send to be spoken is a line you hand to someone else's server.

Local TTS removes both problems. You synthesize as much as you want for free, and the text never leaves your machine. Read your own notes back to you. Turn a chat answer into audio. Build a voice mode that talks to you while you work, all without a usage bill or a privacy trade.

You own the voice and you own the text.

## What You Need

Kokoro is tiny by model standards, so the bar is low.

**Minimum**
- macOS: Apple Silicon (M1) or recent Intel, 8 GB RAM, macOS 13+
- Windows: any 64-bit CPU, 8 GB RAM, Windows 10+
- About 2 GB free disk for the app and the voice model

**Recommended**
- macOS: M2 or newer, 16 GB unified memory
- Windows: NVIDIA GPU (CUDA) or a GPU with Vulkan, 16 GB RAM
- Decent speakers or headphones

At 82 million parameters, Kokoro runs comfortably on a CPU. A GPU makes it snappier, but it is not required.

## What Off Grid AI Desktop Can Do

Off Grid AI Desktop bundles Kokoro-82M, an open-weight, multilingual TTS model, and wires it into the chat interface. Here is what you get.

**Speak any message.** Every reply from the local model has a Speak control. Click it and hear the answer read aloud in a natural voice. Useful when your eyes are busy or your screen is full.

**Turn on voice mode.** Flip auto-speak on and the model reads each new answer out loud as it arrives. Ask a question, then look away and listen. The chat becomes a conversation you can have hands-free.

**Read long text without straining your eyes.** Paste a document or generate a summary, then have it read back to you while you rest your eyes or walk around.

**Stay private with sensitive text.** If the words being spoken include client details, health notes, or anything personal, on-device synthesis means that text is never sent anywhere to be voiced.

## How It Works

The path is short and stays on your machine. You click Speak, or auto-speak triggers on a new message. The app passes the text to Kokoro running locally. The model generates an audio waveform. Your speakers play it. No request leaves the device.

Kokoro is multilingual and ships with a set of voices. Picking one is a matter of taste:

| Choice | What it affects | What to expect |
|---|---|---|
| Voice | timbre and accent | pick the one that is easiest for you to listen to |
| Auto-speak on | reads every reply | best for hands-free, listen-while-you-work sessions |
| Auto-speak off | per-message Speak only | best when you want audio only sometimes |

There are no per-character costs to manage, so synthesize freely.

## How Hardware Acceleration Works

Because Kokoro is small, the model loads fast and synthesizes quickly even on modest hardware.

On macOS, generation runs on Apple Silicon with Metal acceleration, and unified memory keeps the CPU and GPU working from the same pool. A fanless laptop handles this without breaking a sweat.

On Windows, you get acceleration through CUDA on NVIDIA cards or Vulkan on a wider range of GPUs, with a CPU fallback that still performs well given the model's size.

The model weights are quantized, stored compactly, so they fit in ordinary RAM and start fast. That is what makes a high-quality voice viable on a normal desktop.

## Tips for Better Playback

A few small choices improve the listening experience.

Pick a voice you can listen to for a while, not just the first one. You will be hearing it a lot, and comfort matters more than novelty.

Keep auto-speak off when you are skimming and on when you commit to listening. Toggling it deliberately stops the app from reading things you only meant to glance at.

For long passages, let the audio play in the background while you do something else. Local synthesis has no meter, so there is no reason to ration it.

If a name or acronym is pronounced oddly, edit the text slightly before speaking it. Spelling something the way it sounds usually fixes the pronunciation.

## Privacy: Stronger Than Cloud TTS

A cloud TTS API receives every string you want spoken. It can log that text, tie it to your account, and bill you for it. You are trusting a vendor with the exact words you are reading.

Off Grid AI Desktop sends nothing, because there is no server. The app is AGPL-3.0 open source, so you can verify that synthesis happens on your machine and the audio is played, not uploaded. No telemetry, no account, no usage meter. Disconnect from the internet and the voice still speaks.

## Getting Started

1. Open [the GitHub repo](https://github.com/off-grid-ai/desktop) and download the latest release for macOS or Windows, or clone and build it yourself.
2. Install and launch Off Grid AI Desktop.
3. Download the Kokoro voice model from inside the app.
4. Open a chat, send a message, and click Speak on the reply.
5. Turn on auto-speak when you want every answer read aloud.

No sign-up, no key to paste, no character quota.

## What's Coming

- More Kokoro voices and languages selectable in the app
- Adjustable speaking rate and pitch
- Read-aloud for documents and captured notes, not just chat
- Cross-device sync so a voice set on one machine carries to another

## FAQ

### Q: Is it really free?
Yes. The app is open source under AGPL-3.0, and there is no per-character cost because synthesis runs locally.

### Q: Does it work offline?
Yes. Once the voice model is downloaded, TTS runs with no network connection.

### Q: Which model does it use?
Kokoro-82M, an open-weight multilingual TTS model that is small enough to run on a CPU yet sounds natural.

### Q: How much RAM do I need?
8 GB is enough. 16 GB lets you run TTS alongside the local chat model comfortably.

### Q: Does it work on Windows as well as Mac?
Yes. macOS uses Metal, Windows uses CUDA or Vulkan, and both fall back to CPU.

### Q: Is the text I speak ever uploaded?
No. There is no server. Text is turned into audio on your machine and the audio is played locally.

Run a high-quality voice on your own hardware, keep your text to yourself.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
