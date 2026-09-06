// Branch fill for the shared text-runtime policy. model-sizing.test.ts covers the headline fixes;
// this drives the remaining branches: the null-coalescing defaults on missing model
// fields, preferredModelIds' conservative-vs-other split under 24GB, and the deeper
// chooseChatModel fallback ladder (comfy -> smallest eligible -> smallest text -> null).
import { describe, it, expect } from 'vitest'
import {
  modelFileBytes as totalBytes,
  chooseTextModel as chooseChatModel,
  preferredTextModelIds as preferredModelIds,
  recommendedTextModelParamCeiling as recommendedParamCeiling,
  textRuntimeModeBudget as modeBudget,
  type SizingModel
} from '@offgrid/models'

describe('recommendedParamCeiling - every RAM tier per mode', () => {
  it('conservative steps 1.5 -> 2 -> 4 -> 8 across the tiers', () => {
    expect(recommendedParamCeiling(4, 'conservative')).toBe(1.5) // < 8
    expect(recommendedParamCeiling(16, 'conservative')).toBe(2) // 8..24
    expect(recommendedParamCeiling(24, 'conservative')).toBe(4) // 24..32
    expect(recommendedParamCeiling(64, 'conservative')).toBe(8) // 32+
  })

  it('extreme steps 4 -> 8 -> 14 -> 32 across the tiers', () => {
    expect(recommendedParamCeiling(16, 'extreme')).toBe(4) // < 24 (never 8B on 16GB)
    expect(recommendedParamCeiling(24, 'extreme')).toBe(8) // 24..32
    expect(recommendedParamCeiling(32, 'extreme')).toBe(14) // 32..48
    expect(recommendedParamCeiling(64, 'extreme')).toBe(32) // 48+
  })

  it('balanced steps 2 -> 4 -> 8 -> 14 -> 32 across the tiers', () => {
    expect(recommendedParamCeiling(4, 'balanced')).toBe(2) // < 8
    expect(recommendedParamCeiling(16, 'balanced')).toBe(4) // 8..24
    expect(recommendedParamCeiling(24, 'balanced')).toBe(8) // 24..32
    expect(recommendedParamCeiling(32, 'balanced')).toBe(14) // 32..48
    expect(recommendedParamCeiling(64, 'balanced')).toBe(32) // 48+
  })
})

describe('totalBytes null-coalescing defaults', () => {
  it('treats a model with no files array as 0 bytes', () => {
    expect(totalBytes({ kind: 'text' } as SizingModel)).toBe(0)
  })

  it('treats a file with no sizeBytes as 0', () => {
    expect(totalBytes({ kind: 'text', files: [{}, { sizeBytes: 100 }] })).toBe(100)
  })
})

describe('preferredModelIds under 24GB (curated picks)', () => {
  it('conservative on a small Mac prefers the light 2B vision model first', () => {
    const ids = preferredModelIds(16, 'conservative')
    expect(ids[0]).toContain('Qwen3-VL-2B')
  })

  it('balanced on a small Mac prefers Gemma 4 E4B first', () => {
    expect(preferredModelIds(16, 'balanced')[0]).toContain('gemma-4-E4B')
  })

  it('extreme on a small Mac also prefers Gemma 4 E4B (not conservative branch)', () => {
    expect(preferredModelIds(16, 'extreme')[0]).toContain('gemma-4-E4B')
  })

  it('returns no curated ids at 24GB+ (defers to the size heuristic)', () => {
    expect(preferredModelIds(32, 'balanced')).toEqual([])
  })
})

describe('chooseChatModel fallback ladder + field defaults', () => {
  const frac = modeBudget('balanced').frac

  it('applies the params default (999) so a model with no params is excluded by a tiny ceiling', () => {
    // No params field -> defaults to 999, which exceeds maxParams=8, so ineligible.
    // With no other eligible model, the final "smallest text" fallback still returns it.
    const noParams: SizingModel = { id: 'x', kind: 'text', files: [{ sizeBytes: 1e9 }] }
    const picked = chooseChatModel([noParams], 16, 8, frac)
    expect(picked?.id).toBe('x') // reached via the smallest-text fallback
  })

  it('respects minRamGb: a model needing more RAM than we have is not comfy', () => {
    const needsMore: SizingModel = {
      id: 'big',
      kind: 'text',
      params: 4,
      minRamGb: 64,
      files: [{ sizeBytes: 1e9 }]
    }
    const fits: SizingModel = {
      id: 'ok',
      kind: 'text',
      params: 4,
      minRamGb: 8,
      files: [{ sizeBytes: 2e9 }]
    }
    const picked = chooseChatModel([needsMore, fits], 16, 8, frac)
    expect(picked?.id).toBe('ok')
  })

  it('falls back to the smallest ELIGIBLE model when none fit the comfort budget', () => {
    // Both eligible by params/ram but far too big for the byte budget -> comfy empty,
    // so it takes the smallest eligible by bytes.
    const huge: SizingModel = { id: 'huge', kind: 'text', params: 4, files: [{ sizeBytes: 500e9 }] }
    const large: SizingModel = {
      id: 'large',
      kind: 'text',
      params: 4,
      files: [{ sizeBytes: 300e9 }]
    }
    const picked = chooseChatModel([huge, large], 16, 8, frac)
    expect(picked?.id).toBe('large')
  })

  it('falls back to the smallest TEXT model when no text/vision is param-eligible', () => {
    // maxParams=1 makes both ineligible; the smallest-text fallback ignores params.
    const t1: SizingModel = { id: 't1', kind: 'text', params: 8, files: [{ sizeBytes: 9e9 }] }
    const t2: SizingModel = { id: 't2', kind: 'text', params: 8, files: [{ sizeBytes: 4e9 }] }
    const picked = chooseChatModel([t1, t2], 16, 1, frac)
    expect(picked?.id).toBe('t2')
  })

  it('prefers a vision model over a larger text model when both fit comfortably', () => {
    const text: SizingModel = { id: 'txt', kind: 'text', params: 4, files: [{ sizeBytes: 2e9 }] }
    const vision: SizingModel = {
      id: 'vis',
      kind: 'vision',
      params: 2,
      files: [{ sizeBytes: 1e9 }]
    }
    const picked = chooseChatModel([text, vision], 32, 8, frac)
    expect(picked?.id).toBe('vis')
  })

  it('among two equally-vision models that both fit, prefers the larger params (tie-break)', () => {
    // Same kind (both vision) -> the vision term is a tie, so the params comparator
    // decides: the bigger 4B wins over the 2B.
    const small: SizingModel = { id: 'v2', kind: 'vision', params: 2, files: [{ sizeBytes: 1e9 }] }
    const big: SizingModel = { id: 'v4', kind: 'vision', params: 4, files: [{ sizeBytes: 2e9 }] }
    const picked = chooseChatModel([small, big], 64, 8, frac)
    expect(picked?.id).toBe('v4')
  })

  it('returns null when nothing (not even a text model) is available', () => {
    const image: SizingModel = { id: 'img', kind: 'image', params: 2, files: [{ sizeBytes: 1e9 }] }
    expect(chooseChatModel([image], 16, 8, frac)).toBeNull()
  })
})
