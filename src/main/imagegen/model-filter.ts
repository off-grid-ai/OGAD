// Pure image-model filename classifier used by the model picker. No fs — the
// caller lists the models dir and runs each entry through isImageModelFile.

// Exclude LLM / companion / non-diffusion files so they don't show as pickable
// image models (gemma/qwen LLMs, the Z-Image Qwen3 encoder + FLUX ae VAE,
// whisper .bin, TTS .onnx, and standalone VAE/CLIP/T5 components).
const EXCLUDE =
  /qwen3-4b-instruct|gemma|^qwen(?![-_]?image)[^-]|mmproj|^ae\.|ggml-|kokoro|lessac|en_us|^clip[_-]?[lg]\b|[-_.](vae|clip|t5xxl|text_encoder|tokenizer)\b/i

// A .gguf counts as an image model only if the filename names a known diffusion
// family — otherwise a stray gguf (an LLM missed by EXCLUDE) would show up.
const DIFFUSION_FAMILY =
  /(stable[-_]diffusion|sd[-_]?xl|sdxl|sd[-_]?1|sd[-_]?2|sd[-_]?3|lightning|turbo|flux|z[-_]?image|qwen[-_]?image|diffusion|pony|illustrious|animagine|juggernaut|realvis|dreamshaper|epicrealism|noob|absolute|chillout|counterfeit|anything)/i

/** Whether a filename in the models dir is a pickable image model. */
export function isImageModelFile(f: string): boolean {
  if (EXCLUDE.test(f)) return false
  // Custom checkpoints (Civitai etc.) ship as a single .safetensors.
  if (/\.safetensors$/i.test(f)) return true
  if (/\.gguf$/i.test(f)) return DIFFUSION_FAMILY.test(f)
  return false
}

// Model-checkpoint / LoRA file extensions. The same set was inlined three times in
// imagegen (the LoRA lister's include + name-strip, and the LoRA-path builder);
// defined once here so they can't drift.
const CHECKPOINT_EXT = /\.(safetensors|ckpt|gguf|pt)$/i

/** Whether a filename carries a model-checkpoint extension. */
export function hasCheckpointExt(name: string): boolean {
  return CHECKPOINT_EXT.test(name)
}

/** Filename with any model-checkpoint extension removed (for a display name). */
export function stripCheckpointExt(name: string): string {
  return name.replace(CHECKPOINT_EXT, '')
}

/** A LoRA reference guaranteed to carry an extension, defaulting to .safetensors. */
export function ensureCheckpointExt(name: string): string {
  return hasCheckpointExt(name) ? name : `${name}.safetensors`
}
