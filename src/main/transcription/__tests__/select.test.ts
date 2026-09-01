import { describe, expect, it, vi } from 'vitest'
import {
  pickTranscription,
  resolveTranscription,
  withConfiguredTranscriptionLanguage
} from '../select'
import type { TranscriptionService } from '../types'

const service = (available: boolean, text: string): TranscriptionService => ({
  isAvailable: () => available,
  transcribe: async () => ({ text })
})

describe('Desktop transcription adapter selection', () => {
  it('maps an available Parakeet route to its native adapter', () => {
    const selected = pickTranscription('parakeet', {
      whisper: service(true, 'whisper'),
      parakeet: service(true, 'parakeet'),
      whisperResident: service(false, 'resident')
    })
    expect(selected.engine).toBe('parakeet')
    expect(selected.fellBack).toBe(false)
  })

  it('uses the real one-shot Whisper adapter when optional native runtimes are absent', () => {
    expect(resolveTranscription('parakeet').engine).toBe('whisper')
    expect(resolveTranscription('whisper', 'resident').engine).toBe('whisper')
  })

  it('applies the configured language but keeps an explicit caller override', async () => {
    const transcribe = vi.fn(async () => ({ text: 'hello' }))
    const configured = withConfiguredTranscriptionLanguage(
      { isAvailable: () => true, transcribe },
      'fr'
    )
    await configured.transcribe({ path: '/tmp/voice.wav' }, { language: 'en' })
    expect(transcribe).toHaveBeenCalledWith(
      { path: '/tmp/voice.wav' },
      expect.objectContaining({ language: 'en' })
    )
  })
})
