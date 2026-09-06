// Image parameter policy lives in @offgrid/models (parameter-overrides). These names are kept for
// the composer, the Image settings tab, and their tests.
import {
  effectiveImageParameter,
  hasImageParameterOverride,
  resolveImageParameters,
  setImageParameterOverride,
  type EffectiveImageParameters,
  type ImageParameterOverride,
  type ImageParameterStore
} from '@offgrid/application'

export type ImageParamOverride = ImageParameterOverride
export type ImageParamStore = ImageParameterStore
export type EffectiveImageParams = EffectiveImageParameters

export const effectiveValue = effectiveImageParameter
export const setOverride = setImageParameterOverride
export const hasOverride = hasImageParameterOverride

/** Resolve the effective params for a model id (the composer keys its store by model id). */
export function resolveImageParams(
  model: string,
  store: ImageParamStore | null | undefined
): EffectiveImageParams {
  return resolveImageParameters({ id: model }, store)
}
