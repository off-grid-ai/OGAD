import { describe, expect, it, vi } from 'vitest'
import type { GenerationChunk, GenerationRequest, RuntimeModel } from '@offgrid/models'

const native = vi.hoisted(() => ({
  imageWarm: vi.fn(async () => undefined),
  imageEvict: vi.fn(async () => undefined),
  voiceWarm: vi.fn(async () => undefined),
  voiceEvict: vi.fn(async () => undefined),
  transcriptionWarm: vi.fn(async () => undefined),
  transcriptionEvict: vi.fn(async () => undefined),
  embeddingInit: vi.fn(async () => undefined),
  embeddingUnload: vi.fn(async () => undefined)
}))

vi.mock('../imagegen', () => ({
  imageRuntime: { warm: native.imageWarm, evict: native.imageEvict }
}))
vi.mock('../tts', () => ({
  ttsRuntime: { warm: native.voiceWarm, evict: native.voiceEvict }
}))
vi.mock('../transcription/select', () => ({
  sttRuntime: { warm: native.transcriptionWarm, evict: native.transcriptionEvict }
}))
vi.mock('../embeddings', () => ({
  embeddings: { initNative: native.embeddingInit, unloadNative: native.embeddingUnload }
}))

import {
  DesktopEmbeddingGenerationAdapter,
  DesktopImageGenerationAdapter,
  DesktopTranscriptionGenerationAdapter,
  DesktopVoiceGenerationAdapter
} from '../model-generation-adapters'

const model = (modality: RuntimeModel['modality']): RuntimeModel => ({
  id: `${modality}-model`,
  name: `${modality} model`,
  kind: modality === 'voice' ? 'voice' : modality,
  modality,
  source: 'local',
  adapterId: `desktop.${modality}`,
  capabilities: {},
  installed: true,
  ready: true,
  loaded: false
})

async function collect(
  adapter: {
    generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk>
  },
  runtimeModel: RuntimeModel,
  request: GenerationRequest
): Promise<GenerationChunk[]> {
  const chunks: GenerationChunk[] = []
  for await (const chunk of adapter.generate(runtimeModel, request)) chunks.push(chunk)
  return chunks
}

describe('Desktop native generation adapter boundary', () => {
  it('delegates native lifecycle through each modality adapter', async () => {
    const adapters = [
      new DesktopImageGenerationAdapter(),
      new DesktopVoiceGenerationAdapter(),
      new DesktopTranscriptionGenerationAdapter(),
      new DesktopEmbeddingGenerationAdapter()
    ]

    for (const adapter of adapters) {
      await adapter.load()
      await adapter.unload()
    }

    const operations = [
      native.imageWarm,
      native.imageEvict,
      native.voiceWarm,
      native.voiceEvict,
      native.transcriptionWarm,
      native.transcriptionEvict,
      native.embeddingInit,
      native.embeddingUnload
    ]
    expect(operations.every((operation) => operation.mock.calls.length === 1)).toBe(true)
  })

  it('fails closed when a request reaches the wrong native modality', async () => {
    const wrongRequest: GenerationRequest = {
      operation: { type: 'embedding', inputs: ['hello'] },
      allowFallback: false
    }

    await expect(
      collect(new DesktopImageGenerationAdapter(), model('image'), wrongRequest)
    ).rejects.toThrow('image adapter needs an image operation')
    await expect(
      collect(new DesktopVoiceGenerationAdapter(), model('voice'), wrongRequest)
    ).rejects.toThrow('voice adapter needs a voice operation')
    await expect(
      collect(new DesktopTranscriptionGenerationAdapter(), model('transcription'), wrongRequest)
    ).rejects.toThrow('transcription adapter needs a transcription operation')
    await expect(
      collect(new DesktopEmbeddingGenerationAdapter(), model('embedding'), {
        operation: { type: 'voice', text: 'hello' },
        allowFallback: false
      })
    ).rejects.toThrow('embedding adapter needs an embedding operation')
  })

  it('rejects incomplete image plans and transcription inputs before native I/O', async () => {
    await expect(
      collect(new DesktopImageGenerationAdapter(), model('image'), {
        operation: { type: 'image', prompt: 'A private forest' },
        allowFallback: false
      })
    ).rejects.toThrow('Shared did not provide an image execution plan')

    await expect(
      collect(new DesktopTranscriptionGenerationAdapter(), model('transcription'), {
        operation: { type: 'transcription', audio: { type: 'audio', uri: '' } },
        allowFallback: false
      })
    ).rejects.toThrow('Desktop transcription needs an audio file URI')
  })
})
