import {
  imageTaesdFilename,
  standardImageModelDefaults,
  type StandardImageModelDefaults
} from '@offgrid/models'

// Per-model image generation defaults — the SINGLE source of truth, shared by
// BOTH the main process (sd-server + sd-cli runtimes in imagegen.ts) AND the
// renderer (MemoryChat image composer). Keep it here in @offgrid/models so the
// two layers can never drift (a duplicated copy in the renderer once defaulted
// turbo models to 4 steps -> rainbow artifacts, contradicting the main process).
//
// Pure (no IO / no electron / no node) so it's unit-testable and importable from
// the renderer.
//
// The defaults encode the quality/speed tradeoff measured on an M4:
// - Distilled few-step models (SDXL-Lightning, *-Turbo, DMD2, Hyper) render at
//   good quality with ~10 steps / cfg 2 ONLY IF the KARRAS sigma schedule is used.
//   The default `discrete` schedule undercooks few-step sigmas -> smeared output
//   (the single biggest quality bug). 4 steps is too few (rainbow artifacts).
//   At 512² this is ~30s warm; 1024² is crisper but ~90s (the "quality" tier).
// - Full (non-distilled) checkpoints need ~28 steps + real CFG for quality;
//   dropping their step count wrecks the image, and they're fine on `discrete`.

export type StandardModelDefaults = StandardImageModelDefaults

/** Resolve the generation defaults for a checkpoint from its filename. */
export function standardModelDefaults(baseName: string): StandardModelDefaults {
  return standardImageModelDefaults(baseName)
}

/** The Tiny AutoEncoder (TAESD) filename that matches a checkpoint's family.
 *  TAESD is a tiny drop-in VAE that decodes fast but softens detail and BLANKS at
 *  1024 (it overflows), so it's opt-in only (fast low-res drafts), never the
 *  default. SDXL needs the SDXL-specific decoder (taesdxl); SD1.5/SD2 use the base
 *  taesd. The file is fetched separately (madebyollin/taesd*). Pure. */
export function taesdFilename(baseName: string): string {
  return imageTaesdFilename(baseName)
}
