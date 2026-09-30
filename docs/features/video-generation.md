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

## Native preview builds on Windows and Linux

All source builds use `scripts/prepare-image-runtime.mjs` for the pinned runtime
above and the same decode progress and first-frame preview patches.

- Linux Vulkan: `OFFGRID_BUILD_IMAGE_FROM_SOURCE=1 bash scripts/fetch-image-linux.sh`.
  The build host needs CMake, a C++ compiler, and Vulkan development tools.
- Linux CUDA: `OFFGRID_BUILD_IMAGE_CUDA_FROM_SOURCE=1 bash scripts/build-image-cuda-linux.sh`.
  This uses the script's pinned CUDA build container.
- Windows: `./scripts/build-image-windows.ps1 -Backend cpu`, `vulkan`, or `cuda`.
  The build host needs MSVC, CMake, and the selected GPU SDK. Set
  `$env:OFFGRID_BUILD_IMAGE_FROM_SOURCE = '1'` before the existing Windows fetch
  scripts to select these builds during packaging.

Each source build checks that the CLI exposes `--decode-preview-path`. The shared
source and CLI compiled on macOS, Windows CPU, and Linux CUDA (Tesla T4, SM75).
Windows GPU builds remain unverified: the checked VM has neither the CUDA toolkit
nor the Vulkan SDK. Default archive downloads remain unchanged; they do not gain
decode previews until new runtime archives are built and pinned.

A separate Linux CUDA run at 832 × 480, 9 frames, 20 steps, CFG 6, and seed
80886910 completed in 111.96 seconds with the Wan 2.1 Q3 pack. It emitted all ten
decode-section updates and the final frame callback. The saved 832 × 480 preview
showed a clear red ball and matched the decoded pixels of output frame zero
(MD5 `767c1d9f057d14e884a563a96d062395`). All nine output frames were saved.
This verifies the native callback and preview file, not the app preview UI.
The checked Linux CLI SHA-256 is
`3c1000bfdc4c6dc4c9fe3419f4dad80f94976eb848b64b8e97d84ccbfb256b84`.
The Windows CPU CLI built with MSVC and passed the preview-option check; its
SHA-256 is `dc5b6dc46596fae77dce8a24293a727eac6596806f415b57ec59f78eed60244b`.

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

## Live settings check — September 30, 2026

The normal Desktop Settings → Setup & health screen showed three video packs in
Storage: Wan 2.1 Q3_K_M (4.4 GB), Wan 2.1 (6.7 GB), and Wan 2.2 (8.9 GB). Each
had a Delete control. No model was deleted. The compact copied pack appeared as
an installed model, not an unused file.

Auto Configure's displayed plan included “Wan 2.1 (1.3B) VIDEO GENERATION” and
marked it installed. Clicking Configure during the check started the selected
plan's Gemma 4 12B download. Cancel stopped it at 1%; the app removed the new
partial file and the active model selections stayed unchanged.

A separate HTTP client read the running OGAD server's video capability, completed
job, and MP4 content. This checks the server contract on the same Mac; it is not
a two-device generation check. Scoped gallery listing and the OGAD remote
adapter were reviewed in source. Restart recovery of an interrupted video job
and a two-device OGAD video request still need a separate live check.

### Live cancellation and retry

Two additional local Wan 2.2 jobs used 832 × 480, 9 frames, 8 FPS, and 4 steps.
The first was cancelled during preparation. A new job was then accepted and
reached sampling; it had entered VAE decoding when the second cancellation
request arrived. Both cancellation requests returned `cancelled: true` and
settled as `failed` with `error.type: cancelled`, as required by existing remote
clients. Both native engine processes exited. No temporary raw video or preview
files remained. The cancelled state was present in the durable API job record.
These checks did not restart the app or exercise recovery after a process crash.

## Live Windows CUDA check — September 30, 2026

The Windows branch artifact built successfully in [run 36631863697](https://github.com/off-grid-ai/OGAD/actions/runs/36631863697),
with Core `2f8d4bfe6` and shared models `b2d1ea5`. Windows typechecking,
bundling, and installer packaging passed. No test suite or release publication ran.

The separate unpacked artifact ran in server-only mode with the original profile
on a Tesla T4 (15 GB VRAM). The installed app was stopped after checking that no
API job was active; its installation was unchanged and its database files were
backed up. The existing CUDA performance pack was selected explicitly through
`OFFGRID_PERFORMANCE_PACK_BIN`. This artifact predates the automatic headless
pack-activation fix, so this run does not verify that fix.

The normal model-download API installed the complete Wan 2.1 pack (6,747,264,190
bytes): FP16 diffusion model, Q4_K_M UMT5 encoder, and VAE. The health API then
reported `video_generation: ready` and `offgrid-video-v1`.

| Setting | Verified run |
| --- | --- |
| Model | Wan 2.1 T2V 1.3B, FP16 |
| Size | 832 × 480 |
| Frames / frame rate | 9 / 16 FPS |
| Steps / guidance / seed | 20 / 6 / 42 |
| Runtime | Installed `sd-cuda`; Tesla T4 at 100% GPU use during sampling |
| Elapsed time | 97.3 seconds |
| Output | H.264 MP4, 9 frames, 0.562 seconds, 52,870 bytes |

The prompt described a glossy red ball rolling slowly across a wooden table.
Frames 0, 4, and 8 showed a clear red ball, with little motion over this short
clip. This confirms output at the requested size, not a general quality guarantee.
A preceding 512 × 288, 17-frame run completed in 74.6 seconds as a pipeline check.

The completed content endpoint returned the same bytes as the saved MP4 (SHA-256
`05560d68f6d1fb5855c85b0b50e3bb581976e227c965a91af8677e3f7ccaa3ce`).
Both jobs were terminal and no `sd-cli.exe` remained after completion. The
Windows upstream runtime does not include our decode-section/frame-preview
callback patch. The checks below cover additional API and player behavior.

### Cross-machine HTTP check

A Mac HTTP client then reached the Windows gateway through an SSH tunnel bound
to Mac loopback. This did not change firewall rules or expose a new public port.
The health and video-model discovery endpoints returned the installed Wan model
with `offgrid-video-v1`. The completed job and MP4 content returned HTTP 200;
the transferred MP4 matched the checksum above. OpenAPI listed all five video
routes. No new generation or paid provider call was made.

This verifies transport and completed output retrieval between two machines.
It does not verify the Desktop or mobile remote-adapter UI, a new remote job's
progress/cancellation, or model sync. Those checks can use this same local Windows
engine without provider credentials or paid inference. The app client must select
the OGAD server and its video model before submitting a new local-engine request.

### Cancellation, recovery, and player checks

A preparation-stage cancellation returned `cancelled: true`, then persisted
`failed` with `error.type: cancelled`. No native engine process remained.
A second local job reached sampling step 2 of 20. The dedicated verification app
process and its child engine were then stopped to check interruption recovery.
After restart with the same profile, the job became `failed` with
`error.type: interrupted`. That result and its timestamp were saved in the job
record. No engine process remained.

After the Mac was unlocked, Windows App provided the VM desktop. The same branch
ASAR ran through stock Electron 39.2.7 in development mode with the original
profile. This skipped the packaged app updater and preserved the installed app.
The gallery listed both generated clips. The 480p clip played inline. The native
picture-in-picture window opened, showed a play control, and returned to the
inline player with Back to tab. Its very short duration did not allow a useful
pause/resume check.

Fullscreen first failed because the packaged app's history router changed its
file URL from `index.html` to `/chat`. The permission handler now checks the last
full document navigation against the exact app renderer path. It allows history
routes only in that same main window and main frame; a foreign document or
pending navigation remains denied. With this change applied to the separate
verification artifact, the gallery player entered fullscreen and Escape returned
to the gallery. The main-process typecheck passed. No test suite ran.
These player checks do not verify engine discovery in that development launch.

### Windows client reads Linux output

A Windows HTTP client reached the Linux gateway through an SSH tunnel bound to
Windows loopback. The health response advertised the installed Wan Q3 video pack.
Job `c44fe77a-b4d4-4ade-9af4-92ee84177cd4` returned `completed`. Its content
endpoint delivered 247,042 bytes with SHA-256
`2d96bc6943f1403a581f8c79e1cd4e7daa68932cb51419d5685b9b7d71d2ae0e`,
matching the file received by the Mac app. No additional generation was submitted.
This verifies Windows-to-Linux completed output retrieval, not a Windows app
submission or model sync.
