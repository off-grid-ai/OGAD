import {
  resolveImageParameters,
  setImageParameterOverride,
  type EffectiveImageParameters,
  type ImageParameterOverride,
  type ImageParameterStore
} from '@offgrid/models'

// Per-model image width × height, on top of the square `size` in @offgrid/models.
// A square choice is stored as `size`; only a non-square one adds `width` + `height`,
// which win over `size` when both are set. Pure — shared by main and the renderer.

/** The square sizes the image controls offer as one-click choices. */
export const IMAGE_SIZE_PRESETS = [256, 512, 640, 768, 1024] as const

export const MIN_IMAGE_DIMENSION = 256
export const MAX_IMAGE_DIMENSION = 2048

/** Round to a multiple of 64 (diffusion models require it) and clamp to 256-2048. A non-finite
 *  input clamps to the floor rather than leaking NaN into image generation. */
export function snapImageDimension(n: number): number {
  if (!Number.isFinite(n)) return MIN_IMAGE_DIMENSION
  return Math.max(MIN_IMAGE_DIMENSION, Math.min(MAX_IMAGE_DIMENSION, Math.round(n / 64) * 64))
}

export interface ImageDimensionOverride extends ImageParameterOverride {
  width?: number | null
  height?: number | null
}

export type ImageDimensionStore = Record<string, ImageDimensionOverride>

export interface EffectiveImageDimensions extends EffectiveImageParameters {
  width: number
  height: number
}

const isDimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function storedDimensions(
  entry: ImageDimensionOverride | undefined
): { width: number; height: number } | null {
  return entry && isDimension(entry.width) && isDimension(entry.height)
    ? { width: entry.width, height: entry.height }
    : null
}

function withoutDimensions(entry: ImageDimensionOverride): ImageParameterOverride {
  const { width: _width, height: _height, ...rest } = entry
  return rest
}

/** Resolve a model's steps, guidance and size, plus the width × height it renders at. */
export function resolveImageDimensions(
  model: { id: string; name?: string },
  store: ImageDimensionStore | null | undefined
): EffectiveImageDimensions {
  const base = resolveImageParameters(model, store as ImageParameterStore | null | undefined)
  const entry = store?.[model.id] ?? (model.name ? store?.[model.name] : undefined)
  const dimensions = storedDimensions(entry)
  return { ...base, width: dimensions?.width ?? base.size, height: dimensions?.height ?? base.size }
}

/** Record one steps/size/guidance override. Choosing a square `size` drops a custom width ×
 *  height; any other change keeps it. */
export function setImageParameter(
  store: ImageDimensionStore | null | undefined,
  model: string,
  key: keyof ImageParameterOverride,
  value: number
): ImageDimensionStore {
  const dimensions = key === 'size' ? null : storedDimensions(store?.[model])
  const next: ImageDimensionStore = setImageParameterOverride(
    store as ImageParameterStore | null | undefined,
    model,
    key,
    value
  )
  const entry = next[model] ? withoutDimensions(next[model]!) : {}
  if (dimensions) next[model] = { ...entry, ...dimensions }
  else if (Object.values(entry).some((item) => item != null)) next[model] = entry
  else delete next[model]
  return next
}

/** Record a width × height, snapped to 64 and clamped. A square result is stored as `size`. */
export function setImageDimensions(
  store: ImageDimensionStore | null | undefined,
  model: string,
  width: number,
  height: number
): ImageDimensionStore {
  const w = snapImageDimension(width)
  const h = snapImageDimension(height)
  if (w === h) return setImageParameter(store, model, 'size', w)
  const next: ImageDimensionStore = { ...(store ?? {}) }
  next[model] = { ...withoutDimensions(next[model] ?? {}), width: w, height: h }
  return next
}
