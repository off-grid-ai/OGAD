import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OffGridApplication } from '@offgrid/application'
import {
  pickTranscription,
  resolveTranscription,
  transcriptionEngineForRoute,
  withConfiguredTranscriptionLanguage
} from '../select'
import type { TranscriptionService } from '../types'

const service = (available: boolean, text: string): TranscriptionService => ({
  isAvailable: () => available,
  transcribe: async () => ({ text })
})

let application: OffGridApplication
let releaseApplication: (() => void) | undefined

beforeAll(async () => {
  const [applicationModule, modelServices, applicationAccess] = await Promise.all([
    import('@offgrid/application'),
    import('../../model-services'),
    import('../../composition/application-access')
  ])
  application = applicationModule.createOffGridApplication({
    models: modelServices.desktopModelWorkspacePorts
  })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
})

afterAll(async () => {
  releaseApplication?.()
  await application?.stop()
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

  it('keeps canonical and provider-backed route identity on the selected native engine', () => {
    expect(
      transcriptionEngineForRoute({
        id: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
      })
    ).toBe('parakeet')
    expect(transcriptionEngineForRoute({ id: 'bundled-parakeet', providerId: 'parakeet' })).toBe(
      'parakeet'
    )
    expect(transcriptionEngineForRoute({ id: 'ggerganov/whisper.cpp/base' })).toBe('whisper')
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
