---
title: How to Run Illustrious XL 2.0 Locally in 2026 (Offline Anime and Illustration AI)
published: true
description: Run Illustrious XL v2.0 anime and illustration AI fully on-device on Mac or Windows. No cloud, no account, no API keys.
tags: ai, stablediffusion, anime, privacy
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/how-to-run-illustrious-xl-locally.jpg
---

The laptop you already own has a GPU that can render a finished anime illustration in seconds. That same silicon usually sits at idle while you pay a monthly fee to send prompts to a server in another country. Off Grid AI Desktop is a free, open-source app that runs Illustrious XL v2.0 directly on your Mac or PC.

**[GitHub →](https://github.com/off-grid-ai/desktop)** (free, open-source, runs offline)

Illustrious XL v2.0 is an SDXL checkpoint tuned for anime and illustration. It reads danbooru-style tag prompts, so you describe a picture with comma-separated tags instead of long sentences. The model lives on your disk. The pixels render on your hardware. Nothing about your prompt leaves the machine.

## What You Need

Illustrious XL is an SDXL-class model, so plan for the same footprint as any SDXL checkpoint. The quantized GGUF build keeps the download and the memory load smaller than the original.

| Tier | macOS | Windows |
|---|---|---|
| Minimum | Apple Silicon M1, 16 GB unified memory, macOS 14 | NVIDIA GPU with 6 GB VRAM, or recent CPU, 16 GB RAM |
| Recommended | M2/M3/M4, 24 GB+ unified memory | NVIDIA GPU with 8 GB+ VRAM, 32 GB RAM |
| Disk | ~7 GB free for the model plus headroom | same |

If you are on an older Mac or an integrated GPU, it still runs. You wait longer per image, that is all.

## What Off Grid AI Desktop Does With It

You get a private illustration studio. Type tags, watch the image build, save the ones you like.

- **txt2img and img2img.** Start from a prompt, or feed in a sketch and let the model finish it.
- **Live per-step preview.** You see the picture resolve step by step, with progress and an ETA, and you can cancel a run you do not want.
- **Artifacts gallery and lightbox.** Every image you generate is kept locally so you can compare variations side by side.
- **Style presets.** Anime, Cinematic, Sketch, and more, so you can shift the look without rewriting your whole prompt.

The model browser pulls the GGUF build straight from Hugging Face and manages the download for you.

**Model page: [offgrid-ai/illustrious-xl-v2.0-GGUF](https://huggingface.co/offgrid-ai/illustrious-xl-v2.0-GGUF)**

## How Tag Prompting Works

Illustrious was trained on tagged image data, so it responds to tags, not prose. You write what you want as a list.

```
1girl, solo, long hair, school uniform, cherry blossoms,
looking at viewer, soft lighting, detailed background,
masterpiece, best quality
```

Order matters a little. Tags near the front carry more weight. Quality tags like `masterpiece` and `best quality` go at the end and nudge the overall finish. A short negative prompt cleans up common failures.

```
lowres, bad anatomy, bad hands, extra digits, jpeg artifacts,
watermark, signature
```

If you are used to writing full sentences for other image models, this feels strange for a minute. Then it feels faster. You are picking attributes off a menu, not composing paragraphs.

## How Hardware Acceleration Works

On a Mac, Off Grid AI Desktop runs Illustrious through Metal. Apple Silicon uses unified memory, so the GPU reads the model out of the same pool as the rest of the system. No separate VRAM budget to juggle. The bigger your unified memory, the more comfortable the larger SDXL checkpoints feel.

On Windows, generation runs on CUDA for NVIDIA cards or Vulkan for other GPUs, and falls back to the CPU when no GPU acceleration is available. CPU is slow but it works, which matters on a laptop without a discrete card.

The engine underneath is `stable-diffusion.cpp`. It loads the quantized GGUF weights and runs the diffusion loop in native code. There is no Python environment to install, no `pip` dependency tree to repair, no CUDA toolkit to match against a driver version.

## Picking Quantization

GGUF ships the model at different quantization levels. Lower precision means a smaller file and a lighter memory load, with a gradual trade in fine detail.

If you have the RAM, use a higher-precision build for the cleanest output. If you are tight on memory or want faster loads, drop to a more aggressive quant. For anime and illustration, where flat color and clean line work dominate, the smaller quants hold up well. You will notice the difference more on dense, photoreal scenes than on a character portrait.

Generate a couple of test images at each level on your own hardware and judge with your eyes. That beats any chart.

## Privacy: Stronger Than a Cloud Generator

A hosted anime generator sees every prompt you type and every image you make. Some keep them. Some train on them. Some have a content filter that decides what you are allowed to draw.

Off Grid AI Desktop has none of that. The app runs on-device. There is no account, no telemetry, and no API key. Your prompts and your images stay in a local folder on your own disk. The code is AGPL-3.0, so you can read exactly what it does. Offline is not a mode you switch on. It is the only way it runs.

## Getting Started

1. Download or clone Off Grid AI Desktop from **[GitHub](https://github.com/off-grid-ai/desktop)**.
2. Install and launch it on your Mac or PC.
3. Open the Models browser, search for Illustrious XL v2.0, and download the GGUF build.
4. Go to image generation, select Illustrious as your model, and pick the Anime style preset.
5. Type a tag prompt, set your steps, and generate.

That is the whole loop. Once the model is on disk you can pull the network cable and keep working.

## What's Coming

- More curated GGUF checkpoints in the model browser, across art styles.
- Cross-device sync so your artifacts gallery follows you between machines.
- Broader hardware coverage as `stable-diffusion.cpp` adds backends.

## FAQ

### Q: Is it really free?

Yes. The app is free and open-source under AGPL-3.0. The Illustrious GGUF model is a free download from Hugging Face.

### Q: Does it work offline?

Yes. You need a connection once to download the app and the model. After that it runs with no network at all.

### Q: Do I need to know danbooru tags?

It helps, but you can start with a handful of plain tags and add more as you learn. The community tag vocabulary is well documented, and you pick it up fast by reading prompts that produced images you like.

### Q: How much RAM do I need?

16 GB is a workable floor for this SDXL-class model. 24 GB or more on a Mac, or an 8 GB+ NVIDIA card on Windows, gives you more room and faster runs.

### Q: Does it run on Windows and Mac?

Both. Metal on Apple Silicon, CUDA or Vulkan on Windows, with a CPU fallback when there is no GPU acceleration.

### Q: Is my data private?

Yes. No account, no telemetry, no API keys. Prompts and images stay on your disk.

Run Illustrious XL v2.0 on your own hardware, offline. **[Get Off Grid AI Desktop on GitHub →](https://github.com/off-grid-ai/desktop)**
