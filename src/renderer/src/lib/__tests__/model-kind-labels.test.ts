import { describe, it, expect } from 'vitest'
import { MODEL_KIND_LABELS, modelKindLabel } from '../model-kind-labels'

describe('MODEL_KIND_LABELS — the shared model-kind display labels', () => {
  it('carries the superset of both former maps (incl. the `other` bucket)', () => {
    expect(MODEL_KIND_LABELS).toEqual({
      text: 'Text',
      vision: 'Vision',
      computer_use: 'Computer Use',
      image: 'Image',
      voice: 'Voice',
      transcription: 'Transcription',
      other: 'Other'
    })
  })

  it('modelKindLabel returns the label for a known kind', () => {
    expect(modelKindLabel('text')).toBe('Text')
    expect(modelKindLabel('computer_use')).toBe('Computer Use')
    expect(modelKindLabel('transcription')).toBe('Transcription')
    expect(modelKindLabel('other')).toBe('Other')
  })

  it('modelKindLabel falls back to the raw kind for an unknown value', () => {
    expect(modelKindLabel('quantum')).toBe('quantum')
  })
})
