---
title: "The All-in-One Local Voice AI: Built-in TTS, STT, and Audio Mode (On-Device)"
published: true
description: Talk to your AI and have it talk back, fully on-device. Built-in whisper.cpp for speech-to-text and Kokoro for text-to-speech. No cloud.
tags: ai, privacy, tts, whisper
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/all-in-one-local-voice-ai.jpg
---

A modern laptop can transcribe speech and synthesize a human voice without ever touching the internet. The chips have shipped for years. Yet most people still pipe their voice to a cloud API and pay per character to hear an answer read aloud.

Off Grid AI Desktop is a free, open-source app that runs both directions of voice directly on your machine.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API keys, no telemetry.

## The gap in local AI tools

Local AI tools have gotten good at chat. Type a message, get a local model's reply, never leave the device. Voice is where they fall down.

Most local tools do neither direction of voice. Some add speech-to-text so you can dictate. A few add text-to-speech so the answer reads aloud. Almost none do both, in one app, with a hands-free mode that ties them together.

Off Grid AI Desktop does both. You talk, it transcribes locally. It answers, and it speaks the answer locally. Turn on the voice mode and you get a back-and-forth conversation with no keyboard and no cloud.


## What you need

Voice models are small, so the bar is low.

**Minimum:** any Apple Silicon Mac (M1 or later) or a Windows PC with 8 GB RAM and a recent CPU. A few gigabytes of free disk for the voice models.

**Recommended:** 16 GB RAM so your chat model and the voice models sit in memory together. On Windows, an NVIDIA GPU (CUDA) or a Vulkan-capable GPU keeps transcription quick.

The chat model is the heavy part. Whisper and Kokoro are light next to it.

## Voice in: speech to text with whisper.cpp

Off Grid AI Desktop bundles whisper.cpp, the C++ port of OpenAI's Whisper. Tap the mic in the composer and talk. Your speech becomes text right there, ready to send.

Whisper handles many languages. You can dictate in Spanish, French, German, Japanese, and dozens more. The audio is processed on your device. Nothing is uploaded for transcription.

This is the input you reach for when typing is slow. Long prompts, rambling thoughts, notes while your hands are busy. Speak them and edit the text before you hit send.


## Voice out: text to speech with Kokoro-82M

For the other direction, Off Grid AI Desktop ships Kokoro-82M, an open-weight text-to-speech model. It is small, it is multilingual, and the voice quality is well above robotic.

Every message has a Speak button. Press it and that message reads aloud. Useful when you want to listen to a long answer while you look at something else, or when you want to proofread by ear.

There is no per-character fee. Cloud TTS bills you by the character or the second. Kokoro runs on your hardware, so you can read aloud a whole document and it costs nothing but a little compute.


## Audio mode: hands-free back-and-forth

The two directions combine into a voice mode. Turn on auto-speak and the loop runs itself. You speak, the model answers, the answer reads aloud, you speak again. No clicking, no typing.

This is the part most local setups never reach. Stitching Whisper and a TTS engine together by hand is a project. Here it is one toggle.

Cook dinner and ask questions. Pace the room and think out loud. Drive a brainstorm with your hands free. The conversation stays a conversation, and all of it stays on the device.


## How it runs on your hardware

Both voice models are compiled native code, not Python wrappers waiting on a server.

On a Mac, whisper.cpp uses the Apple Silicon GPU through Metal and the unified memory pool, so it shares RAM with everything else cleanly. On Windows, it uses CUDA on NVIDIA cards or Vulkan elsewhere, with a CPU fallback that still works.

Kokoro-82M has 82 million parameters. That is tiny next to a chat model with billions. It loads fast and synthesizes quickly even on modest machines. Small model, real voice.

## Keeping it fast

A few practical notes.

Pick a chat model that fits your RAM with room to spare. The voice models need their own slice of memory, so do not max out your chat model and leave nothing for them.

For dictation, speak in normal sentences and pause at the end. Whisper does better with clean phrasing than with a single forty-second run-on.

For voice mode, shorter answers feel snappier. If replies drag, lower the chat model's max output length so the spoken turn does not run long.

## Privacy: stronger than cloud voice

Cloud voice assistants send your microphone audio to a server. Cloud TTS sends your text to a server and meters it. You get a bill and a log of everything you said and everything you had read back.

Off Grid AI Desktop sends none of it. Whisper transcribes on your machine. Kokoro synthesizes on your machine. The app is AGPL-3.0, so you can read the source and confirm it. No account, no telemetry, no audio leaving the device.

## Getting started

1. Go to the repo at https://github.com/off-grid-ai/desktop and grab the latest release for your OS, or clone and build it yourself.
2. Install and launch the app.
3. Download a chat model from the built-in model browser.
4. Click the mic in the composer to dictate, or click Speak on any reply to hear it.
5. Toggle the voice mode to run a hands-free conversation.


## What's coming

- More TTS voices and finer control over speed and tone.
- Wider language coverage tuned for both directions.
- Using the local voice stack from other paired devices over the mesh.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. No account, no subscription, no API keys.

### Q: Does voice work offline?
Yes. Both whisper.cpp and Kokoro run on your device. After the models download, you can transcribe and speak with the network off.

### Q: What languages are supported?
Whisper transcribes dozens of languages. Kokoro is multilingual for output. You can dictate and listen in many languages, not just English.

### Q: How much RAM do I need?
8 GB runs the voice models with a small chat model. 16 GB gives the chat model and the voice models comfortable room together.

### Q: Does it work on both Mac and Windows?
Yes. Apple Silicon uses Metal. Windows uses CUDA or Vulkan, with a CPU fallback.

### Q: Is my voice data private?
Yes. Your microphone audio and your text never leave the machine. There is no telemetry and the source is open for inspection.

Talk to your AI and hear it answer, all on your own hardware.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
