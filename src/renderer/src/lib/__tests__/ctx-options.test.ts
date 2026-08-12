import { describe, it, expect } from 'vitest'
import { contextWindowOptions, contextWindowHint, recommendedContextWindow } from '../ctx-options'

const BASE = [4096, 8192, 16384, 32768, 65536, 131072]

describe('contextWindowOptions', () => {
  it('returns the full ladder when the model max is unknown', () => {
    expect(contextWindowOptions(BASE, null, 16384)).toEqual(BASE)
  })

  it('drops windows larger than the model trained max, and includes the max itself', () => {
    expect(contextWindowOptions(BASE, 32768, 16384)).toEqual([4096, 8192, 16384, 32768])
  })

  it('offers the exact model max even when it is not on the base ladder', () => {
    // A 40960-trained model → offer up to 40960, not just 32768.
    expect(contextWindowOptions(BASE, 40960, 8192)).toEqual([4096, 8192, 16384, 32768, 40960])
  })

  it('keeps the currently-selected value so the <select> reflects the stored setting', () => {
    // Persisted 65536 but the model only trained to 32768 → still show 65536 (engine caps it; the
    // hint explains). Otherwise the control would render blank.
    expect(contextWindowOptions(BASE, 32768, 65536)).toEqual([4096, 8192, 16384, 32768, 65536])
  })

  it('is de-duped and ascending', () => {
    expect(contextWindowOptions([8192, 8192, 4096], null, 8192)).toEqual([4096, 8192])
  })
})

describe('contextWindowHint', () => {
  it('explains the model cap when the selected window exceeds the trained max', () => {
    const hint = contextWindowHint({ ctxSize: 65536, modelMaxCtx: 32768 })
    expect(hint).toContain('trained 32K window')
    expect(hint).toContain("wasn't trained to go higher")
  })

  it('explains the RAM clamp when the effective window is below the selected one', () => {
    const hint = contextWindowHint({ ctxSize: 32768, effectiveCtxSize: 16384, modelMaxCtx: 131072 })
    expect(hint).toContain('Clamped to 16K for your RAM')
  })

  it('surfaces the model max when nothing is clamped or capped', () => {
    expect(
      contextWindowHint({ ctxSize: 16384, effectiveCtxSize: 16384, modelMaxCtx: 131072 })
    ).toBe(
      'Larger holds more history; this model supports up to 128K. Changing it reloads the model.'
    )
  })

  it('falls back to the plain hint when the model max is unknown', () => {
    expect(contextWindowHint({ ctxSize: 16384 })).toBe(
      'Larger holds more history; changing it reloads the model.'
    )
  })

  it('prioritizes the model cap over the RAM clamp', () => {
    // Both conditions true → the cap message wins (it's the harder ceiling).
    expect(
      contextWindowHint({ ctxSize: 65536, effectiveCtxSize: 20480, modelMaxCtx: 32768 })
    ).toContain('Capped to this')
  })
})

describe('recommendedContextWindow', () => {
  it('recommends the 16K capture-safe default independently of the current selection', () => {
    expect(recommendedContextWindow(262144)).toBe(16384)
    expect(recommendedContextWindow(null)).toBe(16384)
  })

  it('uses a smaller trained window only when it still meets the 8K capture floor', () => {
    expect(recommendedContextWindow(12288)).toBe(12288)
    expect(recommendedContextWindow(4096)).toBeNull()
  })
})
