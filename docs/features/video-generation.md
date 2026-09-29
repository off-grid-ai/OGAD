# Video generation

[← All features](../FEATURES.md)

- Search Hugging Face or choose a video model in Models → Video. Each download
  includes the files needed by the model.
- Create silent clips in chat with video mode or the `generate_video` tool.
- Set size, frame count, frame rate, steps, guidance, and seed.
- View, stop, save, and play generated clips.
- Use the [OGAD video job API](../API.md#video-generation) from another device.

## macOS runtime

The bundled Apple Silicon runtime is stable-diffusion.cpp commit
`3f8527a46c54ecf4cb4ed6003da8e8982283c73c`. Rebuild it with
`bash scripts/build-image-macos.sh`. The script pins the source and submodule,
builds Metal support for macOS 13 or later, and stages the CLI, server, and
library in `resources/bin/sd`.

Wan 2.2 uses Metal for diffusion and CPU for VAE decoding. This selection follows
a live M5 check: all-Metal decoding did not finish after tens of minutes; the CPU decoder
completed the clip. Other platforms keep their existing backend selection.

Video remains expensive. A successful 832 × 480, 17-frame, 20-step Wan 2.2 run
on an M5 with 32 GB RAM took about 25 minutes, including concurrent build work.
This is a measured development run, not a device benchmark.
