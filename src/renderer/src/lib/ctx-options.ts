import { DEFAULT_CTX_SIZE, MIN_CAPTURE_CTX_SIZE } from '@offgrid/core/shared/llm-defaults'

// The context-window choices the Settings picker offers. We bound the base ladder by the model's
// TRAINED maximum (from GGUF metadata, surfaced by the backend as modelMaxCtx): offering a window
// the model wasn't trained for is pointless — the engine caps it back down — and misleading. The
// model's own max is always offered so the user can run right up to it (like LM Studio), and the
// currently-selected value is kept so the <select> always reflects the stored setting. Pure.
export function contextWindowOptions(
  base: number[],
  modelMaxCtx: number | null | undefined,
  current: number
): number[] {
  const set = new Set<number>()
  for (const c of base) {
    if (!modelMaxCtx || modelMaxCtx <= 0 || c <= modelMaxCtx) {
      set.add(c)
    }
  }
  if (modelMaxCtx && modelMaxCtx > 0) {
    set.add(modelMaxCtx)
  }
  if (current > 0) {
    set.add(current)
  }
  return [...set].sort((a, b) => a - b)
}

const asK = (n: number): string => `${(n / 1024).toFixed(0)}K`

/** A recommendation is independent of the user's current selection. The fresh 16K default leaves
 * room for capture output; a model trained below the 8K capture floor cannot be recommended for
 * capture at all. */
export function recommendedContextWindow(modelMaxCtx?: number | null): number | null {
  if (modelMaxCtx && modelMaxCtx > 0 && modelMaxCtx < MIN_CAPTURE_CTX_SIZE) return null
  return modelMaxCtx && modelMaxCtx > 0 ? Math.min(DEFAULT_CTX_SIZE, modelMaxCtx) : DEFAULT_CTX_SIZE
}

/** The Context-window hint text. Priority: model-cap (selected exceeds the trained window) →
 *  RAM-clamp (effective below selected) → the model's supported max → the plain default. Pure so
 *  the messaging is asserted without rendering the whole Settings panel. */
export function contextWindowHint(opts: {
  ctxSize?: number
  effectiveCtxSize?: number
  modelMaxCtx?: number | null
}): string {
  const { ctxSize, effectiveCtxSize, modelMaxCtx } = opts
  if (modelMaxCtx && modelMaxCtx > 0 && ctxSize && ctxSize > modelMaxCtx) {
    return `Capped to this model's trained ${asK(modelMaxCtx)} window - it wasn't trained to go higher.`
  }
  if (effectiveCtxSize && ctxSize && effectiveCtxSize < ctxSize) {
    return `Clamped to ${asK(effectiveCtxSize)} for your RAM (a larger value would risk a memory-overcommit freeze). Quantize the KV cache below to raise this.`
  }
  if (modelMaxCtx && modelMaxCtx > 0) {
    return `Larger holds more history; this model supports up to ${asK(modelMaxCtx)}. Changing it reloads the model.`
  }
  return 'Larger holds more history; changing it reloads the model.'
}
