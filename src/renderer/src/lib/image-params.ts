// Pure image-generation parameter resolution — the unit-testable core of the
// image composer's param handling. No React, no IPC, no IO. MemoryChat.tsx is
// coverage-excluded (large UI), so the non-trivial decisions live here and are
// tested directly.
//
// The bug this fixes: the composer used to reset steps/size to a model's default
// on every model change (a `[imgModel]` effect), stomping a value the user had
// typed. The rule below makes the resolution explicit: a user override always
// wins; only when there is no override do we fall back to the model default.

import { effectiveImageParameter, hasImageParameterOverride } from '@offgrid/models'
import {
  resolveImageDimensions,
  setImageDimensions,
  setImageParameter,
  type EffectiveImageDimensions,
  type ImageDimensionOverride,
  type ImageDimensionStore
} from '../../../shared/image-dimensions'

/** Per-model image params the user can override. Stored per model so switching
 *  models restores that model's last value, not a global one. `null`/`undefined`
 *  means "no override — use the model default". */
export type ImageParamOverride = ImageDimensionOverride

/** The single-number params set one at a time; width × height go through setDimensions. */
export type ImageParamKey = 'steps' | 'size' | 'cfgScale'

/** All persisted image-composer params, keyed by model filename. Shape mirrors
 *  what we round-trip through `saveSetting('imageParams', …)` / `getSettings()`. */
export type ImageParamStore = ImageDimensionStore

/** The concrete params the composer should run with for a given model, after
 *  resolving overrides against the model's defaults. */
export type EffectiveImageParams = EffectiveImageDimensions

/** override ?? default. A user override (any finite number) wins; absent (null /
 *  undefined / NaN) falls back to the supplied default. Exported so both the
 *  steps and size resolvers, and their tests, share one rule. */
export function effectiveValue(override: number | null | undefined, fallback: number): number {
  return effectiveImageParameter(override, fallback)
}

/** Resolve the effective steps + size for a model: the user's per-model override
 *  if present, else the shared model default (single source of truth in
 *  image-defaults). Model changes never clobber an override — the override for
 *  the newly-selected model is looked up fresh. */
export function resolveImageParams(
  model: string,
  store: ImageParamStore | null | undefined
): EffectiveImageParams {
  return resolveImageDimensions({ id: model }, store)
}

/** Record a user override for one param of one model, returning a NEW store
 *  (pure — never mutates the input). Passing a value equal to the model default
 *  clears the override so the model tracks its default again. */
export function setOverride(
  store: ImageParamStore | null | undefined,
  model: string,
  key: ImageParamKey,
  value: number
): ImageParamStore {
  return setImageParameter(store, model, key, value)
}

/** Record a custom width × height for one model, snapped to 64 and clamped to 256-2048. A square
 *  result is the same as choosing that size. */
export function setDimensions(
  store: ImageParamStore | null | undefined,
  model: string,
  width: number,
  height: number
): ImageParamStore {
  return setImageDimensions(store, model, width, height)
}

/** True when the user has an explicit override for this model+key (i.e. we must
 *  NOT re-seed it from the model default on a model change). */
export function hasOverride(
  store: ImageParamStore | null | undefined,
  model: string,
  key: ImageParamKey
): boolean {
  return hasImageParameterOverride(store, model, key)
}
