---
title: How to Run RealVisXL 5.0 Locally on Your Desktop (Photorealism, Offline)
published: true
description: Generate photorealistic images with RealVisXL 5.0 fully on-device, no cloud, no account, no API keys.
tags: ai, stablediffusion, privacy, macos
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/how-to-run-realvisxl-locally.jpg
---

The unified memory in an Apple Silicon Mac lets the GPU and CPU read the same pool, which is exactly what a photorealistic SDXL model wants. That hardware sits idle while you pay monthly to render images on someone else's GPU. Off Grid AI Desktop is a free, open-source app that runs RealVisXL 5.0 directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)** Free, open-source, runs offline.

RealVisXL v5.0 is a photorealistic SDXL checkpoint. This is the full-step variant, not a Lightning build, so it favors image quality over raw speed. It is built for realistic skin, lighting, and texture. This guide shows you how to run it locally with no token meter and no upload of your prompts to a server.

## What You Need

The model ships as a quantized GGUF build so it fits in consumer memory. Pick your tier.

| Tier | Hardware | RAM / VRAM | Disk |
|---|---|---|---|
| Minimum | Apple Silicon M1, or a GPU with 8 GB VRAM | 16 GB | 8 GB free |
| Recommended | M2/M3/M4 with 24 GB+, or NVIDIA RTX with 12 GB+ VRAM | 32 GB | 12 GB free |

Because this is a full-step model, more memory and a stronger GPU pay off. A recent macOS with Metal, or current GPU drivers on Windows, is what you want.

## What Off Grid AI Desktop Can Do

The image studio runs on `stable-diffusion.cpp`. For photoreal work, the controls matter.

- Type a prompt and watch the image resolve through a live per-step preview, with progress and an ETA.
- Cancel a run that is not heading the right way instead of waiting it out.
- Keep every result in an artifacts gallery and open any of them in a lightbox to inspect detail.
- Run txt2img from a prompt, or img2img from a photo when you want to keep a real composition and restyle it.
- Apply a style preset like Cinematic as a base, then steer with your own prompt.

Every image lands on your disk and nowhere else. You can disconnect and keep generating.

## Prompting for Photorealism

RealVisXL responds well to plain descriptive language plus photographic terms. Name the lens, the lighting, and the film look.

```
candid portrait of an older man, weathered face, soft window light,
85mm lens, shallow depth of field, natural skin texture, photorealistic
```

A negative prompt earns its place here. Push out the artifacts that break realism (`cartoon, illustration, plastic skin, oversharpened, deformed hands`). Full-step models reward patience, so let the step count run higher than you would for a Turbo model. The extra steps are where fine texture and clean edges come from.

## How Hardware Acceleration Works

On a Mac, the model runs on Metal. Unified memory means the GPU reads the same memory the CPU uses, with no copy step, which helps with the larger working set a photoreal model needs. On Windows, it runs on CUDA for NVIDIA cards or Vulkan as a broader fallback, with CPU available when there is no GPU.

Quantization is what makes a large SDXL checkpoint runnable. The GGUF build trims the weights so the model fits in the memory a normal machine has. With a photoreal model you may prefer a higher-precision quantization if your memory allows, since fine detail is the point and you have less room to spare on fidelity than you would with a stylized model.

## Keeping Quality High

- Let the step count run higher than a Turbo workflow. Full-step models use those steps to build texture and detail.
- Generate near SDXL's native resolution (about 1024 px on the long edge). Going far above it can warp faces and hands.
- Lean on a detailed negative prompt to strip out the cues that read as fake.
- Lock a seed once you get a strong base image, then refine the prompt one change at a time so you keep the composition.

## Privacy: Stronger Than a Cloud Photoreal Generator

A hosted photoreal tool sees every face you generate and every prompt you write. It logs them, and many train on what you upload. With realistic images of people, that exposure is not abstract.

Off Grid AI Desktop runs the model on your machine. No account, no telemetry, nothing sent anywhere. Your prompts and your images stay on the device. The app is AGPL-3.0, so the source is open and you can verify the behavior yourself. With photorealism, local is not a preference. It is the responsible default.

## Getting Started

1. Download or clone Off Grid AI Desktop from the repo: https://github.com/off-grid-ai/desktop
2. Install and launch it on your Mac or PC.
3. Open the Models browser and find the RealVisXL v5.0 GGUF build: https://huggingface.co/offgrid-ai/realvisxl-v5.0-GGUF
4. Download it with the built-in download manager and set it as your image model.
5. Open the image studio, write a descriptive prompt with a strong negative prompt, and generate.

## What's Coming

- More curated GGUF image checkpoints in the Models browser.
- Cross-device sync so your gallery follows you between machines.
- Continued tuning of generation controls and the live preview.

## FAQ

### Q: Is it really free?

Yes. The app is free and open-source under AGPL-3.0, and the model is a free download. No subscription, no credits.

### Q: Does it work fully offline?

Yes. After a one-time download of the app and the model, generation runs with no network connection.

### Q: Is this the Lightning version?

No. This is the full-step RealVisXL v5.0, tuned for quality over speed. Expect higher step counts and more detail than a Lightning or Turbo build.

### Q: How much RAM do I need?

16 GB is the floor. 24 to 32 GB is better for a full-step photoreal model, which carries a larger working set.

### Q: Does it run on Windows or only Mac?

Both. Macs use Metal with unified memory. Windows uses CUDA or Vulkan, with a CPU fallback.

### Q: Is my data private?

Yes. Everything runs locally. No account, no telemetry, no images or prompts sent to a server.

Run RealVisXL 5.0 on your own hardware, offline, today.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
