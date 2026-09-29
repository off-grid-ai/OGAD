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

## Live verification — September 29, 2026

A local run through the normal Desktop gateway completed with this configuration:

| Setting              | Value                             |
| -------------------- | --------------------------------- |
| Model                | Wan 2.2 TI2V 5B, Q5_K_M           |
| Text encoder         | UMT5 XXL, Q4_K_M                  |
| Size                 | 832 × 480                         |
| Frames / frame rate  | 17 / 8 FPS                        |
| Steps / guidance     | 30 / 6                            |
| Sampler / flow shift | Euler / 3                         |
| Seed                 | 42                                |
| Runtime              | Metal on Apple M5; CPU VAE decode |
| Elapsed time         | 29 minutes, 2 seconds             |

The prompt described one red ball rolling slowly across a wooden table in natural
light. The MP4 was 2.125 seconds long. This run confirms completion with these
settings; it does not establish a quality or speed guarantee for other models or devices.

The following checks used the completed job and did not start another generation:

- The status API returned `completed` without a stale stage or progress count.
- The content API returned `video/mp4`; its bytes matched the saved file.
- Cancelling the completed job returned `cancelled: false`.
- The completed preview endpoint and an unknown job returned HTTP 404.
- The durable job record and video sidecar were present. Temporary video and
  preview files were removed.
- Fullscreen entry and Escape exit worked in the normal Desktop player after
  the app permission fix. PiP entry and exit worked. Native PiP playback controls
  could not be inspected through the available window binding.

Storage ownership, Auto Configure selection, scoped gallery listing, and the
OGAD remote adapter were reviewed in source. No model was deleted and no
interrupted job was created for this check. Restart recovery of an interrupted
job and a two-device OGAD video request still need a separate live check.
