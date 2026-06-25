---
title: How to Run Stable Diffusion on Your Desktop (On-Device AI Image Generation)
published: true
description: Generate images with Stable Diffusion on your own Mac or PC, fully on-device, with a free open-source app. No cloud, no account, no credits.
tags: ai, stablediffusion, privacy, macos
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/how-to-run-stable-diffusion-desktop.jpg
---

The GPU in a gaming PC or an Apple Silicon Mac can paint a 1024-pixel image from a text prompt in seconds. That silicon sits idle while you pay per image to a cloud service that watermarks the output and keeps your prompts. Off Grid AI Desktop is a free, open-source app that runs Stable Diffusion directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, AGPL-3.0, runs offline.

## Why Run Stable Diffusion Locally

Cloud image tools meter you. Credits, queues, watermarks, and a record of every prompt you ever typed.

Local generation removes all of that. The model lives on your disk. You generate as many images as you want, at any hour, with no per-image cost. Your prompts stay on your machine, which matters when you are designing something you have not shipped yet.

Off Grid AI Desktop runs the Stable Diffusion family through a bundled stable-diffusion.cpp engine. No Python setup, no dependency hell, no command line required.

## What You Need

Image models are heavier than chat models. The bigger the model, the more memory it wants.

| Tier | Mac | Windows / PC | Runs |
|---|---|---|---|
| Minimum | M1, 8 GB unified memory | 8 GB RAM, 4 GB VRAM GPU | SD 1.5 / 2.1, smaller sizes |
| Recommended | M2 or M3, 16 GB+ | 16 GB RAM, NVIDIA GPU with 8 GB VRAM | SDXL, SDXL-Lightning |
| Comfortable | M3 Max or M4, 32 GB+ | 32 GB RAM, 12 GB+ VRAM | SDXL at higher resolution, fast iteration |

You need macOS 13 or later, or Windows 10/11. Keep 4 to 8 GB of free disk per model.

## What Off Grid AI Desktop Can Do

The image studio is built for iteration, not a single render.

- **Text to image.** Type a prompt and generate. Watch a per-step preview build the picture so you can cancel early if it is going wrong.
- **Image to image.** Feed in a starting image and a prompt to transform it.
- **Style presets.** One click for Sketch, Cinematic, Anime, and more, so you skip the prompt engineering.
- **Progress, ETA, and cancel.** Every render shows how far along it is and how long is left. Stop it any time.
- **Artifacts gallery and lightbox.** Every image you make is saved to a gallery you can browse and open full size.

## Which Model to Use

The right model depends on whether you want speed or top quality.

| Model | Best for | Notes |
|---|---|---|
| SD 1.5 / 2.1 | Low-memory machines | Smallest, fastest to load, lower detail |
| SDXL | Best quality | Sharp, high-detail 1024px images, needs more memory |
| SDXL-Lightning | Speed | Few-step generation, near-instant on a good GPU |
| Z-Image-Turbo | Fast 2026 flagship | Roughly 8-step generation, strong quality for the speed |

On a tight machine, start with SD 1.5. On a strong GPU, SDXL gives the best detail and SDXL-Lightning gives the fastest turnaround. Z-Image-Turbo is the new option when you want quality without a long wait.

## How Hardware Acceleration Works

Off Grid AI Desktop runs the diffusion model on your GPU through the bundled stable-diffusion.cpp engine.

On a Mac, generation runs on Metal. Apple Silicon shares one memory pool between CPU and GPU, so a 16 GB Mac can hold an SDXL model the GPU works on directly. No copying across a bus.

On Windows, the engine uses CUDA on NVIDIA cards or Vulkan on other GPUs. With no supported GPU, it falls back to the CPU. That works, but a single image can take minutes instead of seconds.

Quantization helps the model fit. The full weights are large. Quantized files store them in fewer bits, which shrinks both the download and the memory footprint, so a consumer GPU can hold the whole model.

## Getting Faster, Sharper Results

A few habits raise quality and speed.

For speed, use SDXL-Lightning or Z-Image-Turbo. They reach a finished image in far fewer steps than standard SDXL.

For quality, use full SDXL at its native 1024px and let it run more steps. Watch the per-step preview and cancel any render that is clearly off before it finishes, to save time.

Start with a style preset, then refine the prompt. The presets do the heavy lifting on look and lighting, so your words can focus on the subject.

## Privacy: Stronger Than Cloud Image Tools

Cloud image generators keep your prompts, often watermark your output, and may use what you make to train future models. Some restrict what you can create.

Off Grid AI Desktop runs the model on your machine. No account, no credits, no telemetry. The images and the prompts never leave your disk. The code is AGPL-3.0, so you can read it and confirm nothing is uploaded. Generate offline with the network cable pulled.

## Getting Started

1. Open the repo at [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop).
2. Download the build for your OS, or clone and build from source.
3. Install and launch the app.
4. Download an image model that fits your hardware. Start with SDXL on a strong GPU, or SD 1.5 on a lighter machine.
5. Open the image studio, type a prompt, pick a style, and generate.

```bash
git clone https://github.com/off-grid-ai/desktop
cd desktop
npm install
npm run dev
```

## What's Coming

- More image models as new open-weight releases land.
- Cross-device sync, so your artifacts gallery follows you between machines, encrypted.
- Unified search across your generated images and the rest of your work.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. No credits, no per-image charge.

### Q: Does it work offline?
Yes. Once a model is downloaded, you can generate with no internet connection.

### Q: Which models can I run?
The Stable Diffusion family: SDXL, SDXL-Lightning, SD 1.5 and 2.1, plus Z-Image-Turbo. Pick the one your hardware can hold.

### Q: How much VRAM or RAM do I need?
4 GB of VRAM or 8 GB of RAM runs SD 1.5. 8 GB of VRAM or 16 GB of RAM is comfortable for SDXL. More memory means higher resolution and faster iteration.

### Q: Mac or Windows?
Both. Mac uses Metal on Apple Silicon. Windows uses CUDA or Vulkan, with a CPU fallback.

### Q: Are my prompts and images private?
Yes. Everything stays on your machine. No account, no telemetry, open code.

Generate images on your own hardware, with no cloud and no credits.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
