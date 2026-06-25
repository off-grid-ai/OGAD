---
title: How to Point Your IDE and Apps at a Local AI Model (Private, On-Device)
published: false
description: Point any OpenAI-compatible IDE extension, app, or script at a local endpoint for private, offline inference across your whole machine.
tags: ai, privacy, productivity, opensource
cover_image:
---

Your editor, your terminal scripts, and half the AI tools you installed last month all speak the same protocol: the OpenAI HTTP API. They all assume that protocol points at a server you pay for. It does not have to. Off Grid AI Desktop is a free, open-source app that puts an OpenAI-compatible endpoint on your own Mac or PC, so every one of those tools can run against on-device models instead.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**

Free, open-source (AGPL-3.0), runs offline. No account, no telemetry, no API key.

## The address every tool can use

There is one endpoint to remember:

```
http://127.0.0.1:7878/v1
```

Anything that takes an OpenAI base URL takes this one. IDE extensions, CLI tools, a Python script, a browser extension, a shell alias. You give them this address and a placeholder key, and they get a private inference backend that works on a plane.

It is bound to loopback, so it answers only from your own machine. Nothing on your network or the internet can reach it. That is the point. Your code, your prompts, and your files go to a process you control, not to a vendor.

## What You Need

| Tier | macOS | Windows |
|---|---|---|
| Minimum | Apple Silicon (M1), 16 GB unified memory, macOS 13+, ~12 GB free disk | NVIDIA or recent CPU, 16 GB RAM, Windows 11, ~12 GB free disk |
| Recommended | M2/M3/M4, 24 GB+ unified memory | NVIDIA GPU (CUDA) or Vulkan GPU, 32 GB RAM |

CPU fallback works on Windows when there is no GPU. It runs slower but it runs.

## What you can wire up

The gateway is OpenAI-SDK compatible, so the list of things you can point at it is long. A few that developers reach for first:

- IDE assistants and editor extensions that let you set a custom base URL. They send chat completions, the local model answers, your code never leaves the laptop.
- A `curl` one-liner or a shell function for quick prompts from the terminal.
- Scripts using `openai-python` or `openai-node`, where you change two arguments and the script now runs offline.
- Any app that already speaks the OpenAI protocol or mirrors an Ollama-style models array, since the gateway exposes both shapes.

One endpoint covers more than text. You get vision, embeddings, speech-to-text, text-to-speech, and image generation behind the same OpenAI routes, so the tools you point at it are not limited to chat.

## Point a script at it

Start with the smallest possible test. This confirms the endpoint answers.

```bash
curl http://127.0.0.1:7878/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "Reply with just: it works"}]
  }'
```

Now the same in Python with the official SDK. The two lines that matter are `base_url` and `api_key`.

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:7878/v1",
    api_key="local",  # any placeholder, the gateway ignores it
)

resp = client.chat.completions.create(
    model="local",
    messages=[{"role": "user", "content": "Summarize this commit message: fix off-by-one in pager"}],
)
print(resp.choices[0].message.content)
```

In Node, with the `openai` package:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:7878/v1",
  apiKey: "local",
});

const resp = await client.chat.completions.create({
  model: "local",
  messages: [{ role: "user", content: "Rename this variable to be clearer: tmp2" }],
});
console.log(resp.choices[0].message.content);
```

## Point your IDE at it

Most IDE assistants and editor AI extensions expose two settings: a base URL and an API key. Set them like this:

- Base URL or API base: `http://127.0.0.1:7878/v1`
- API key: any non-empty string, for example `local`
- Model: `local`, or whatever id `GET /v1/models` reports

If the extension also asks for a provider type, choose OpenAI-compatible or custom. From there the extension's chat, inline completion, and edit features run against the model on your disk. To check which models are active and their `kind` (chat, vision, image, speech, transcription), call:

```bash
curl http://127.0.0.1:7878/v1/models
```

## More than chat for your scripts

Because the same endpoint serves every modality, you can build small tools that would normally need three vendors.

Transcribe an audio file with whisper.cpp, sent as multipart:

```bash
curl http://127.0.0.1:7878/v1/audio/transcriptions \
  -F "file=@meeting.m4a" \
  -F "model=local"
```

Generate embeddings for a local search script, using `all-MiniLM-L6-v2`:

```bash
curl http://127.0.0.1:7878/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model": "local", "input": "the cat sat on the mat"}'
```

There is also text-to-speech at `/v1/audio/speech` (Kokoro, WAV output, with voice ids from `/v1/audio/voices`) and image generation at `/v1/images/generations`. Same base URL, same placeholder key.

## Handling slow calls in tooling

Some calls take a while. The first request to a modality downloads its model, and multi-step image generation runs for seconds to minutes. Rather than risk a client timeout in your script, opt into async with `?async=true`, a body field `"async": true`, or the header `Prefer: respond-async`. You get a `202` with a `poll_url`, then poll `GET /v1/requests/{id}` until it finishes. For an IDE assistant doing short chat turns you will not need this, but a batch script will.

## How it stays fast on a laptop

Models load on demand per modality and offload when the call ends, so a chat model and an image model never sit in RAM together. Your peak memory is set by the largest single job, not the sum of all of them.

The models themselves are quantized GGUF files at levels like q8_0 and Q4_K, which shrinks a model that wanted tens of gigabytes down to a handful. On macOS the GPU runs them on Metal over unified memory. On Windows it is CUDA for NVIDIA cards or Vulkan for others, with a CPU path as backup. That combination is why a consumer machine handles models that needed a rented server not long ago.

## Privacy: stronger than a hosted backend

When your IDE talks to a hosted AI service, your source code goes to that service. It is logged, billed per token, and tied to an account.

When your IDE talks to `127.0.0.1:7878`, the code goes to a process on your own machine and stops there. The gateway makes no outbound calls for inference. There is no telemetry and no account. The whole app is AGPL-3.0, so you can read what it does before you trust it with your repository. Disconnect from the network and every example above keeps working.

## Getting Started

1. Clone or download from [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop).
2. Install and launch the app on macOS or Windows.
3. Confirm the gateway answers at `http://127.0.0.1:7878/v1`. Browse `GET /docs` for the Scalar playground or `/openapi.json` for the spec.
4. In each tool, set the base URL to that address and the key to any placeholder.
5. Run a request. The first call per modality downloads its model once, then everything runs offline.

## What's Coming

- Reaching this gateway from your other paired devices over the local mesh, so a second laptop or a phone can use the model on your desktop. This is roadmap, not shipped yet.
- More bundled models across the modalities.
- The on-device models are also exposed as MCP tools at `POST /v1/.../mcp` over Streamable HTTP, so MCP clients can call them. A separate article goes into that.

## FAQ

### Q: Will this work with my IDE extension?

If the extension lets you set a custom OpenAI base URL and key, yes. Set the URL to `http://127.0.0.1:7878/v1` and the key to any placeholder.

### Q: Is it really free?

Yes. AGPL-3.0, open source, no metered API. You run models on your own hardware, so there is no token bill.

### Q: Does it work offline?

Yes. After each modality downloads its model once, every endpoint runs with no internet.

### Q: Which clients are supported?

Anything that speaks the OpenAI HTTP API, including `openai-python` and `openai-node`. The gateway also mirrors an Ollama-style models array for tools that expect that.

### Q: How much RAM do I need?

16 GB works on macOS and Windows. 24 GB or more helps with bigger models and image generation. Models load one at a time, so size for the heaviest single job.

### Q: Is my code private?

The endpoint is bound to `127.0.0.1` and makes no outbound inference calls. No telemetry, no account, open source. Your repository stays on your disk.

Give your whole machine a private inference backend.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**
