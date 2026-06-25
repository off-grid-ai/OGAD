---
title: How to Run Gemma Locally on Your Computer in 2026 (Mac and Windows, No Cloud)
published: true
description: Run Google's Gemma models on your own Mac or PC, fully on-device, with a free open-source app. No cloud, no account, no API keys.
tags: ai, llm, gemma, privacy
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/how-to-run-gemma-locally.jpg
---

A modern laptop ships with a GPU that can run a 4-billion-parameter language model in real time. That hardware sits idle while you pay a monthly subscription to send your prompts to someone else's server. Off Grid AI Desktop is a free, open-source app that runs Google's Gemma models directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, AGPL-3.0, runs offline.

## Why Gemma, and Why Local

Gemma is Google's open-weight model family. The weights are public, so you can download them and run them yourself. No API call ever leaves your machine.

Off Grid AI Desktop bundles a Gemma vision model out of the box. It also gives you a built-in Hugging Face browser, so you can pull down other Gemma sizes and run them in the same chat window. You type, the model answers, and nothing touches a network.

That matters when you paste a contract, a medical note, or unreleased code into a chat. Cloud chat tools log your input. A local model cannot, because there is no server to log it.

## What You Need

Gemma comes in several sizes. The size you pick depends on your hardware.

| Tier | Mac | Windows / PC | Runs |
|---|---|---|---|
| Minimum | M1, 8 GB unified memory | 8 GB RAM, integrated GPU or CPU | Gemma 2B / 3B class, quantized |
| Recommended | M2 or M3, 16 GB+ | 16 GB RAM, NVIDIA GPU with 8 GB VRAM | Gemma 4B vision, 7B class |
| Comfortable | M3 Max or M4, 32 GB+ | 32 GB RAM, 12 GB+ VRAM | Larger Gemma, longer context |

You also need macOS 13 or later, or Windows 10/11. Budget 5 to 15 GB of free disk per model. Quantized GGUF files are smaller than the raw weights, which is why they fit.

## What Off Grid AI Desktop Can Do

The chat is the front door, but the app does more than chat.

- **Chat with Gemma offline.** Adjust temperature and context window per conversation. Closer to a private ChatGPT than a toy.
- **Browse and download models.** The built-in Hugging Face browser lets you grab any compatible GGUF and run it. Swap Gemma sizes without leaving the app.
- **Use the vision model on images.** The bundled Gemma vision model reads screenshots and photos you drop into chat.
- **Chat with your documents.** Upload a PDF or a folder of notes and ask questions against them, with cited sources, all on-device.
- **Speak and listen.** Voice in through whisper.cpp, voice out through an open-weight speech model. Talk to Gemma without typing.

## Which Gemma to Use

Pick the model that fits your memory, not the biggest one you can find.

| Your hardware | Recommended Gemma | What to expect |
|---|---|---|
| 8 GB Mac or PC | Gemma 2B / 3B, Q4 quant | Fast replies, good for summaries and quick questions |
| 16 GB, decent GPU | Gemma 4B vision or 7B class | Stronger reasoning, reads images, handles longer prompts |
| 32 GB+ with strong GPU | Larger Gemma, higher quant | Best quality, longer documents, slower first token |

A smaller model on fast hardware beats a large model that swaps to disk. If replies stall, drop a size.

## How Hardware Acceleration Works

Off Grid AI Desktop runs Gemma through a bundled llama.cpp server on your machine. It uses your GPU when it can.

On a Mac, that means Metal. Apple Silicon shares one pool of memory between the CPU and GPU, so a 16 GB Mac can load a model the GPU reaches directly. No copying across a bus.

On Windows, the app uses CUDA on NVIDIA cards or Vulkan on other GPUs. No supported GPU is fine too. The model runs on the CPU, slower but functional.

The other half is quantization. Full Gemma weights are 16-bit floats. Quantized GGUF files store them in 4 or 8 bits, which cuts memory by half or more. The quality drop is small. The fit in consumer RAM is the difference between running and not running.

## Keeping It Fast

A few habits keep Gemma responsive.

Match the model to your memory. If the app reports it is offloading layers to the CPU, you picked too large a model. Step down.

Keep the context window reasonable. A huge context eats memory and slows every token. Set it to what the task needs.

Start a fresh chat for a new topic. A long history is re-read on every turn. Clearing it speeds things up.

## Privacy: Stronger Than Cloud Gemma

You can use Gemma through Google's cloud. Your prompts travel to Google, get logged, and may train future models.

Off Grid AI Desktop is the opposite. The model runs on your disk. There is no account and no telemetry. The code is AGPL-3.0, so anyone can read it and confirm nothing phones home. Pull the network cable and Gemma still answers.

## Getting Started

1. Open the repo at [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop).
2. Download the build for your OS, or clone and build from source.
3. Install and launch the app.
4. Open the Models browser, then download a Gemma GGUF that fits your hardware. The bundled vision model is ready immediately.
5. Open chat, select your model, and start typing.

```bash
git clone https://github.com/off-grid-ai/desktop
cd desktop
npm install
npm run dev
```

## What's Coming

- Cross-device sync, so your chats and memory follow you between machines, encrypted.
- More bundled models as new open-weight releases land.
- Unified search across your chats, documents, and captured work.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. There is no paid unlock for running Gemma.

### Q: Does it work fully offline?
Yes. Once a model is downloaded, you can disconnect from the internet and keep chatting.

### Q: Which Gemma models can I run?
The app bundles a Gemma vision model and lets you download other compatible Gemma GGUF files from Hugging Face. Pick the size that fits your RAM.

### Q: How much RAM do I need?
8 GB runs a small Gemma. 16 GB is comfortable for the 4B vision model and 7B class. 32 GB lets you run larger sizes with room to spare.

### Q: Mac or Windows?
Both. Mac uses Metal on Apple Silicon. Windows uses CUDA or Vulkan, with a CPU fallback.

### Q: Is my data private?
Yes. Prompts and replies never leave your machine. No account, no telemetry, open code.

Run Gemma on your own hardware, with no cloud in the loop.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
