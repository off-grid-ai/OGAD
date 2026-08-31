import { describe, expect, it } from 'vitest'
import { transcriptionRequestOptions } from '../transcription-request'

describe('transcriptionRequestOptions', () => {
  it('keeps the requested remote model and spoken language', () => {
    expect(
      transcriptionRequestOptions({
        model: 'ggerganov/whisper.cpp/large-v3-turbo',
        language: 'en'
      })
    ).toEqual({
      model: 'ggerganov/whisper.cpp/large-v3-turbo',
      language: 'en'
    })
  })

  it('leaves automatic language detection unset', () => {
    expect(transcriptionRequestOptions({ language: 'auto' })).toEqual({})
  })

  it('rejects an invalid language before native transcription starts', () => {
    expect(() => transcriptionRequestOptions({ language: '../../bad' })).toThrow(
      'Unsupported transcription language'
    )
  })
})
