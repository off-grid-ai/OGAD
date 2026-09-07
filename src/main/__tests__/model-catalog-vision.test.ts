import { describe, it, expect } from 'vitest'
import { CATALOG } from '@offgrid/models'

// The chat engine decides "can this model read images" purely from whether the ACTIVE
// model has an mmproj file (llm.ts hasVision → models-manager reads
// entry.files.find(role === 'mmproj')). So a vision model that omits its mmproj in the
// catalog is silently demoted to text-only in the UI ("This model can't read images").
// That's exactly what happened to Gemma 4 E2B — a multimodal model catalogued as
// kind:'text' with no projector. These guards tie the capability to the data.

const entries = CATALOG

describe('model catalog — vision capability matches the mmproj data', () => {
  it('Gemma 4 E2B is a vision model with a projector (regression)', () => {
    const e2b = entries.find((m) => m.id === 'unsloth/gemma-4-E2B-it-GGUF')
    expect(e2b, 'E2B must be in the catalog').toBeTruthy()
    expect(e2b!.kind).toBe('vision')
    expect(e2b!.files.some((f) => f.role === 'mmproj')).toBe(true)
  })

  it('every image-reading model ships an mmproj, and text-only models do not', () => {
    // Computer Use models also read screenshots. The capability invariant is therefore
    // vision-or-computer_use ⇔ a projector, while text-only families must not carry one.
    for (const m of entries) {
      const hasMmproj = m.files.some((f) => f.role === 'mmproj')
      if (m.kind === 'vision' || m.kind === 'computer_use') {
        expect(hasMmproj, `${m.id} is ${m.kind} but has no mmproj`).toBe(true)
      } else {
        expect(hasMmproj, `${m.id} is ${m.kind} but carries an mmproj`).toBe(false)
      }
    }
  })

  it('every catalog-delivered model has exactly one primary weight file', () => {
    for (const m of entries) {
      const primaryCount = m.files.filter((f) => f.role === 'primary').length
      if (m.artifactDelivery === 'runtime') {
        expect(primaryCount, `${m.id} is native-runtime managed`).toBe(0)
      } else {
        expect(primaryCount, `${m.id}`).toBe(1)
      }
    }
  })
})
