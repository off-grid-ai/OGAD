// Pure runtime/model predicates for image generation — no fs, no spawn, no
// electron. The I/O shell (imagegen.ts) reads the directory / platform and feeds
// the results in; these functions only decide.

// Re-export so callers get the mflux id check from a single place alongside the
// other runtime predicates (the concrete list lives in ../mflux).
export { isMfluxModelId } from '../mflux'
// The Z-Image family test is a model fact and lives in shared; kept on this path for its callers.
export { isZImageModel } from '@offgrid/models'

/** A Core ML model is a DIRECTORY that contains a compiled .mlmodelc resource.
 *  The caller passes the directory's entry names (fs.readdirSync result); this
 *  only inspects them. Core ML is macOS-only, so the caller gates on platform
 *  before treating a dir as Core ML. */
export function hasMlmodelc(entries: string[]): boolean {
  return entries.some((f) => /\.mlmodelc$/i.test(f))
}

/** A quantized checkpoint (q8_0 / Q4_K …) — LoRA can't be merged into these. */
export function isQuantizedModel(base: string): boolean {
  return /[._-]q\d/i.test(base)
}
