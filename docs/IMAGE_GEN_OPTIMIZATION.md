# Image generation performance - findings & roadmap (M4, animagine-xl-4.0 Q8_0)

All numbers measured on an Apple M4, 16GB, generating with the bundled
stable-diffusion.cpp (`sd-cli` / `sd-server`), model `animagine-xl-4.0-Q8_0.gguf`
(a full, non-distilled SDXL checkpoint). Prompt: an anime portrait, cfg 7,
dpm++2m, `--diffusion-fa`.

## The core problem

Two independent costs stack up, and only the second is quality-optional:

| Steps | Quality                   | Wall clock (768²) |
| ----: | ------------------------- | ----------------- |
|     4 | blank / blob (unusable)   | ~19s              |
|     8 | garbage (rainbow banding) | ~47s              |
|    12 | usable                    | ~64s              |
|    20 | good (the target)         | ~105s             |

- **Sampling (UNet) dominates:** ~4.2-4.6 s/step at 768² cfg 7. 20 steps ≈ 92s.
  This is the wall. It's the `ggml_conv_2d` operator - the 2D convolutions in the
  UNet are the primary bottleneck (see arXiv 2412.05781).
- **VAE decode:** ~10-16s at 768² with the full VAE (it falls off the fast Metal
  path at ≥768; at 512² it's ~0.2s).

## Metal IS engaged (not the problem)

Proven from `sd-server`'s own log (`ggml_metal_init: picking default device:
Apple M4`, weights loaded as `VRAM 3996 MB`), and independently: a 20-step run
reported `real 105s` but `user 1.16s` - the CPU was idle-waiting on the GPU. If
this were CPU compute, user time would be in the hundreds of seconds. The
bottleneck is **ggml's generic Metal conv kernels**, ~10× slower than Apple's
hand-tuned kernels (Draw Things) or the ANE - NOT a missing Metal path.

## Why mobile feels faster

iOS does SDXL at ~0.4 s/step on the ANE via Core ML; desktop sd.cpp Metal is
~4.2-4.6 s/step. ~10× gap, and it's kernel quality, not the compute unit. (A
second-opinion analysis noted that on desktop-class M-chips a well-tuned GPU path
actually beats the ANE - so ANE is not the desktop ceiling either.)

## Levers evaluated

| Lever                                                                                                      | Result                                                           | Status                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Persistent `sd-server`** (keep model resident)                                                           | Warm images skip the ~13s Metal shader warmup + ~5s model reload | **DONE** - `src/main/sd-server.ts`, wired into `imagegen.ts`, tested                                   |
| **taesd fast VAE** (`--taesd taesdxl`)                                                                     | VAE decode 1.47s vs ~10-16s (verified live, non-black)           | **DONE** - opt-in `fastVae` param, wired both paths, tested. Needs `taesdxl.safetensors` in models dir |
| **Rebuild from latest upstream** (6314af4 vs bundled 92a3b73)                                              | 4.15-4.5 s/step - NO speedup. Same generic conv kernels          | **Ruled out** for perf (would still bring newer model support)                                         |
| **Winograd conv fork** (arXiv 2412.05781, `SealAILab/stable-diffusion-cpp`, claimed 3-4.79× SDXL on Metal) | Repo is 404 / org gone - not publicly available                  | **Unavailable**; implementing Winograd in ggml ourselves is a major effort                             |
| **`--conv-direct`** flags                                                                                  | 9× SLOWER (33 s/step) - ggml's direct conv is worse              | **Rejected**                                                                                           |
| **f16 instead of q8_0**                                                                                    | Untested (needs ~13GB f16 GGUF, not in our repo)                 | **Open** - may cut per-step (no dequant); worth a benchmark if a file is produced                      |
| **Fewer steps** on the full model                                                                          | Unusable below ~12 steps                                         | **Rejected** (quality)                                                                                 |
| **Distilled model** (Lightning/DMD2)                                                                       | Not yet produced                                                 | **Open - the real quality-preserving speed answer**                                                    |

## Net effect of what shipped tonight

A warm 20-step 768² image: ~105s → persistent server removes ~5-18s (load +
warmup on 2nd+ images) and taesd removes ~9-14s (VAE) → **roughly ~80s warm.**
Meaningful, but NOT iOS-class. The ~90s of UNet sampling is a hard floor with
ggml's Metal kernels.

## The honest path to iOS-class (<10s)

The data points to one conclusion: **full animagine at full quality will not hit
<10s on this engine.** To get there without changing engines you need a
**distilled SDXL model** (SDXL-Lightning / DMD2 / a Lightning-merged animagine)
that looks good at 4-8 steps, run at **512²** (cfg 1, euler ≈ 0.86 s/step) with
**taesd** and the **warm persistent server**:

- 4-step distilled @ 512² ≈ 4 × 0.86s + ~0.3s taesd + warm ≈ **~5s**.

That is the same shape as the mobile pipeline (few-step model, small size, fast
decode). The remaining work is producing/hosting a distilled GGUF (a Lightning
LoRA can't be merged into our quantized weights - needs an f16 base to merge then
re-quantize) and wiring it as the "Fast" image model, keeping full animagine as a
"Max quality" option.

## Follow-ups

1. Produce a distilled anime SDXL GGUF (Lightning/DMD2) → ship as the Fast default.
2. Add `taesdxl.safetensors` / `taesd.safetensors` to the model download catalog,
   and a "Fast VAE" toggle in image settings that sets `fastVae`.
3. Benchmark an f16 animagine GGUF for per-step (only if a file is produced).
4. Validate taesd decode fidelity at a proper step count (20) vs the full VAE.

## Bake attempt - status (blocked on a format handoff, NOT on the concept)

Tried to bake SDXL-Lightning into animagine to ship a few-step q8 Fast model:

- **sd.cpp's runtime LoRA for SDXL is broken.** LCM _and_ Lightning both report
  `2364/2364 tensors applied` but produce corrupted (banded) output - proven across
  q8 AND f16-GGUF, Metal AND CPU, with/without flash-attn. Same models with no LoRA
  are clean. So a runtime LoRA is a dead end here; distillation must be baked into the
  weights.
- **The merge works:** diffusers `fuse_lora` correctly bakes Lightning into animagine.
- **Blocker = merged weights → sd.cpp-loadable GGUF.** Both routes failed:
  (a) diffusers→`convert_diffusers_to_original_sdxl.py` single-file → sd.cpp rejects
  the tensor layout (`... not in model metadata`); (b) sd.cpp `-M convert` on the
  diffusers folder writes a GGUF but then fails `get sd version from file` on load
  (even on the build that wrote it).
- **Next step (highest confidence):** kohya-ss `sdxl_merge_lora.py` merges into the
  ORIGINAL single-file checkpoint (preserves exact tensor keys the working q8 uses) →
  sd.cpp converts that → loadable. Needs re-downloading the f16 base (~6.9GB, deleted
  to reclaim disk). Kept: `loras/{sdxl-lightning-8step,lcm-lora-sdxl}.safetensors`,
  `taesdxl.safetensors`.
- **Parallel bet:** MLX-for-SDXL spike - MLX (MIT, already bundled as mflux) may be
  faster AND apply LoRAs correctly, sidestepping both the slow kernels and the sd.cpp
  LoRA bug. Verdict pending.
