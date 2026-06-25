---
title: How to Run a Private AI Meeting Notetaker (Zoom and Google Meet, On-Device)
published: false
description: A consent-first meeting notetaker that records, transcribes, and summarizes on-device. A private alternative to Otter and Fireflies.
tags: ai, privacy, productivity, meetings
cover_image:
---

When you invite a cloud notetaker to a call, a bot joins, records everyone, and ships the audio to a vendor's servers. Half the room often does not know it is there. Off Grid AI Desktop is a free, open-source app that records, transcribes, and summarizes your meetings on your own Mac or PC, with the recording in plain sight and the data never leaving the machine.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API key, no telemetry.

## Why a Local Notetaker

A meeting note is supposed to save you time, not hand your conversations to a third party. Here is what changes when the notetaker lives on your desktop.

There is no bot joining the call, so the only consent at stake is yours and your participants', not a vendor's terms of service. The recording, the transcript, and the summary all stay on your disk. There is no per-minute fee, so it costs nothing to keep notes on every call you take.

## What You Need

The notetaker runs Whisper for transcription and a local LLM for the summary. Both want a little memory.

| Tier | macOS | Windows | RAM / VRAM | Free disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1 | Any modern CPU or iGPU | 8 GB | 10 GB |
| Recommended | M2 / M3 / M4 | NVIDIA RTX (6 GB+ VRAM) | 16 GB+ | 20 GB |

The minimum tier handles a smaller Whisper model and a compact LLM fine. The recommended tier runs larger models and finishes the transcript faster. Both macOS and Windows are supported.

## Consent Comes First

The recorder does nothing until you press start. While it runs, a visible recording indicator stays on, so anyone watching your screen knows a capture is in progress, and you stop it with one action. There is no always-on listening and no bot lurking in the participant list.

That design is the point. A notetaker should make recording obvious, not hide it. You decide which calls get captured, and the indicator makes it honest for everyone in the room.

## How It Works

The recorder captures the screen video, the system audio, and your microphone together, so both sides of a Zoom or Google Meet call are covered. When you stop, the bundled `whisper.cpp` engine transcribes the audio locally, with no upload.

Then the local LLM turns the transcript into a real note: a title, a summary, and the people who came up. You get the outcome of the call without rewatching it.

The summary does not just sit in a folder. It folds into your private memory and your Day, the persisted journal of what you did, so a meeting becomes part of a searchable record of your work instead of a one-off file you forget about.

## Privacy: Stronger Than Otter or Fireflies

Cloud notetakers like Otter and Fireflies route your meeting audio and video through their servers. The recording, transcript, and summary live in their account, under their retention policy, with their access. Off Grid AI Desktop keeps all of it on your machine, because nothing in the pipeline touches a server.

It is AGPL-3.0 licensed, so the code is auditable rather than a black box. There is no account to breach and no telemetry phoning home. On an air-gapped machine, every part still works.

| | Cloud notetaker | Off Grid AI Desktop |
|---|---|---|
| Where audio goes | Vendor's servers | Your disk |
| Bot in the call | Yes | No |
| Per-minute fee | Often | None |
| Code you can audit | No | Yes (AGPL-3.0) |
| Works offline | No | Yes |

## Getting Started

1. Download or clone from [the GitHub repo](https://github.com/off-grid-ai/desktop).
2. Install and launch the app on your Mac or PC.
3. Open the Models browser and download a Whisper model plus a local LLM.
4. Press start before your call, confirm the recording indicator is on.
5. Stop when the call ends, then read the note in your Day.

```bash
git clone https://github.com/off-grid-ai/desktop
cd desktop
npm install
npm run dev
```

## What's Coming

- Cross-device sync so meeting notes follow you between machines.
- Unified search across meeting summaries and the rest of your memory.
- More transcription and summary models as new open-weight releases ship.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. No subscription and no per-minute charge.

### Q: How is this different from Otter or Fireflies?
No bot joins your call, and nothing uploads. Recording, transcription, and the summary all happen on your machine.

### Q: Does it work with Zoom and Google Meet?
Yes. It records the screen, system audio, and mic, so it captures both sides of any call.

### Q: How does it handle consent?
Recording is explicit start-and-stop, and a visible indicator stays on the whole time. Nothing records silently.

### Q: Does it work offline?
Yes. Recording, transcription, and summarizing all run with no network connection.

### Q: Where do my meeting notes live?
On your disk, folded into your private memory and your Day. No vendor account holds them.

Keep your meeting notes private, on hardware you already own. **[GitHub →](https://github.com/off-grid-ai/desktop)**
