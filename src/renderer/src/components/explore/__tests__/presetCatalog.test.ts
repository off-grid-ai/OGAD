import { describe, expect, it } from 'vitest'
import {
  PRESET_SECTIONS,
  ALL_PRESETS,
  HEADLINE_PRESETS
} from '../presetCatalog'

describe('the Explore preset catalog', () => {
  it('gives every section at least one preset', () => {
    for (const section of PRESET_SECTIONS) {
      expect(section.presets.length).toBeGreaterThan(0)
    }
  })

  it('keeps every preset id unique (they key the run + the chips)', () => {
    const ids = ALL_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ALL_PRESETS is exactly the sections flattened', () => {
    expect(ALL_PRESETS).toHaveLength(
      PRESET_SECTIONS.reduce((count, section) => count + section.presets.length, 0)
    )
  })

  it('leads with only robust presets in the headline set', () => {
    expect(HEADLINE_PRESETS.length).toBeGreaterThan(0)
    for (const preset of HEADLINE_PRESETS) {
      expect(preset.readiness).toBe('robust')
    }
    // A robust preset needs no gate - it must run in any build without setup.
    for (const preset of HEADLINE_PRESETS) {
      expect(preset.requires).toBeUndefined()
    }
  })

  it('gates every non-robust preset so the surface can annotate it', () => {
    // needs-data / needs-setup presets that depend on capture, pairing, or pro must say so,
    // so the UI never offers a run that silently dead-ends.
    for (const preset of ALL_PRESETS) {
      if (preset.readiness === 'needs-data') {
        expect(preset.requires).toBeDefined()
      }
    }
  })

  it('covers the four capabilities we mean to show off', () => {
    const capabilities = PRESET_SECTIONS.map((section) => section.capability)
    expect(new Set(capabilities)).toEqual(
      new Set(['browser', 'computer-use', 'memory', 'phone'])
    )
  })

  it('keeps the flight hero present with a non-empty starter prompt', () => {
    const flight = ALL_PRESETS.find((preset) => preset.id === 'find-flight')
    expect(flight?.prompt.trim().length).toBeGreaterThan(0)
  })
})
