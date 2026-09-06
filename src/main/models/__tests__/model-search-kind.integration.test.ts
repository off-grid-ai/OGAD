import { describe, expect, it } from 'vitest'
import type { ModelModality } from '@offgrid/models'
import { modelSearchKind } from '../model-search-kind'

describe('Desktop model search kind boundary', () => {
  it('passes every Shared model modality from an untyped host request', () => {
    const modalities: ModelModality[] = [
      'text',
      'vision',
      'computer_use',
      'image',
      'voice',
      'transcription',
      'embedding',
      'classifier',
      'tool_selection'
    ]

    expect(modalities.map((modality) => modelSearchKind(modality))).toEqual(modalities)
  })

  it.each([undefined, null, '', 'audio', 42, { kind: 'text' }])(
    'rejects an unsupported host value: %j',
    (value) => {
      expect(modelSearchKind(value)).toBeUndefined()
    }
  )
})
