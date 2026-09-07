/**
 * The grounder classification against OGAD's REAL model catalog (not the shared
 * copy - OGAD ships its own @offgrid/models). Guards that the vision-rail
 * grounder is catalogued and flagged, and that the flag is authoritative while
 * the name heuristic covers a user's own Hugging Face pick.
 */
import { describe, expect, it } from 'vitest'
import { CATALOG, isGrounderModel, modelsByKind } from '@offgrid/models'

describe('the grounder catalog', () => {
  it('ships UI-TARS-1.5-7B as a flagged vision grounder', () => {
    const grounder = CATALOG.find((m) => m.id === 'mradermacher/UI-TARS-1.5-7B-GGUF')
    expect(grounder).toBeTruthy()
    expect(grounder?.kind).toBe('computer_use')
    expect(grounder?.availability).toBe('ready')
    expect(grounder?.grounder).toBe(true)
    expect(isGrounderModel(grounder!.id)).toBe(true)
  })

  it('a general catalogued VLM is NOT a grounder (the flag is authoritative)', () => {
    const generalVlm = modelsByKind('vision').find((m) => !m.grounder)
    expect(generalVlm).toBeTruthy()
    expect(isGrounderModel(generalVlm!.id)).toBe(false)
  })

  it("recognizes a user's off-catalog grounder by name, and passes on a general VLM", () => {
    expect(isGrounderModel('someone/Holo1.5-7B-GGUF')).toBe(true)
    expect(isGrounderModel('org/GUI-Owl-1.5-8B-GGUF')).toBe(true)
    expect(isGrounderModel('some/random-Llava-GGUF')).toBe(false)
  })
})
