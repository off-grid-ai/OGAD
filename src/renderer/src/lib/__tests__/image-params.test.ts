import { describe, it, expect } from 'vitest'
import { standardModelDefaults } from '../../../../shared/image-defaults'
import {
  effectiveValue,
  resolveImageParams,
  setOverride,
  hasOverride,
  type ImageParamStore
} from '../image-params'

// A distilled few-step model (defaultSteps 10, defaultSize 512) and a full
// checkpoint (defaultSteps 28) — asserted against the SINGLE source of truth so
// this test breaks if the defaults change, rather than re-hardcoding them.
const FEW_STEP = 'sdxl-lightning.gguf'
const FULL = 'dreamlike-photoreal-v2.gguf'

describe('effectiveValue — override ?? default', () => {
  it('uses the override when it is a finite number', () => {
    expect(effectiveValue(10, 28)).toBe(10)
  })
  it('falls back to the default when override is undefined', () => {
    expect(effectiveValue(undefined, 28)).toBe(28)
  })
  it('falls back to the default when override is null', () => {
    expect(effectiveValue(null, 28)).toBe(28)
  })
  it('falls back to the default when override is NaN', () => {
    expect(effectiveValue(Number.NaN, 28)).toBe(28)
  })
  it('treats 0 as a real override (finite), not absent', () => {
    expect(effectiveValue(0, 28)).toBe(0)
  })
})

describe('resolveImageParams — model default vs user override', () => {
  it('with no store, returns the model defaults from the shared source of truth', () => {
    const d = standardModelDefaults(FULL)
    expect(resolveImageParams(FULL, null)).toEqual({
      steps: d.defaultSteps,
      size: d.defaultSize,
      width: d.defaultSize,
      height: d.defaultSize,
      cfgScale: d.defaultCfg
    })
  })

  it('a per-model steps override wins over the model default', () => {
    const store: ImageParamStore = { [FULL]: { steps: 10 } }
    const d = standardModelDefaults(FULL)
    // The bug: this used to snap back to d.defaultSteps (28) on model change.
    expect(resolveImageParams(FULL, store).steps).toBe(10)
    expect(resolveImageParams(FULL, store).size).toBe(d.defaultSize)
    expect(resolveImageParams(FULL, store).cfgScale).toBe(d.defaultCfg)
  })

  it('overrides are per-model — switching models does not clobber the other model', () => {
    const store: ImageParamStore = { [FULL]: { steps: 10 }, [FEW_STEP]: { steps: 24 } }
    expect(resolveImageParams(FULL, store).steps).toBe(10)
    expect(resolveImageParams(FEW_STEP, store).steps).toBe(24)
  })

  it('a model with no entry falls back to its own default even when another model is overridden', () => {
    const store: ImageParamStore = { [FULL]: { steps: 10 } }
    const fewDefaults = standardModelDefaults(FEW_STEP)
    expect(resolveImageParams(FEW_STEP, store).steps).toBe(fewDefaults.defaultSteps)
  })

  it('resolves size overrides independently of steps', () => {
    const store: ImageParamStore = { [FEW_STEP]: { size: 768 } }
    const d = standardModelDefaults(FEW_STEP)
    expect(resolveImageParams(FEW_STEP, store)).toEqual({
      steps: d.defaultSteps,
      size: 768,
      width: 768,
      height: 768,
      cfgScale: d.defaultCfg
    })
  })

  it('resolves a guidance override from the same per-model store', () => {
    const store: ImageParamStore = { [FULL]: { cfgScale: 5.5 } }
    expect(resolveImageParams(FULL, store).cfgScale).toBe(5.5)
    expect(resolveImageParams(FEW_STEP, store).cfgScale).toBe(
      standardModelDefaults(FEW_STEP).defaultCfg
    )
  })
})

describe('setOverride — pure, per-model persistence', () => {
  it('records an override without mutating the input store', () => {
    const store: ImageParamStore = {}
    const next = setOverride(store, FULL, 'steps', 12)
    expect(next[FULL]).toEqual({ steps: 12 })
    expect(store).toEqual({}) // original untouched
  })

  it('setting a value equal to the model default clears that override', () => {
    const d = standardModelDefaults(FULL)
    const store: ImageParamStore = { [FULL]: { steps: 12 } }
    const next = setOverride(store, FULL, 'steps', d.defaultSteps)
    // steps back at default -> no override left -> the model entry drops out
    expect(next[FULL]).toBeUndefined()
  })

  it('keeps a size override when only steps is reset to default', () => {
    const d = standardModelDefaults(FULL)
    const store: ImageParamStore = { [FULL]: { steps: 12, size: 768 } }
    const next = setOverride(store, FULL, 'steps', d.defaultSteps)
    expect(next[FULL]).toEqual({ size: 768 })
  })

  it('keeps guidance independent and clears it at the shared model default', () => {
    const defaults = standardModelDefaults(FULL)
    const store: ImageParamStore = { [FULL]: { steps: 12, cfgScale: 5.5 } }
    const next = setOverride(store, FULL, 'cfgScale', defaults.defaultCfg)
    expect(next[FULL]).toEqual({ steps: 12 })
  })

  it('overwrites an existing override with a new value', () => {
    const store: ImageParamStore = { [FULL]: { steps: 12 } }
    const next = setOverride(store, FULL, 'steps', 20)
    expect(next[FULL]).toEqual({ steps: 20 })
  })
})

describe('hasOverride — has the user pinned this param?', () => {
  it('true when a finite override is stored', () => {
    expect(hasOverride({ [FULL]: { steps: 12 } }, FULL, 'steps')).toBe(true)
  })
  it('false when no store', () => {
    expect(hasOverride(null, FULL, 'steps')).toBe(false)
  })
  it('false when the model has no entry', () => {
    expect(hasOverride({ [FEW_STEP]: { steps: 12 } }, FULL, 'steps')).toBe(false)
  })
  it('false for a param the user never set', () => {
    expect(hasOverride({ [FULL]: { steps: 12 } }, FULL, 'size')).toBe(false)
  })
})
