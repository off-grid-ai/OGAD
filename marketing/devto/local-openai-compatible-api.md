---
title: How to Run a Local OpenAI-Compatible API on Your Desktop in 2026 (No Cloud, No Keys)
published: false
description: Swap one base_url and your existing OpenAI code runs against on-device models for free, offline, with no API key.
tags: ai, privacy, openai, opensource
cover_image:
---

The laptop on your desk has a GPU that can run a 7B model and a diffusion model without breaking a sweat. Most of the time that silicon sits idle while you pay a monthly bill to send your prompts to someone else's server. Off Grid AI Desktop is a free, open-source app that runs a full OpenAI-compatible API directly on your Mac or PC.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**

Free, open-source (AGPL-3.0), runs offline. No account, no telemetry, no API key.

## The one-line change

Here is the whole pitch. You already have code that talks to OpenAI. You point its `base_url` at a server running on your own machine, and the code keeps working. The requests never leave your laptop.

The server lives at:

```
http://127.0.0.1:7878/v1
```

It is bound to loopback. That means local-only, never reachable from the internet, never exposed to your network. No port forwarding, no firewall hole, no cloud relay. Your prompts and files stay on the machine that typed them.

There is no API key because there is no account. Any OpenAI client wants a key in the constructor, so you pass a placeholder string and the gateway ignores it.

## What You Need

The gateway runs on hardware most developers already own.

| Tier | macOS | Windows |
|---|---|---|
| Minimum | Apple Silicon (M1), 16 GB unified memory, macOS 13+, ~12 GB free disk | NVIDIA or recent CPU, 16 GB RAM, Windows 11, ~12 GB free disk |
| Recommended | M2/M3/M4, 24 GB+ unified memory | NVIDIA GPU (CUDA) or Vulkan GPU, 32 GB RAM |

CPU-only works on Windows as a fallback. It is slower, but it runs.

## One endpoint, every modality

Most local-AI setups give you a text endpoint and stop there. This gateway covers text, vision, embeddings, speech, and images behind the same OpenAI-shaped routes. You learn one client, you get every model on your machine.

- `POST /v1/chat/completions` and `/v1/completions` for text, plus vision. Send an `image_url` as a data URL, an http(s) URL, or a local file path. The gateway inlines remote images for you.
- `POST /v1/embeddings` for local `all-MiniLM-L6-v2` vectors.
- `POST /v1/audio/transcriptions` for speech-to-text via whisper.cpp, multilingual, sent as a multipart `file`.
- `POST /v1/audio/speech` for Kokoro text-to-speech as WAV. `GET /v1/audio/voices` lists the voice ids.
- `POST /v1/images/generations` for text-to-image, `POST /v1/images/edits` for image-to-image, and `POST /v1/images` as a unified route that takes `input_references` for img2img.
- `GET /v1/models` lists the active model per modality. Each one is tagged with a `kind`: chat, vision, image, speech, or transcription.

Models load on demand per modality and offload when the call is done, so a chat model and a diffusion model never sit in RAM at the same time. Your memory budget covers one job, not all of them at once.

## Chat in five lines

Here is a plain chat request with curl. Note the placeholder key.

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "Write a haiku about loopback addresses."}]
  }'
```

The same thing with the official Python SDK. You change two arguments and nothing else.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:7878/v1",
    api_key="not-needed",  # any placeholder works
)

resp = client.chat.completions.create(
    model="local",
    messages=[{"role": "user", "content": "Explain loopback in one sentence."}],
)
print(resp.choices[0].message.content)
```

And in Node, with the official `openai` package:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:7878/v1",
  apiKey: "not-needed",
});

const resp = await client.chat.completions.create({
  model: "local",
  messages: [{ role: "user", content: "Explain loopback in one sentence." }],
});
console.log(resp.choices[0].message.content);
```

If you already wrote against OpenAI, that is the entire migration. The response shape matches, so your parsing code does not change.

## Vision, in the same request

Send an image alongside text. The gateway accepts a data URL, a remote URL, or a path to a file on disk.

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "What is in this screenshot?"},
        {"type": "image_url", "image_url": {"url": "/Users/you/Desktop/shot.png"}}
      ]
    }]
  }'
```

A local path works because the request never leaves your machine. There is no upload step and no signed URL to manage.

## Long jobs without timeouts

Some calls run long. The first time you use a modality, the model downloads. A multi-step diffusion render takes seconds to minutes depending on your GPU. Rather than hold an HTTP connection open and risk a client timeout, you can run the call async.

Opt in three ways: add `?async=true` to the URL, set `"async": true` in the body, or send the header `Prefer: respond-async`. You get back `202` with a `poll_url`. Then you poll:

```bash
# kick off an image generation, async
curl "http://127.0.0.1:7878/v1/images/generations?async=true" \
  -H "Content-Type: application/json" \
  -d '{"model": "local", "prompt": "a lighthouse at dusk, oil painting"}'
# -> 202 with {"id": "...", "poll_url": "/v1/requests/abc123"}

# poll until it is done
curl http://127.0.0.1:7878/v1/requests/abc123
```

This keeps your client code simple for fast calls and reliable for slow ones.

## How on-device inference is viable now

Two things changed. Apple Silicon ships unified memory, so the GPU reads the same RAM as the CPU with no copy across a bus. A 16 GB M-series chip can hold a quantized 7B model and run it on Metal. On Windows, NVIDIA cards run the same models on CUDA, and Vulkan covers other GPUs.

The second change is quantization. The bundled models are GGUF files at quant levels like q8_0 and Q4_K. A model that wanted 28 GB at full precision fits in 5 to 8 GB quantized, with quality that holds up for most work. That is why a consumer laptop runs models that needed a server two years ago.

## A tip on memory

Because the gateway loads one model per modality on demand and offloads after, your peak memory is set by your largest single job, not the sum of everything. Plan your free RAM around the heaviest step, usually image generation, and the rest fits underneath it.

## Privacy: stronger than a hosted API

A hosted OpenAI-compatible endpoint sees every prompt, every file, and every image you send. It logs them, it bills you per token, and it requires an account tied to your identity.

This gateway sees none of that, because there is nothing to send. The server is on `127.0.0.1`. It has no outbound calls for inference. There is no telemetry. The code is AGPL-3.0, so you can read exactly what it does. You can pull the network cable and every endpoint above still answers.

## Getting Started

1. Clone or download from [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop).
2. Install and launch the app on macOS or Windows.
3. The gateway comes up on `http://127.0.0.1:7878/v1`. Open `GET /docs` for the Scalar playground, or grab the spec at `/openapi.json`.
4. Point your existing OpenAI client at that `base_url` with any placeholder `api_key`.
5. Send a chat request. The first call to each modality downloads its model once, then runs offline.

## What's Coming

- Using this same gateway from your other paired devices over the local mesh, so a phone or a second laptop can call the model running on your desktop. This part is roadmap, not shipped yet.
- More bundled models per modality.
- The on-device models are also exposed as MCP tools at `POST /v1/.../mcp` over Streamable HTTP, so an MCP client can call them. A separate article covers that path in depth.

## FAQ

### Q: Is it really free?

Yes. The app is open source under AGPL-3.0 and there is no metered API behind it. You run the models on your own hardware, so there is no per-token cost.

### Q: Does it work offline?

Yes. After the one-time model download for each modality, every endpoint runs with no internet. Loopback only.

### Q: Do I need an API key?

No. There is no account and no auth. OpenAI clients require a key argument, so pass any placeholder string and it is ignored.

### Q: Will my existing OpenAI code work?

Yes, for the OpenAI-compatible routes. Change `base_url` to `http://127.0.0.1:7878/v1` and keep the rest. The gateway also mirrors an Ollama-style models array if your tooling expects that shape.

### Q: How much RAM do I need?

16 GB is a workable minimum on both macOS and Windows. 24 GB or more gives you room for larger models and faster image work. Models load one at a time, so you size for the biggest single job.

### Q: Is my data private?

The server is bound to `127.0.0.1` and makes no outbound inference calls. No telemetry, no logging to a third party, no account. The source is open, so you can verify it.

Point your code at your own machine.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**
