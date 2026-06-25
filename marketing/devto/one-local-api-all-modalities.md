---
title: One Local API for Chat, Vision, Images, Speech, and Embeddings (On-Device, 2026)
published: true
description: A single OpenAI-compatible endpoint that does text, vision, image generation, transcription, TTS, and embeddings, all on-device with no cloud.
tags: ai, privacy, multimodal, opensource
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/one-local-api-all-modalities.jpg
---

A modern laptop has a GPU and unified memory that can run a chat model, a vision model, a diffusion model, and a whisper transcriber. Most of that silicon sits idle while you pay a monthly bill to call those same models on someone else's server, over the internet, with your data in transit. Off Grid AI Desktop is a free, open-source app that runs all of those models directly on your Mac or PC, and exposes them through one local HTTP API.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**

Free, open-source (AGPL-3.0), runs offline.

## The short version

Off Grid AI Desktop ships a local server at `http://127.0.0.1:7878/v1`. It speaks the OpenAI API shape. One base URL covers six modalities: chat, vision, embeddings, speech-to-text, text-to-speech, and image generation. It binds to loopback only, so it never faces the internet. There is no API key, no account, no cloud hop. You point any OpenAI SDK at the base URL and your existing code works.

That is the whole pitch. The rest of this post is one example call per modality so you can paste and run.

## What you need

The app bundles the inference engines, so you only need the hardware to run the models.

| Tier | Mac | Windows | RAM/VRAM | Disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1 | NVIDIA GPU or modern CPU | 16 GB | 20 GB free |
| Recommended | M3 / M4 | RTX with 8 GB+ VRAM | 32 GB | 40 GB+ free |

Models are quantized GGUF, so they fit in consumer memory. On Mac you get Metal acceleration over unified memory. On Windows you get CUDA or Vulkan, with a CPU fallback.

## Why one endpoint matters

You already know the OpenAI client. You set a base URL and a key, you call `chat.completions.create`, and you parse the response. Off Grid AI Desktop keeps that contract and changes only where the request goes. Your code stops sending bytes to a data center. Nothing leaves the machine.

That means you can take a script you wrote against the cloud and repoint it in one line:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:7878/v1",
    api_key="local",  # any placeholder works; no key is checked
)
```

The `api_key` is ignored. It exists so the SDK stops complaining. Now the same `client` object handles every modality below.

## Chat

Standard chat completions. The local model runs the request and streams or returns the text.

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Summarize the CAP theorem in two sentences."}
    ]
  }'
```

You get back the usual `choices[0].message.content`. No streaming flag needed for a single response. Set `"stream": true` when you want tokens as they arrive.

## Vision

The same chat endpoint takes images. Pass an `image_url` as a data URL, an `http` URL, or a local `file` path. The active vision model reads the pixels and answers.

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this screenshot?"},
        {"type": "image_url", "image_url": {"url": "file:///Users/you/Desktop/shot.png"}}
      ]
    }]
  }'
```

A `file://` path stays on disk and never uploads anywhere. The model loads, reads the image, and offloads when done.

## Embeddings

Vector embeddings for search and RAG, served by `all-MiniLM-L6-v2`.

```bash
curl http://127.0.0.1:7878/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "local-first inference"}'
```

You get a `data[0].embedding` array of floats. Feed it to whatever vector store you run. Index your private documents without sending a single line of them off your machine.

## Speech to text

Transcription runs whisper and handles multiple languages. Send the audio file as multipart form data.

```bash
curl http://127.0.0.1:7878/v1/audio/transcriptions \
  -F file=@meeting.m4a
```

The response carries the transcribed `text`. A recorded call, a voice memo, an interview: it gets turned into text on the device that holds the recording.

## Text to speech

The reverse direction uses Kokoro and returns a WAV file. List the available voices first, then synthesize.

```bash
curl http://127.0.0.1:7878/v1/audio/voices

curl http://127.0.0.1:7878/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Your draft is ready for review.",
    "voice": "af_heart"
  }' --output speech.wav
```

You now have a WAV file on disk, generated locally. Pipe it into a notification, a reading-mode feature, or an accessibility flow.

## Text to image and image to image

Image generation uses the local diffusion engine. Text to image is one POST.

```bash
curl http://127.0.0.1:7878/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a terminal-green wireframe of a city at night"}'
```

For image to image, send the source as multipart to the edits endpoint, or reference it inline.

```bash
curl http://127.0.0.1:7878/v1/images/edits \
  -F image=@source.png \
  -F prompt="repaint in cinematic lighting"
```

The pixels render on your GPU. Nothing about the prompt or the output touches a remote service.

## How the models share your memory

The app does not hold every model in RAM at once. Each modality loads on demand and offloads after the request. The chat model and the diffusion model never co-reside, so a 16 GB machine can serve all six modalities, one at a time, without thrashing.

That trades a small load cost on a cold call for a memory footprint that fits real hardware. If you call the same modality repeatedly, it stays warm.

For long jobs like image generation, opt into async with `?async=true` or the header `Prefer: respond-async`. You get back `202 Accepted` and a `poll_url`. Poll `GET /v1/requests/{id}` until it finishes.

```bash
curl "http://127.0.0.1:7878/v1/images/generations?async=true" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a quiet harbor at dawn"}'
# -> 202, { "poll_url": "/v1/requests/abc123" }
```

## Privacy: stronger than a hosted API

A hosted multimodal API sees every prompt, every image, every audio file you send. It logs requests. It needs an account and a key tied to your identity. Off Grid AI Desktop binds to `127.0.0.1`, so the server answers only your own machine. There is no telemetry. There is no account. The code is AGPL-3.0, so you can read exactly what it does. Your screenshots, recordings, and documents stay where they are.

## Getting started

1. Download or clone from [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop).
2. Install and launch the app.
3. Pick and download a model for each modality you want from the built-in browser.
4. The gateway is live at `http://127.0.0.1:7878/v1`. Open `/docs` for interactive docs or `/openapi.json` for the full spec.
5. Point your OpenAI SDK at the base URL and call any modality above.

Run `GET /v1/models` any time to see which model is active per modality, tagged by kind: chat, vision, image, speech, transcription.

## What's coming

- Use the gateway from other paired devices over your local mesh, so a phone or tablet can call your desktop as the household's private inference backend. Local only, no cloud.
- More bundled models across modalities.
- Wider OpenAI surface coverage as the spec grows.

## FAQ

### Q: Is it really free?

Yes. The app is free and open-source under AGPL-3.0. There is no paid tier gating the gateway.

### Q: Does it work offline?

Yes. Once the models are downloaded, every call runs on-device with no network.

### Q: Do I need an API key?

No. The endpoint checks nothing. SDKs require a key field, so pass any placeholder string.

### Q: Will my existing OpenAI code work?

If it uses the official `openai-python` or `openai-node` SDK, set `base_url` to `http://127.0.0.1:7878/v1` and it works for chat, vision, embeddings, audio, and images.

### Q: Can other apps on my network reach it?

No. The server binds to loopback only. It answers your machine and nothing else. Cross-device access over the local mesh is a separate, future feature.

### Q: How much RAM do I need?

16 GB runs the modalities one at a time. 32 GB keeps more headroom and faster warm calls.

Stop renting access to models your own machine can run.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**
