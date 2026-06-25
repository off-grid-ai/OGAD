---
title: How to Transcribe Meetings Locally in 2026 (Whisper, On-Device)
published: false
description: Record and transcribe Zoom and Google Meet calls entirely on-device with whisper.cpp. No cloud notetaker, no per-minute fees.
tags: ai, privacy, productivity, whisper
cover_image:
---

OpenAI's Whisper model runs accurate speech-to-text on a laptop GPU, and the C++ port runs it without Python or a cloud account. That capability sits unused while teams pay per-minute fees to upload their calls to a transcription service. Off Grid AI Desktop is a free, open-source app that records and transcribes your meetings directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API key, no telemetry.

## What This Gets You

You want a searchable record of what was said, not a subscription to a notetaker bot. Here is the difference local transcription makes.

The audio never leaves your machine, so a confidential call stays confidential. There is no per-minute meter, so a three-hour planning session costs the same as a five-minute standup, which is nothing. The transcript and summary save to your disk, so you own the record instead of renting access to it.

## What You Need

Whisper comes in several sizes. The bigger ones transcribe better and want more memory.

| Tier | macOS | Windows | RAM / VRAM | Free disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1 | Any modern CPU or iGPU | 8 GB | 10 GB |
| Recommended | M2 / M3 / M4 | NVIDIA RTX (6 GB+ VRAM) | 16 GB+ | 20 GB |

On the minimum tier, a smaller Whisper model transcribes a one-hour call in a few minutes after it ends. The recommended tier runs the larger, more accurate models and finishes faster. CPU transcription works everywhere; a GPU just speeds it up.

## How the Meeting Recorder Works

The recorder captures three streams at once: the screen video, the system audio coming out of your speakers, and your microphone. That covers both sides of a Google Meet or Zoom call, the remote participants on system audio and you on the mic.

When you stop, the bundled `whisper.cpp` engine transcribes the captured audio locally. There is no upload step. The transcription is the same model the cloud services use, running on your own hardware.

After the transcript is ready, the local LLM reads it and generates a title, a summary, and a list of the people mentioned. You get a usable meeting note without rewatching the recording or paying a notetaker.

## Why On-Device Transcription Is Viable Now

Whisper ships as quantized weights, which stores the model at lower precision so it fits in consumer RAM without losing meaningful accuracy. That is the change that moved good transcription off the cloud and onto a laptop.

On macOS, transcription runs through Metal against Apple Silicon's unified memory. On Windows, you get CUDA on NVIDIA cards or a CPU path when there is no GPU. Either way the math runs locally, so the longer a call runs, the more you save versus a per-minute service.

## Getting Cleaner Transcripts

Audio quality drives transcription quality more than model size does. Use a headset or a decent mic so your own track is clean, and the result improves immediately.

Pick the model to match the job. A smaller Whisper model is fine for a quick internal sync where you just need the gist. Reach for a larger model when accuracy matters, like a client call you will quote from later. Recording system audio captures the remote side at the source, which beats a microphone picking it up off your speakers.

## Privacy: Stronger Than a Cloud Notetaker

A cloud notetaker uploads your full meeting audio and video to a server you do not control. The recording, the transcript, and the summary all live there. Off Grid AI Desktop keeps every part of that on your machine, because there is no server in the path.

It is AGPL-3.0 licensed, so the code is auditable. There is no account and no telemetry. The recorder requires an explicit start and stop, and a visible recording indicator stays on the whole time, so nothing records silently in the background.

## Getting Started

1. Download or clone from [the GitHub repo](https://github.com/off-grid-ai/desktop).
2. Install and launch the app on your Mac or PC.
3. Open the Models browser and download a Whisper model plus a local LLM for summaries.
4. Start a recording before your call, confirm the indicator is on.
5. Stop when the call ends. Read the transcript, title, and summary.

```bash
git clone https://github.com/off-grid-ai/desktop
cd desktop
npm install
npm run dev
```

## What's Coming

- Cross-device sync so meeting notes follow you between machines.
- Unified search across transcripts and the rest of your captured work.
- More transcription models as new open-weight releases ship.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. There are no per-minute charges and no subscription.

### Q: Does it work offline?
Yes. Recording and transcription both run with no network connection.

### Q: Does it work with Zoom and Google Meet?
Yes. It records the screen, system audio, and mic, so it captures both sides of any call in your browser or a desktop client.

### Q: How accurate is the transcription?
It runs Whisper, the same model behind many cloud transcription tools. Accuracy depends on the model size you pick and your audio quality.

### Q: How much RAM do I need?
8 GB runs a smaller Whisper model. 16 GB or more is comfortable for the larger, more accurate ones.

### Q: Is my meeting audio private?
Yes. The audio, transcript, and summary stay on your machine. Nothing uploads.

Transcribe your calls on hardware you already own. **[GitHub →](https://github.com/off-grid-ai/desktop)**
