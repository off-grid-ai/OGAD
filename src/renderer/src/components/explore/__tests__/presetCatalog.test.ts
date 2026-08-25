import { describe, expect, it } from 'vitest'
import { PRESET_SECTIONS, ALL_PRESETS, HEADLINE_PRESETS } from '../presetCatalog'

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

  it('covers the five capabilities we mean to show off', () => {
    const capabilities = PRESET_SECTIONS.map((section) => section.capability)
    expect(new Set(capabilities)).toEqual(
      new Set(['browser', 'computer-use', 'creation', 'memory', 'phone'])
    )
  })

  it('every preset carries its own icon, defined once in the catalog', () => {
    // The icon is the one presentation field the SSOT holds, so both placements (Explore
    // screen, chat empty state) show the same mark without a per-surface lookup to drift.
    for (const preset of ALL_PRESETS) {
      expect(preset.icon, `preset ${preset.id} has no icon`).toBeTypeOf('object')
    }
  })

  it('titles are capability labels, never the raw prompt', () => {
    // The surface renders title + blurb only; the prompt stays behind the tap. A title that
    // IS the prompt (or reads first-person like one) would leak it back onto the card.
    for (const preset of ALL_PRESETS) {
      expect(preset.title).not.toBe(preset.prompt)
      expect(preset.title).not.toMatch(/\b(me|my|I)\b/)
    }
  })

  it('keeps the flight hero present with a non-empty starter prompt', () => {
    const flight = ALL_PRESETS.find((preset) => preset.id === 'find-flight')
    expect(flight?.prompt.trim().length).toBeGreaterThan(0)
  })

  it('starts the proposal workflow through its installed skill', () => {
    const proposal = ALL_PRESETS.find((preset) => preset.id === 'proposal-deck')
    expect(proposal?.prompt).toMatch(/^\/proposal-deck\b/)
  })
})
