/**
 * Regression tests for the "explicit KV-cache choice silently reverts to f16" bug.
 *
 * Root cause: a performance-mode preset (MODE_PRESETS[mode], where balanced/extreme =
 * { kvCacheType: 'f16', flashAttn: false }) UNCONDITIONALLY overwrote the user's
 * kvCacheType/flashAttn/ctxSize and persisted the clobber. Two writers (the mode
 * preset + the granular KV control) owned the same keys with no merge; the preset
 * always won. The SetupPanel re-sends `{ performanceMode }` whenever a mode is
 * (re)picked, so an explicit q8_0 died the moment a mode was reapplied.
 *
 * The fix is a pure MERGE (applyModePreset): the preset fills ONLY the fields the user
 * has not explicitly pinned. These tests lock: an explicit q8_0 survives a preset;
 * unpinned fields still take the preset; and a persisted pin survives a plain restart.
 */

import { describe, it, expect } from 'vitest'
import {
  applyTextRuntimeModePreset as applyModePreset,
  TEXT_RUNTIME_MODE_PRESETS as MODE_PRESETS,
  type TextRuntimePresetState as PresetState,
  type PresetField
} from '@offgrid/models'

const NONE = new Set<PresetField>()

describe('applyModePreset — the explicit-KV-reverts bug', () => {
  it('THE BUG: an explicitly-pinned q8_0 is PRESERVED when balanced is applied (not reset to f16)', () => {
    // User set kvCacheType='q8_0' granularly (pinned), then picks/reapplies balanced.
    const current: PresetState = { ctxSize: 16384, kvCacheType: 'q8_0', flashAttn: true }
    const merged = applyModePreset(
      current,
      'balanced',
      new Set<PresetField>(['kvCacheType', 'flashAttn'])
    )
    expect(merged.kvCacheType).toBe('q8_0') // NOT reverted to the balanced preset's f16
    expect(merged.flashAttn).toBe(true)
  })

  it('extreme mode also preserves a pinned q8_0 (both non-conservative presets are f16)', () => {
    const current: PresetState = { ctxSize: 65536, kvCacheType: 'q8_0', flashAttn: true }
    const merged = applyModePreset(
      current,
      'extreme',
      new Set<PresetField>(['kvCacheType', 'flashAttn'])
    )
    expect(merged.kvCacheType).toBe('q8_0')
  })

  it('applies the preset to fields the user has NOT pinned (ctxSize follows balanced)', () => {
    // Only kvCacheType is pinned — ctxSize + flashAttn take the balanced preset.
    const current: PresetState = { ctxSize: 8192, kvCacheType: 'q8_0', flashAttn: true }
    const merged = applyModePreset(current, 'balanced', new Set<PresetField>(['kvCacheType']))
    expect(merged.ctxSize).toBe(MODE_PRESETS.balanced.ctxSize) // 16384, unpinned → preset
    expect(merged.flashAttn).toBe(MODE_PRESETS.balanced.flashAttn) // false, unpinned → preset
    expect(merged.kvCacheType).toBe('q8_0') // pinned → kept
  })

  it('with NOTHING pinned, a preset fully applies (behavior-neutral for the non-conflicting case)', () => {
    const current: PresetState = { ctxSize: 999, kvCacheType: 'q4_0', flashAttn: false }
    const merged = applyModePreset(current, 'balanced', NONE)
    expect(merged).toEqual(MODE_PRESETS.balanced)
  })

  it('conservative applied with nothing pinned yields the conservative preset (q8_0)', () => {
    const merged = applyModePreset(
      { ctxSize: 16384, kvCacheType: 'f16', flashAttn: false },
      'conservative',
      NONE
    )
    expect(merged).toEqual(MODE_PRESETS.conservative)
  })

  it('a pinned ctxSize survives while KV follows the preset (independent per-field merge)', () => {
    const current: PresetState = { ctxSize: 40000, kvCacheType: 'f16', flashAttn: false }
    const merged = applyModePreset(current, 'conservative', new Set<PresetField>(['ctxSize']))
    expect(merged.ctxSize).toBe(40000) // pinned → kept
    expect(merged.kvCacheType).toBe(MODE_PRESETS.conservative.kvCacheType) // unpinned → q8_0
    expect(merged.flashAttn).toBe(MODE_PRESETS.conservative.flashAttn)
  })

  it('does not mutate the input state (pure merge returns a fresh object)', () => {
    const current: PresetState = { ctxSize: 16384, kvCacheType: 'q8_0', flashAttn: true }
    const before = { ...current }
    applyModePreset(current, 'balanced', new Set<PresetField>(['kvCacheType']))
    expect(current).toEqual(before)
  })
})

describe('boot/restart path — a persisted pin survives a plain restart', () => {
  // Simulates the constructor: read persisted settings (values + userExplicit pin-set)
  // off disk, then a subsequent mode re-pick (the SetupPanel resend). This is the
  // "every restart" path — before the fix, the bare { performanceMode } patch let the
  // preset reclobber the persisted q8_0.
  it('a persisted explicit q8_0 + pin survives a restart followed by a balanced re-pick', () => {
    // What was on disk from a prior session where the user pinned q8_0:
    const persisted = {
      ctxSize: 8192,
      kvCacheType: 'q8_0' as const,
      flashAttn: true,
      userExplicit: ['kvCacheType', 'flashAttn'] as PresetField[]
    }
    // Constructor restores state + pin-set from disk:
    const state: PresetState = {
      ctxSize: persisted.ctxSize,
      kvCacheType: persisted.kvCacheType,
      flashAttn: persisted.flashAttn
    }
    const pinned = new Set<PresetField>(persisted.userExplicit)
    // SetupPanel resends the saved mode on load → applyModePreset runs with the pins:
    const merged = applyModePreset(state, 'balanced', pinned)
    expect(merged.kvCacheType).toBe('q8_0') // the pin persisted the choice across restart
  })

  it('without a pin, a restart + mode re-pick correctly takes the preset default', () => {
    // A user who never pinned KV: the mode preset is the source of truth, as intended.
    const state: PresetState = { ctxSize: 16384, kvCacheType: 'f16', flashAttn: false }
    const merged = applyModePreset(state, 'conservative', new Set<PresetField>())
    expect(merged.kvCacheType).toBe('q8_0') // conservative preset applies (nothing pinned)
  })
})
