// Exhaustive unit tests for the pure setup / "Configure for me" decision logic.
// Real inputs, no mocks. One case per branch: mode normalization, budget fractions
// + boundaries, the baseline extras set + ordering, the download total, and the
// fit-message copy contract (guarded against wording drift).

import { describe, it, expect } from 'vitest'
import {
  normalizeMode,
  recommendBudgetFraction,
  recommendBudgetBytes,
  baselineExtras,
  totalDownloadGb,
  fitMessage,
  STT_MODEL_BY_MODE,
  TTS_MODEL_ID,
  IMAGE_MODEL_ID
} from '../setup-logic'

describe('normalizeMode', () => {
  it('passes through the two non-default modes', () => {
    expect(normalizeMode('conservative')).toBe('conservative')
    expect(normalizeMode('extreme')).toBe('extreme')
  })
  it('defaults balanced for balanced, unknown, empty, null, undefined', () => {
    expect(normalizeMode('balanced')).toBe('balanced')
    expect(normalizeMode('turbo')).toBe('balanced')
    expect(normalizeMode('')).toBe('balanced')
    expect(normalizeMode(null)).toBe('balanced')
    expect(normalizeMode(undefined)).toBe('balanced')
  })
})

describe('recommendBudgetFraction', () => {
  it('is 0.30 conservative, 0.38 balanced, 0.55 extreme', () => {
    expect(recommendBudgetFraction('conservative')).toBe(0.3)
    expect(recommendBudgetFraction('balanced')).toBe(0.38)
    expect(recommendBudgetFraction('extreme')).toBe(0.55)
  })
})

describe('recommendBudgetBytes', () => {
  it('multiplies ram (GB) by the mode fraction times 1e9', () => {
    expect(recommendBudgetBytes(16, 'balanced')).toBeCloseTo(16 * 0.38 * 1e9)
    expect(recommendBudgetBytes(32, 'extreme')).toBeCloseTo(32 * 0.55 * 1e9)
    expect(recommendBudgetBytes(8, 'conservative')).toBeCloseTo(8 * 0.3 * 1e9)
  })
})

describe('baselineExtras — set + ordering per mode', () => {
  it('conservative: STT(tiny) then TTS, with image listed for the user to opt into', () => {
    const out = baselineExtras('conservative')
    expect(out.map((i) => i.kind)).toEqual(['transcription', 'voice', 'image'])
    expect(out[0]!.id).toBe(STT_MODEL_BY_MODE.conservative)
    expect(out[1]!.id).toBe(TTS_MODEL_ID)
  })
  it('balanced: STT(base), TTS, then image', () => {
    const out = baselineExtras('balanced')
    expect(out.map((i) => i.kind)).toEqual(['transcription', 'voice', 'image'])
    expect(out[0]!.id).toBe(STT_MODEL_BY_MODE.balanced)
    expect(out[2]!.id).toBe(IMAGE_MODEL_ID)
  })
  it('extreme: STT(small), TTS, then image', () => {
    const out = baselineExtras('extreme')
    expect(out.map((i) => i.kind)).toEqual(['transcription', 'voice', 'image'])
    expect(out[0]!.id).toBe(STT_MODEL_BY_MODE.extreme)
  })
  it('every extra carries a capability + fallback name', () => {
    for (const i of baselineExtras('balanced')) {
      expect(i.capability.length).toBeGreaterThan(0)
      expect(i.fallbackName.length).toBeGreaterThan(0)
    }
  })
})

describe('STT_MODEL_BY_MODE tiers', () => {
  it('scales tiny -> base -> small', () => {
    expect(STT_MODEL_BY_MODE).toEqual({
      conservative: 'ggerganov/whisper.cpp/tiny',
      balanced: 'ggerganov/whisper.cpp/base',
      extreme: 'ggerganov/whisper.cpp/small'
    })
  })
})

describe('totalDownloadGb', () => {
  it('sums only the not-installed items', () => {
    const items = [
      { sizeGb: 3, installed: false },
      { sizeGb: 0.15, installed: false },
      { sizeGb: 4.35, installed: true }
    ]
    expect(totalDownloadGb(items)).toBeCloseTo(3.15)
  })
  it('is 0 when everything is installed', () => {
    expect(totalDownloadGb([{ sizeGb: 3, installed: true }])).toBe(0)
  })
  it('is 0 for an empty plan', () => {
    expect(totalDownloadGb([])).toBe(0)
  })
})

describe('fitMessage — copy contract', () => {
  it('ok is silent (empty string)', () => {
    expect(fitMessage('ok', 5, 16)).toBe('')
  })
  it('tight explains the context reduction and includes weights + ram', () => {
    const msg = fitMessage('tight', 6.2, 16)
    expect(msg).toContain('~6.2 GB')
    expect(msg).toContain('16 GB')
    expect(msg).toContain('context window will be reduced')
  })
  it('risky warns about slow/swap/fail and includes weights + ram', () => {
    const msg = fitMessage('risky', 11.5, 16)
    expect(msg).toContain('~11.5 GB')
    expect(msg).toContain('16 GB')
    expect(msg).toContain('fail to load')
    expect(msg).toContain('smaller model')
  })
  it('uses hyphen separators, no em dashes, no curly quotes', () => {
    for (const level of ['tight', 'risky'] as const) {
      const msg = fitMessage(level, 6, 16)
      expect(msg).not.toContain('—') // em dash
      expect(msg).not.toContain('‘')
      expect(msg).not.toContain('’')
    }
  })
})
