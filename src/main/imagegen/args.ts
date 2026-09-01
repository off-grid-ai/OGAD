// Pure argv construction for each image-gen runtime (Core ML helper, Z-Image
// stack, standard sd-cli checkpoint). No fs / spawn / electron: the I/O shell
// (imagegen.ts) resolves paths (model, companions, taesd, lora dir) and passes
// them in; these functions only assemble the flag vector in the exact order the
// binary expects. The standard builder CALLS standardModelDefaults from the
// shared single-source-of-truth module — it never re-implements the defaults.

import { standardImageModelDefaults } from '@offgrid/models'

/** A general-purpose negative prompt that meaningfully lifts quality when the
 *  caller doesn't supply one. Kept conservative so it doesn't fight most prompts. */
export const DEFAULT_NEGATIVE =
  'blurry, low quality, low resolution, jpeg artifacts, deformed, disfigured, bad anatomy, extra limbs, watermark, text, signature, grainy, oversaturated'

export interface CoreMLArgsInput {
  model: string
  prompt: string
  outPath: string
  steps?: number
  seed: number
  negativePrompt?: string
}

/** Core ML (ANE) helper — directory model, prompt to PNG. No preview file. */
export function buildCoreMLArgs(i: CoreMLArgsInput): string[] {
  const args = [
    '--model',
    i.model,
    '--prompt',
    i.prompt,
    '--output',
    i.outPath,
    '--steps',
    String(i.steps ?? 16),
    '--seed',
    String(i.seed)
  ]
  const neg = i.negativePrompt?.trim()
  if (neg) args.push('--negative', neg)
  return args
}

export interface ZImageArgsInput {
  model: string
  /** Resolved Qwen3-4B text-encoder path. */
  llm: string
  /** Resolved FLUX VAE path. */
  vae: string
  prompt: string
  outPath: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  seed: number
  threads: string
  previewArgs: string[]
}

/** Z-Image is a separate stack: diffusion transformer + Qwen3-4B text encoder
 *  (--llm) + FLUX VAE (--vae). --offload-to-cpu keeps unified memory light.
 *  Distilled turbo model to cfg 1.0, ~8 steps, euler, no negative prompt.
 *  Default 768 (not 1024): a diffusion transformer's cost scales ~with pixel
 *  count, so 768 squared is ~44% less compute/memory than 1024 squared. */
export function buildZImageArgs(i: ZImageArgsInput): string[] {
  return [
    '-M',
    'img_gen',
    '--diffusion-model',
    i.model,
    '--llm',
    i.llm,
    '--vae',
    i.vae,
    '-p',
    i.prompt,
    '-o',
    i.outPath,
    '-W',
    String(i.width ?? 768),
    '-H',
    String(i.height ?? 768),
    '--steps',
    String(i.steps ?? 8),
    '--cfg-scale',
    String(i.cfgScale ?? 1.0),
    '--sampling-method',
    'euler',
    // Keep weights + VAE off the Metal device between/at use so the resident
    // footprint (DiT + 4B encoder + VAE) doesn't spike past unified memory.
    '--offload-to-cpu',
    '--vae-on-cpu',
    '--diffusion-fa',
    '-t',
    i.threads,
    '-s',
    String(i.seed),
    ...i.previewArgs
  ]
}

export interface StandardArgsInput {
  /** Model filename (basename) — drives the shared defaults. */
  base: string
  /** Model-loading flags: ['-m', model] for a full checkpoint, or the
   *  --diffusion-model + --clip_l/--clip_g/--vae vector for a UNET-only quant.
   *  Resolved by the I/O shell (companion lookup). */
  modelFlags: string[]
  prompt: string
  outPath: string
  width?: number
  height?: number
  steps?: number
  cfgScale?: number
  seed: number
  threads: string
  previewArgs: string[]
  /** Resolved TAESD decoder path when fastVae is on and the file is installed;
   *  null otherwise. When present it makes VAE-tiling moot (preferred). */
  taesdPath?: string | null
  negativePrompt?: string
  /** Init image path for img2img (undefined for txt2img). */
  initImage?: string
  strength?: number
}

/** Standard sd-cli checkpoint. Per-model defaults come from the shared
 *  standardModelDefaults (single source of truth) — NOT re-derived here. */
export function buildStandardArgs(i: StandardArgsInput): string[] {
  const { defaultSize, defaultSteps, defaultCfg, sampler, scheduler, isXL } =
    standardImageModelDefaults(i.base)
  const args = [
    '-M',
    'img_gen',
    ...i.modelFlags,
    '-p',
    i.prompt,
    '-o',
    i.outPath,
    '-W',
    String(i.width ?? defaultSize),
    '-H',
    String(i.height ?? defaultSize),
    '--steps',
    String(i.steps ?? defaultSteps),
    '--cfg-scale',
    String(i.cfgScale ?? defaultCfg),
    '--sampling-method',
    sampler,
    '--scheduler',
    scheduler,
    '--diffusion-fa',
    '-t',
    i.threads,
    '-s',
    String(i.seed),
    ...i.previewArgs
  ]
  const effW = i.width ?? defaultSize
  const effH = i.height ?? defaultSize
  // TAESD decode: OFF by default (it softens detail and blanks at 1024); the
  // quality recipe uses the full VAE. Strictly opt-in via fastVae for a fast
  // low-res draft. When present it makes VAE-tiling moot, so prefer it.
  if (i.taesdPath) args.push('--taesd', i.taesdPath)
  else if (isXL && Math.max(effW, effH) > 768) args.push('--vae-tiling')
  args.push('-n', i.negativePrompt?.trim() || DEFAULT_NEGATIVE)
  // img2img (not supported by Z-Image gen-only turbo).
  if (i.initImage) {
    args.push('-i', i.initImage, '--strength', String(i.strength ?? 0.75))
  }
  return args
}
