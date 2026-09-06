/**
 * Regression tests for the shared text-runtime policy — the two production incidents this
 * session fixed:
 *   1. A hardcoded 64K context overcommitted unified memory and FROZE macOS.
 *   2. "Configure for me" picked the LARGEST fitting model (8B at 64K froze a 16GB Mac).
 * These lock the clamp + the comfortable-fit pick so they can't regress.
 */

import { describe, it, expect } from 'vitest'
import {
  safeTextContext as computeSafeCtx,
  chooseTextModel as chooseChatModel,
  fitLevel,
  textRuntimeModeBudget as modeBudget,
  kvCacheGbPerThousandTokens as kvPerKTokGb,
  modelFileBytes as totalBytes,
  recommendedTextModelParamCeiling as recommendedParamCeiling,
  preferredTextModelIds as preferredModelIds,
  fitTier,
  isLoadableOnDevice,
  checkOverrideSurvival,
  textContextFallbackLadder as contextLadder,
  textRuntimeLoadAttempts as loadAttempts,
  capContextToTrainedWindow as capContextToModel,
  OVERRIDE_SURVIVAL_FLOOR_GB,
  type SizingModel
} from '@offgrid/models'

const GB = 1e9
// A 16GB Mac reports ~17.18 GB from os.totalmem()/1e9.
const MAC_16 = 17.18

describe('capContextToModel — the trained-window ceiling', () => {
  it('caps a request above the model trained max down to it (the ">16k breaks" fix)', () => {
    expect(capContextToModel(65536, 32768)).toBe(32768)
  })
  it('leaves a request at or below the trained max untouched', () => {
    expect(capContextToModel(16384, 131072)).toBe(16384)
    expect(capContextToModel(131072, 131072)).toBe(131072)
  })
  it('does not cap when the trained max is unknown (null) — RAM clamp still applies elsewhere', () => {
    expect(capContextToModel(65536, null)).toBe(65536)
  })
  it('ignores a non-positive trained max', () => {
    expect(capContextToModel(8192, 0)).toBe(8192)
  })
})

describe('computeSafeCtx — the freeze fix', () => {
  it('clamps the 8B-on-16GB case to the value we shipped (21504, not 64K)', () => {
    // Qwen3-VL-8B (~6.2GB weights) at balanced f16 — the exact case that froze the Mac.
    const ctx = computeSafeCtx({
      requested: 65536,
      totalGb: MAC_16,
      weightsGb: 6.2,
      kvType: 'f16',
      frac: 0.65,
      reserveGb: 1.5
    })
    expect(ctx).toBe(21504)
    expect(ctx).toBeLessThan(65536)
  })

  it('never exceeds the requested context', () => {
    const ctx = computeSafeCtx({
      requested: 8192,
      totalGb: 64,
      weightsGb: 5,
      kvType: 'f16',
      frac: 0.65,
      reserveGb: 1.5
    })
    expect(ctx).toBeLessThanOrEqual(8192)
  })

  it('never drops below the 2048 floor even on a tiny/over-subscribed machine', () => {
    const ctx = computeSafeCtx({
      requested: 65536,
      totalGb: 8,
      weightsGb: 7.5,
      kvType: 'f16',
      frac: 0.45,
      reserveGb: 2.0
    })
    expect(ctx).toBeGreaterThanOrEqual(2048)
  })

  it('always returns a 1k-aligned value', () => {
    const ctx = computeSafeCtx({
      requested: 65536,
      totalGb: MAC_16,
      weightsGb: 6.2,
      kvType: 'f16',
      frac: 0.65,
      reserveGb: 1.5
    })
    expect(ctx % 1024).toBe(0)
  })

  it('allows a LARGER context when the KV cache is quantized', () => {
    const base = {
      requested: 65536,
      totalGb: MAC_16,
      weightsGb: 6.2,
      frac: 0.65,
      reserveGb: 1.5
    } as const
    const f16 = computeSafeCtx({ ...base, kvType: 'f16' })
    const q8 = computeSafeCtx({ ...base, kvType: 'q8_0' })
    const q4 = computeSafeCtx({ ...base, kvType: 'q4_0' })
    expect(q8).toBeGreaterThan(f16)
    expect(q4).toBeGreaterThan(q8)
  })

  it('Conservative mode yields a smaller context than Extreme', () => {
    const cons = modeBudget('conservative')
    const ext = modeBudget('extreme')
    const small = computeSafeCtx({
      requested: 65536,
      totalGb: MAC_16,
      weightsGb: 6.2,
      kvType: 'f16',
      ...cons
    })
    const big = computeSafeCtx({
      requested: 65536,
      totalGb: MAC_16,
      weightsGb: 6.2,
      kvType: 'f16',
      ...ext
    })
    expect(small).toBeLessThan(big)
  })

  it('kvPerKTokGb orders f16 > q8_0 > q4_0', () => {
    expect(kvPerKTokGb('f16')).toBeGreaterThan(kvPerKTokGb('q8_0'))
    expect(kvPerKTokGb('q8_0')).toBeGreaterThan(kvPerKTokGb('q4_0'))
  })
})

describe('chooseChatModel — the "don\'t pick the biggest" fix', () => {
  const CATALOG: SizingModel[] = [
    {
      id: 'qwen-2b',
      kind: 'vision',
      params: 2,
      minRamGb: 4,
      files: [{ sizeBytes: 1.1 * GB }, { sizeBytes: 0.8 * GB }]
    },
    {
      id: 'gemma-e4b',
      kind: 'vision',
      params: 4,
      minRamGb: 6,
      files: [{ sizeBytes: 4.98 * GB }, { sizeBytes: 0.99 * GB }]
    }, // ~5.97GB
    {
      id: 'qwen-8b',
      kind: 'vision',
      params: 8,
      minRamGb: 8,
      files: [{ sizeBytes: 5.0 * GB }, { sizeBytes: 1.66 * GB }]
    }, // ~6.66GB
    { id: 'qwen-text-4b', kind: 'text', params: 4, minRamGb: 6, files: [{ sizeBytes: 2.7 * GB }] },
    { id: 'sdxl', kind: 'image', params: 3, minRamGb: 6, files: [{ sizeBytes: 7 * GB }] }
  ]

  it('on a 16GB Mac (balanced) picks Gemma E4B, NOT the 8B that froze it', () => {
    const pick = chooseChatModel(CATALOG, 16, 30, 0.38) // budget 6.08GB → 8B (6.66) excluded
    expect(pick?.id).toBe('gemma-e4b')
  })

  it('Conservative mode (tighter budget) drops to a smaller model', () => {
    const pick = chooseChatModel(CATALOG, 16, 30, 0.3) // budget 4.8GB → only the 2B fits comfortably
    expect(pick?.id).toBe('qwen-2b')
  })

  it('Extreme mode (looser budget) allows the 8B', () => {
    const pick = chooseChatModel(CATALOG, 16, 30, 0.55) // budget 8.8GB → 8B fits, vision + largest wins
    expect(pick?.id).toBe('qwen-8b')
  })

  it('never returns an image model as the chat LLM', () => {
    const pick = chooseChatModel(CATALOG, 64, 30, 0.55)
    expect(pick?.kind).not.toBe('image')
  })

  it('falls back to the smallest text/vision model when nothing fits comfortably', () => {
    const tiny = chooseChatModel(CATALOG, 4, 30, 0.1) // 0.4GB budget — nothing comfy
    expect(tiny).not.toBeNull()
    expect(['text', 'vision']).toContain(tiny?.kind)
  })

  it('returns null when the catalog has no text/vision models', () => {
    expect(
      chooseChatModel([{ id: 'x', kind: 'image', files: [{ sizeBytes: GB }] }], 16, 30, 0.5)
    ).toBeNull()
  })
})

describe('recommendedParamCeiling — 16GB must default to a 4B', () => {
  it('a 16GB Mac (reports 16 OR ~17 from totalmem) caps at 4B in balanced', () => {
    expect(recommendedParamCeiling(16, 'balanced')).toBe(4)
    expect(recommendedParamCeiling(17, 'balanced')).toBe(4) // os.totalmem()/1e9 ≈ 17.18 → round 17
  })
  it('an 8B never gets recommended below 24GB — even in Extreme', () => {
    expect(recommendedParamCeiling(16, 'conservative')).toBe(2)
    expect(recommendedParamCeiling(16, 'extreme')).toBe(4) // 16GB Extreme stays 4B, NOT 8B
    expect(recommendedParamCeiling(24, 'balanced')).toBe(8) // 8B starts at 24GB
  })
  it('scales with RAM tiers', () => {
    expect(recommendedParamCeiling(8, 'balanced')).toBe(4) // 8GB class → 4B (weight budget still gates it down on 8GB)
    expect(recommendedParamCeiling(6, 'balanced')).toBe(2) // <8GB
    expect(recommendedParamCeiling(24, 'balanced')).toBe(8)
    expect(recommendedParamCeiling(32, 'balanced')).toBe(14)
    expect(recommendedParamCeiling(64, 'balanced')).toBe(32)
  })

  it('Configure: a 16GB Mac in balanced prefers Gemma 4 E4B (not the light 2B)', () => {
    // The curated picks are tried before the size heuristic, so balanced must list
    // E4B first (2B is only the fallback when the weight budget is too tight).
    expect(preferredModelIds(16, 'balanced')[0]).toBe('unsloth/gemma-4-E4B-it-GGUF')
    expect(preferredModelIds(16, 'extreme')[0]).toBe('unsloth/gemma-4-E4B-it-GGUF')
    expect(preferredModelIds(16, 'conservative')[0]).toBe('unsloth/Qwen3-VL-2B-Instruct-GGUF')
  })

  it('with the ceiling applied, a 16/17GB Mac picks the 4B even when the 8B fits by bytes', () => {
    // 8B weights (6.19GB) DO fit the 17GB balanced disk budget (6.46GB) — only the
    // param ceiling keeps us on the 4B. This is the exact regression we just fixed.
    const catalog: SizingModel[] = [
      {
        id: 'gemma-e4b',
        kind: 'vision',
        params: 4,
        minRamGb: 6,
        files: [{ sizeBytes: 5.97 * GB }]
      },
      { id: 'qwen-8b', kind: 'vision', params: 8, minRamGb: 8, files: [{ sizeBytes: 6.19 * GB }] }
    ]
    const cap = recommendedParamCeiling(17, 'balanced') // 4
    const pick = chooseChatModel(catalog, 17, cap, 0.38)
    expect(pick?.id).toBe('gemma-e4b')
  })
})

describe('fitLevel — RAM-fit badge thresholds', () => {
  it('ok / tight / risky split at 38% and 55% of RAM', () => {
    expect(fitLevel(5, 16)).toBe('ok') // 31%
    expect(fitLevel(6.5, 16)).toBe('tight') // 41%
    expect(fitLevel(10, 16)).toBe('risky') // 63%
  })

  it('is the SAME function the shared source exports (one rule, main + renderer)', async () => {
    // Main and renderer import the same shared function. Guard the single source
    // so a platform copy cannot creep back in with drifted thresholds.
    const shared = await import('@offgrid/models')
    expect(fitLevel).toBe(shared.fitLevel)
    // Thresholds sit exactly on the shared constants, not re-hardcoded numbers.
    expect(fitLevel(16 * shared.FIT_OK_FRAC, 16)).toBe('ok')
    expect(fitLevel(16 * shared.FIT_OK_FRAC + 0.01, 16)).toBe('tight')
    expect(fitLevel(16 * shared.FIT_TIGHT_FRAC + 0.01, 16)).toBe('risky')
  })

  it('totalBytes sums all files (primary + mmproj)', () => {
    expect(
      totalBytes({ kind: 'vision', files: [{ sizeBytes: 2 * GB }, { sizeBytes: 1 * GB }] })
    ).toBe(3 * GB)
  })
})

describe('never-block loading — fitTier / isLoadableOnDevice', () => {
  // On 16GB: soft = 16*0.65 = 10.4, ceil = 16*0.82 = 13.12. easy < 6.24.
  it('buckets weights into easy / fits / tight / wontFit against soft+ceil', () => {
    expect(fitTier(5, 16)).toBe('easy') // 5 < 6.24
    expect(fitTier(8, 16)).toBe('fits') // 6.24 ≤ 8 < 10.4
    expect(fitTier(12, 16)).toBe('tight') // 10.4 ≤ 12 < 13.12
    expect(fitTier(14, 16)).toBe('wontFit') // ≥ 13.12
  })

  it('keeps a model loadable right up to the aggressive ceiling (never hidden early)', () => {
    // A 12GB model on a 16GB Mac is past the balanced comfort budget (10.4) but
    // still loadable via the extreme ceiling + Load anyway — must NOT be hidden.
    expect(isLoadableOnDevice(12, 16)).toBe(true)
    expect(fitTier(12, 16)).toBe('tight')
    // Only a model past the extreme ceiling is truly unloadable.
    expect(isLoadableOnDevice(14, 16)).toBe(false)
  })

  it('the ceiling is the ONLY block — tight still loads, wontFit does not', () => {
    const ram = 24 // soft 15.6, ceil 19.68
    expect(isLoadableOnDevice(18, ram)).toBe(true) // tight but loadable
    expect(isLoadableOnDevice(20, ram)).toBe(false) // past ceil
  })
})

describe('never-block loading — override survival floor (the one true refusal)', () => {
  it('passes an override that still leaves the survival floor free', () => {
    const r = checkOverrideSurvival({ availGb: 6, incomingWeightsGb: 4 })
    expect(r.fits).toBe(true) // 2GB free after ≥ 1GB floor
    expect(r.freeAfterGb).toBeCloseTo(2)
  })

  it('refuses only when the load would drop below the survival floor', () => {
    // 4.5GB free, load 4GB → 0.5GB left < 1GB floor → refuse even with override.
    expect(checkOverrideSurvival({ availGb: 4.5, incomingWeightsGb: 4 }).fits).toBe(false)
    expect(OVERRIDE_SURVIVAL_FLOOR_GB).toBe(1.0)
  })
})

describe('never-block loading — context fallback ladder', () => {
  it('descends by halving from the requested size down to the 2048 floor, 1k-aligned', () => {
    const ladder = contextLadder(32768)
    expect(ladder[0]).toBe(32768)
    expect(ladder[ladder.length - 1]).toBe(2048)
    // strictly descending
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]!).toBeLessThan(ladder[i - 1]!)
    }
    // every rung is 1k-aligned
    for (const c of ladder) {
      expect(c % 1024).toBe(0)
    }
  })

  it('a requested size already at the floor yields just [2048]', () => {
    expect(contextLadder(2048)).toEqual([2048])
    expect(contextLadder(1000)).toEqual([2048]) // clamps up to the floor
  })
})

describe('never-block loading — loadAttempts (GPU → smaller ctx → CPU)', () => {
  it('starts on GPU at the requested ctx, halves ctx, then ends CPU-only at 2048', () => {
    const attempts = loadAttempts(16384, 99)
    expect(attempts[0]).toEqual({ ctxSize: 16384, gpuLayers: 99, reason: 'requested' })
    // GPU rungs descend by halving
    const gpuRungs = attempts.filter((a) => a.gpuLayers === 99)
    for (let i = 1; i < gpuRungs.length; i++) {
      expect(gpuRungs[i]!.ctxSize).toBeLessThan(gpuRungs[i - 1]!.ctxSize)
    }
    // the final attempt is the CPU-only floor
    const last = attempts[attempts.length - 1]!
    expect(last).toEqual({ ctxSize: 2048, gpuLayers: 0, reason: 'CPU-only, context 2048' })
  })

  it('omits the extra CPU pass when GPU offload is already off (no duplicate 2048)', () => {
    const attempts = loadAttempts(4096, 0)
    expect(attempts.every((a) => a.gpuLayers === 0)).toBe(true)
    // only one attempt sits at ctx 2048 (the ladder floor), not a duplicated CPU pass
    expect(attempts.filter((a) => a.ctxSize === 2048)).toHaveLength(1)
  })
})
