import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  hindiTranscriptNeedsQualityRetry,
  strongerMultilingualWhisperModel,
  transcribeWithHindiQualityRetry
} from '../whisper-cli'

describe('Whisper Hindi quality fallback', () => {
  it('retries a Hindi result that does not contain Devanagari', () => {
    expect(hindiTranscriptNeedsQualityRetry('Thalo, How are you?', 'hi')).toBe(true)
    expect(hindiTranscriptNeedsQualityRetry('چھلو آپ کیسے ہیں', 'hi')).toBe(true)
  })

  it('keeps a Hindi result that contains Devanagari', () => {
    expect(hindiTranscriptNeedsQualityRetry('चलो, आप कैसे हैं?', 'hi')).toBe(false)
  })

  it('does not impose the Hindi script rule on other languages', () => {
    expect(hindiTranscriptNeedsQualityRetry('', 'hi')).toBe(false)
    expect(hindiTranscriptNeedsQualityRetry('How are you?', 'en')).toBe(false)
    expect(hindiTranscriptNeedsQualityRetry('كيف حالك؟', 'ar')).toBe(false)
  })

  it('selects only a stronger multilingual model for the retry', () => {
    const models = '/models'
    expect(
      strongerMultilingualWhisperModel(
        path.join(models, 'ggml-base.bin'),
        ['ggml-small.en.bin', 'ggml-tiny.bin', 'ggml-medium.bin', 'ggml-large-v3-turbo.bin'],
        models
      )
    ).toBe(path.join(models, 'ggml-large-v3-turbo.bin'))
    expect(
      strongerMultilingualWhisperModel(
        path.join(models, 'ggml-large-v3-turbo.bin'),
        ['ggml-base.bin', 'ggml-small.en.bin'],
        models
      )
    ).toBeNull()
  })

  it('runs the active model first and returns the stronger model result after a script miss', async () => {
    const models = '/models'
    const calls: string[] = []
    const text = await transcribeWithHindiQualityRetry({
      language: 'hi',
      model: path.join(models, 'ggml-base.bin'),
      modelFiles: ['ggml-base.bin', 'ggml-small.en.bin', 'ggml-large-v3-turbo.bin'],
      modelDir: models,
      run: async (model) => {
        calls.push(model)
        return model.endsWith('ggml-base.bin') ? 'Thalo, How are you?' : 'चलो, आप कैसे हैं?'
      }
    })

    expect(calls).toEqual([
      path.join(models, 'ggml-base.bin'),
      path.join(models, 'ggml-large-v3-turbo.bin')
    ])
    expect(text).toBe('चलो, आप कैसे हैं?')
  })

  it('does not retry when the active result already uses Devanagari', async () => {
    const calls: string[] = []
    const text = await transcribeWithHindiQualityRetry({
      language: 'hi',
      model: '/models/ggml-base.bin',
      modelFiles: ['ggml-base.bin', 'ggml-large-v3-turbo.bin'],
      modelDir: '/models',
      run: async (model) => {
        calls.push(model)
        return 'नमस्ते'
      }
    })

    expect(calls).toEqual(['/models/ggml-base.bin'])
    expect(text).toBe('नमस्ते')
  })

  it('keeps the first result when no stronger multilingual model is installed', async () => {
    const text = await transcribeWithHindiQualityRetry({
      language: 'hi',
      model: '/models/ggml-base.bin',
      modelFiles: ['ggml-base.bin', 'ggml-small.en.bin'],
      modelDir: '/models',
      run: async () => 'Thalo, How are you?'
    })

    expect(text).toBe('Thalo, How are you?')
  })
})
