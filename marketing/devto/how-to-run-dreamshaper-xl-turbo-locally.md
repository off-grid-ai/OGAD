---
title: How to Run DreamShaper XL Turbo Locally on Your Desktop (Fast Offline AI Art)
published: true
description: Generate artwork in a handful of steps with DreamShaper XL Turbo, fully on-device, no cloud, no account, no API keys.
tags: ai, stablediffusion, privacy, art
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/how-to-run-dreamshaper-xl-turbo-locally.jpg
---

A Turbo-distilled SDXL model can produce a finished image in a handful of steps instead of dozens. That speed runs fine on the GPU already in your machine, the one sitting idle while you pay monthly to generate art on a rented server. Off Grid AI Desktop is a free, open-source app that runs DreamShaper XL Turbo directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)** Free, open-source, runs offline.

DreamShaper XL v2 Turbo is a versatile artistic checkpoint. It handles illustration, concept art, painterly looks, and stylized portraits without much coaxing. The Turbo part means it was distilled to need far fewer sampling steps, so each image comes back fast. This guide shows you how to run it locally with no token meter and no upload of your prompts.

## What You Need

The model ships as a quantized GGUF build, so it fits in normal memory. Pick your tier.

| Tier | Hardware | RAM / VRAM | Disk |
|---|---|---|---|
| Minimum | Apple Silicon M1, or a GPU with 6 GB VRAM | 16 GB | 8 GB free |
| Recommended | M2/M3/M4, or NVIDIA RTX with 8 GB+ VRAM | 32 GB | 12 GB free |

Turbo models are forgiving on the low end because the step count is small. A recent macOS with Metal, or current GPU drivers on Windows, is what you want.

## What Off Grid AI Desktop Can Do

The image studio runs on `stable-diffusion.cpp`. The Turbo speed shows up clearly in the workflow.

- Type a prompt and get a result in a few steps. The low step count is the whole point of a Turbo model.
- Watch the image form with a live per-step preview, with progress and an ETA. Cancel mid-run if it is going the wrong way.
- Keep every result in an artifacts gallery and open any of them in a lightbox to compare.
- Run txt2img from a prompt, or img2img from a reference when you want to restyle an existing picture.
- Pick a style preset (Cinematic, Sketch, Anime, and others) as a fast starting point.

Because the round trip is short, you iterate quickly. Type, look, adjust, repeat. None of it leaves your disk.

## Why Few Steps Matters

A standard SDXL model often wants 25 to 40 sampling steps for a clean result. Each step is GPU work. DreamShaper XL Turbo was distilled to give a usable image in a small fraction of that. Fewer steps means faster generations, which means you can explore more ideas in the same time.

The practical effect is that local generation stops feeling like a wait. You stay in flow. With a Turbo model you can keep your guidance scale (CFG) lower than you would with a standard checkpoint, since Turbo models tend to oversaturate at high guidance. Start low and nudge up only if the image looks washed out.

## How Hardware Acceleration Works

On a Mac, the model runs on Metal and uses unified memory, so the GPU and CPU share one memory pool with no copy between them. On Windows, it runs on CUDA for NVIDIA cards or Vulkan as a wider fallback, with CPU available when there is no GPU.

Quantization is what brings the model down to size. The GGUF build trims the weights so an SDXL checkpoint fits in the memory a consumer machine has. You give up a little precision and gain the ability to run the whole pipeline on your own GPU. Combined with Turbo's low step count, that is what makes fast offline art realistic on a laptop.

## Keeping It Fast

- Keep the step count where Turbo expects it. Adding steps to a Turbo model usually does not improve the image and only costs time.
- Hold your guidance scale low. Turbo checkpoints prefer it, and high CFG can blow out color and contrast.
- Generate near SDXL's native resolution (about 1024 px on the long edge), then upscale separately if you need a larger file.
- Lock a seed when you find a composition you like, then change one part of the prompt to refine without losing the layout.

## Privacy: Stronger Than a Cloud Art Generator

A hosted art tool sees every prompt and stores every image. It logs your activity and frequently trains on what you upload. You accept terms you skimmed.

Off Grid AI Desktop runs the model on your machine. No account, no telemetry, nothing transmitted. Your prompts and images stay on the device. The app is AGPL-3.0, so you can read the source and confirm what it does. This is a property of how it is built, not a checkbox.

## Getting Started

1. Download or clone Off Grid AI Desktop from the repo: https://github.com/off-grid-ai/desktop
2. Install and launch it on your Mac or PC.
3. Open the Models browser and find the DreamShaper XL v2 Turbo GGUF build: https://huggingface.co/offgrid-ai/dreamshaper-xl-v2-turbo-GGUF
4. Download it with the built-in download manager and set it as your image model.
5. Open the image studio, write a prompt, keep the steps low, and generate.

## What's Coming

- More curated GGUF image checkpoints in the Models browser.
- Cross-device sync so your gallery moves with you.
- Ongoing improvements to the live preview and generation controls.

## FAQ

### Q: Is it really free?

Yes. The app is free and open-source under AGPL-3.0, and the model is a free download. No subscription and no per-image credits.

### Q: Does it work fully offline?

Yes. Download the app and the model once, then generate with no network at all.

### Q: Why is DreamShaper XL Turbo faster?

It was distilled to produce a usable image in far fewer sampling steps than a standard SDXL model. Fewer steps, less GPU work, quicker results.

### Q: How much RAM do I need?

16 GB is the minimum on Apple Silicon. 32 GB gives you more headroom alongside other apps.

### Q: Does it run on Windows or only Mac?

Both. Macs use Metal. Windows uses CUDA or Vulkan, with a CPU fallback.

### Q: Is my data private?

Yes. Everything runs locally. No account, no telemetry, no prompts sent to a server.

Run DreamShaper XL Turbo on your own hardware, offline, today.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
