---
title: How to Run Voice-to-Text Locally on Your Desktop (Whisper, Offline Dictation)
published: false
description: Run private speech-to-text on your own Mac or PC with bundled whisper.cpp. Mic to text in the composer, on-device, no cloud transcription.
tags: ai, privacy, whisper, productivity
cover_image:
---

OpenAI trained Whisper on 680,000 hours of audio, and the small models that came out of it run on a laptop CPU in real time. That power sits idle while you pay a monthly subscription to send every voice note to someone else's server for transcription. Off Grid AI Desktop is a free, open-source app that runs Whisper directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API key, no audio leaving your machine.

## Why local dictation matters

Dictation is the fastest way to get words out of your head. You speak at about 150 words a minute. You type at maybe 40. The gap is the whole point.

But most dictation tools ship your voice to a cloud service. That means your half-formed ideas, your client names, your passwords read aloud by accident, all travel over the network. With local Whisper, none of it does. The audio is captured, transcribed, and turned into text on the same machine you are sitting at.

You get the speed of voice without handing your voice to anyone.

## What You Need

Whisper is light. Most of these models run fine on hardware you already own.

**Minimum**
- macOS: Apple Silicon (M1) or recent Intel, 8 GB RAM, macOS 13+
- Windows: any 64-bit CPU, 8 GB RAM, Windows 10+
- About 2 GB free disk for the app and a small Whisper model

**Recommended**
- macOS: M2 or newer, 16 GB unified memory
- Windows: NVIDIA GPU (CUDA) or a recent GPU with Vulkan, 16 GB RAM
- A USB or built-in mic with a clean signal

The transcription model itself is a few hundred megabytes. You are not downloading anything close to the size of a chat LLM.

## What Off Grid AI Desktop Can Do

Off Grid AI Desktop bundles `whisper.cpp`, a C++ port of Whisper that runs without Python and without a server you sign into. Here is what that buys you.

**Talk into the composer.** Click the mic, speak, and your words land as text in the chat box. You edit before you send. Dictate a long prompt to the local model instead of typing it.

**Capture thoughts hands-free.** Pacing the room, washing dishes, walking with the laptop open. Speak the idea while it is fresh and clean it up later.

**Keep medical, legal, and personal audio private.** If you dictate notes that name real people or describe real situations, on-device transcription means that audio never becomes someone else's training data or log entry.

**Pair it with the local LLM.** Dictate a rough question, let the on-device model answer, read the answer, dictate a follow-up. The whole loop stays on your hardware.

## How It Works

The flow is short. You press the mic. The app records audio from your input device. `whisper.cpp` loads the model into memory and decodes the audio into text. The text appears in the composer. That is the entire path, and every step happens locally.

Whisper models come in sizes, and the size is a trade between speed and accuracy:

| Model size | Disk | Good for | What to expect |
|---|---|---|---|
| tiny / base | ~75–150 MB | quick notes, fast machines | very fast, looser on accents and proper nouns |
| small | ~500 MB | everyday dictation | a solid balance for most people |
| medium | ~1.5 GB | accents, technical terms | slower, noticeably more accurate |

Start with small. Move up only if it mishears names or jargon you use a lot.

## How Hardware Acceleration Works

Whisper is small enough that even pure CPU transcription is usable. But acceleration helps, especially on the larger models.

On macOS, `whisper.cpp` uses Metal to run the model on the GPU, and Apple Silicon's unified memory means the CPU and GPU share the same pool with no copying back and forth. That is why a quiet M-series fanless laptop handles this so well.

On Windows, you get GPU acceleration through CUDA on NVIDIA cards or Vulkan on a broader range of GPUs. No compatible GPU? The CPU path still works, just a bit slower on the bigger models.

The models are quantized, stored in a compressed numeric format, so they fit in normal RAM and load quickly. That quantization is the reason this runs on consumer hardware at all.

## Tips for Cleaner Transcripts

A few habits raise accuracy more than swapping models does.

Get close to the mic. Whisper is robust to noise, but a clear signal always wins. Speak in full sentences rather than fragments, because the model uses context from surrounding words to resolve what it heard.

Pick the right model for your machine. If transcription lags behind your speech, drop to a smaller model. If it keeps mangling specific names, go one size up. You will find your match in a few minutes.

For long dictation, pause naturally between thoughts. Those pauses give the decoder clean boundaries and reduce run-on errors.

## Privacy: Stronger Than Cloud Dictation

A cloud dictation service receives your raw audio. It may store it, log it, attach it to your account, or use it to improve its product. You are trusting a privacy policy you did not write and cannot enforce.

Off Grid AI Desktop receives nothing, because there is no server. The app is AGPL-3.0 open source, so you can read exactly what it does with your audio, which is process it on your machine and discard it. No telemetry. No account. No upload. Pull the network cable and dictation still works.

## Getting Started

1. Open [the GitHub repo](https://github.com/off-grid-ai/desktop) and grab the latest release for macOS or Windows, or clone and build from source.
2. Install and launch Off Grid AI Desktop.
3. Download a Whisper model from inside the app (start with small).
4. Open a chat, click the mic in the composer, and allow microphone access when your OS asks.
5. Speak. Watch the text appear. Edit and send.

That is it. No sign-up wall, no key to paste.

## What's Coming

- More transcription languages and model sizes selectable in the app
- Push-to-talk and hotkey dictation outside the composer
- Tighter integration with the meeting recorder for live captions
- Cross-device sync so a phrase dictated on one machine reaches another

## FAQ

### Q: Is it really free?
Yes. The app is free and open source under AGPL-3.0. No trial, no paywall on dictation.

### Q: Does it work offline?
Completely. After the model is downloaded, you can turn off your network and dictation keeps working.

### Q: Which Whisper model should I use?
Start with small for everyday use. Go to medium if you need better handling of accents or technical vocabulary, and tiny or base if your machine is older.

### Q: How much RAM do I need?
8 GB is enough for the smaller models. 16 GB gives you headroom to run the larger model alongside the local chat LLM.

### Q: Does it work on Windows as well as Mac?
Yes. macOS uses Metal, Windows uses CUDA or Vulkan, and both fall back to CPU when there is no compatible GPU.

### Q: Is my voice ever uploaded?
No. There is no server to upload to. Audio is transcribed on your machine and not retained.

Run Whisper on your own hardware, keep your voice to yourself.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
