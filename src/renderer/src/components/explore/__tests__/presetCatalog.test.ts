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

  it('keeps the visible runs in the creation and browser capabilities', () => {
    const capabilities = PRESET_SECTIONS.map((section) => section.capability)
    expect(new Set(capabilities)).toEqual(new Set(['creation', 'browser']))
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
      if (preset.id !== 'train-my-feed') expect(preset.title).not.toMatch(/\b(me|my|I)\b/)
    }
  })

  it('shows comic creation, nearby places, price comparison, and Train My Feed', () => {
    expect(ALL_PRESETS.map((preset) => preset.id)).toEqual([
      'comic-book',
      'best-nearby',
      'price-compare',
      'train-my-feed'
    ])
  })

  it('does not expose the removed proposal deck workflow', () => {
    expect(ALL_PRESETS.some((preset) => preset.id === 'proposal-deck')).toBe(false)
  })
})
