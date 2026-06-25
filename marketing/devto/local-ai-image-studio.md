---
title: How to Run a Local AI Image Studio on Your Desktop (SDXL, Z-Image, Offline)
published: false
description: Generate images with SDXL and Z-Image-Turbo entirely on-device. No subscription, no cloud, no prompts leaving your machine.
tags: ai, stablediffusion, macos, privacy
cover_image:
---

The GPU in a modern laptop can run the same image models that power paid services like Midjourney. That hardware sits idle while you pay a monthly fee to generate pictures on someone else's server. Off Grid AI Desktop is a free, open-source app that runs Stable Diffusion XL and Z-Image-Turbo directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API key, no telemetry.

## What You Get Instead of a Subscription

You buy holes, not drill bits. Here is what a local image studio gets you over a cloud tool.

Your prompts never leave the machine. There is no per-image credit, no monthly cap, and no queue. You run as many generations as your hardware allows, at 2am, on a plane, with the WiFi off. The model weights live on your disk, so the service cannot be deprecated or rate-limited out from under you.

## What You Need

The bigger the model, the more memory it wants. Two tiers cover most people.

| Tier | macOS | Windows | RAM / VRAM | Free disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1 | NVIDIA GTX 1660 or any modern iGPU | 8 GB | 15 GB |
| Recommended | M2 / M3 / M4 | RTX 3060 or better (8 GB+ VRAM) | 16 GB+ | 30 GB |

On the minimum tier you run SD 1.5 and the few-step models comfortably. SDXL at full resolution wants the recommended tier. CPU-only generation works on Windows as a fallback, but it is slow, so expect minutes per image rather than seconds.

## What Off Grid AI Desktop Can Do

The image studio is built on `stable-diffusion.cpp`, the same C++ engine that runs Stable Diffusion without Python or a server account.

You get text-to-image and image-to-image. Type a prompt and generate from scratch, or drop in a reference image and steer it with strength and a new prompt. A live per-step preview shows the picture forming as the model denoises, so you see early whether a generation is going anywhere before it finishes. Progress and an ETA sit next to it, and a cancel button stops a run you do not want.

Finished images open in a lightbox for full-size viewing. Everything you make lands in an artifacts gallery, so your history is browsable on disk instead of locked in a web account. Style presets like Sketch, Cinematic, and Anime prepend tuned prompt fragments, so you get a consistent look without memorizing keyword soup.

## Which Models to Use

Different models trade speed for fidelity. Pick one to match your hardware and your patience.

| Model | What it is | Best for |
|---|---|---|
| SD 1.5 / 2.1 | The original compact models | Low-memory machines, fast iteration |
| SDXL | Higher resolution, stronger composition | Final quality on the recommended tier |
| SDXL-Lightning | SDXL distilled to a few steps | Near-SDXL quality, much faster |
| Z-Image-Turbo | 2026 flagship, around 8 steps | Modern quality with a short step count |

A good workflow is to draft with a few-step model, then re-run the prompt you like on full SDXL for the keeper. SDXL-Lightning and Z-Image-Turbo cut the step count dramatically, which is what makes local generation feel responsive instead of a chore.

## How Hardware Acceleration Works

The models are large, so they get quantized. Quantization stores the weights at lower precision, which shrinks the file and the memory footprint enough to fit on consumer hardware. That is the change that made on-device image generation viable.

On macOS, generation runs through Metal against Apple Silicon's unified memory, so the GPU reads the same RAM as the CPU with no separate VRAM ceiling to fight. On Windows, you get CUDA on NVIDIA cards or Vulkan on others, with a CPU path when there is no usable GPU. The app picks the accelerated path it finds.

## Keeping It Fast

Step count is the biggest lever on speed. A 30-step SDXL run takes far longer than an 8-step Turbo run, and for drafting you rarely need the extra steps. Start low and raise it only for the final image.

Resolution is the second lever. Doubling the side of an image roughly quadruples the work. Generate at a smaller size while you tune the prompt, then bump the resolution once the composition is right. If a generation is clearly wrong by step three, the cancel button saves you the rest.

## Privacy: Stronger Than a Cloud Image Tool

A cloud image service sees every prompt you type and every reference image you upload. Some reserve the right to train on what you make. Off Grid AI Desktop sees none of it, because there is no server. The model runs locally, the output saves to your disk, and nothing is logged off-machine.

It is AGPL-3.0 licensed, so the code is auditable. There is no account, so there is no profile to leak. Run it on an air-gapped machine and every feature still works.

## Getting Started

1. Download or clone from [the GitHub repo](https://github.com/off-grid-ai/desktop).
2. Install and launch the app on your Mac or PC.
3. Open the Models browser and download an image model (start with SDXL-Lightning or Z-Image-Turbo).
4. Open the image studio, type a prompt, pick a style preset if you want one.
5. Generate. Watch the per-step preview, then open the result in the lightbox.

```bash
git clone https://github.com/off-grid-ai/desktop
cd desktop
npm install
npm run dev
```

## What's Coming

- More image models as new open-weight releases ship.
- Cross-device sync so your artifacts gallery follows you between machines.
- Unified search across generated images and the rest of your captured work.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. There are no image credits and no subscription.

### Q: Does it work offline?
Yes. Once a model is downloaded, generation runs with no network connection.

### Q: Which models can I run?
SD 1.5, SD 2.1, SDXL, SDXL-Lightning, and Z-Image-Turbo. You download them through the built-in Models browser.

### Q: How much RAM do I need?
8 GB runs the compact and few-step models. 16 GB or more is comfortable for full SDXL.

### Q: Does it run on Windows and Mac?
Both. macOS uses Metal on Apple Silicon. Windows uses CUDA, Vulkan, or a CPU fallback.

### Q: Are my prompts private?
Yes. Prompts and images stay on your machine. There is no server to send them to.

Run a private image studio on hardware you already own. **[GitHub →](https://github.com/off-grid-ai/desktop)**
