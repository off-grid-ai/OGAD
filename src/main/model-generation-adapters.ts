import {
  cleanTranscription,
  classifyGenerationAdapterError,
  finalGenerationChunk,
  openAIProjectedMessages,
  openAIProjectedGenerationOptions,
  projectedTextGenerationChunk,
  reasoningWireForGeneration
} from '@offgrid/models'
import type {
  GenerationAdapter,
  GenerationChunk,
  GenerationRequest,
  OpenAIProjectedMessage,
  RuntimeModel
} from '@offgrid/models'
import { llm, type StreamChatOptions } from './llm'
import type { StreamResult } from './llm/stream'
import type { GenerationMetrics } from '../shared/generation-metrics'
import { getRemoteVisionServer } from './vision/remote-vision-server'
import { reportDesktopImageProgress, reportDesktopVoiceProgress } from './generation-progress'
export { registerDesktopImageProgress, registerDesktopVoiceProgress } from './generation-progress'

class GenerationChunkChannel {
  private readonly values: GenerationChunk[] = []
  private readonly waiters: Array<() => void> = []
  private ended = false
  private failure: unknown

  push(chunk: GenerationChunk): void {
    if (this.ended) return
    this.values.push(chunk)
    this.wake()
  }

  finish(): void {
    this.ended = true
    this.wake()
  }

  fail(error: unknown): void {
    this.failure = error
    this.ended = true
    this.wake()
  }

  async *stream(): AsyncIterable<GenerationChunk> {
    for (;;) {
      while (this.values.length) yield this.values.shift()!
      if (this.ended) {
        if (this.failure) throw this.failure
        return
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve()
  }
}

abstract class DesktopGenerationAdapter implements GenerationAdapter {
  abstract readonly id: string

  constructor(private readonly observations: DesktopGenerationObservations) {}

  async *generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const channel = new GenerationChunkChannel()
    void this.run(
      model,
      openAIProjectedMessages(request.messages ?? []),
      (text, kind) => channel.push(projectedTextGenerationChunk(text, kind)),
      openAIProjectedGenerationOptions(request) as StreamChatOptions,
      request.timeoutMs
    ).then(
      (result) => {
        this.observations.record(request.identity?.turnId, result.metrics)
        channel.push(finalGenerationChunk(result, request))
        channel.finish()
      },
      (error: unknown) => channel.fail(error)
    )
    yield* channel.stream()
  }

  classifyError(error: unknown): 'retryable' | 'unsupported' | 'fatal' {
    return classifyGenerationAdapterError(error, {
      unsupportedPatterns: ['does not support', 'unsupported'],
      otherwise: 'retryable'
    })
  }

  protected abstract run(
    model: RuntimeModel,
    messages: OpenAIProjectedMessage[],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    options: StreamChatOptions,
    timeoutMs: number | undefined
  ): Promise<StreamResult>
}

export class DesktopGenerationObservations {
  private readonly metricsByTurn = new Map<string, GenerationMetrics>()

  record(turnId: string | undefined, metrics: GenerationMetrics | undefined): void {
    if (turnId && metrics) this.metricsByTurn.set(turnId, metrics)
  }

  takeMetrics(turnId: string): GenerationMetrics | undefined {
    const metrics = this.metricsByTurn.get(turnId)
    this.metricsByTurn.delete(turnId)
    return metrics
  }
}

export class DesktopLocalGenerationAdapter extends DesktopGenerationAdapter {
  constructor(
    observations: DesktopGenerationObservations,
    readonly id = 'desktop.llama',
    private readonly lifecycle: {
      load(): Promise<void>
      unload(): Promise<void>
    } = {
      load: () => llm.init(),
      unload: async () => {
        await llm.unload()
      }
    }
  ) {
    super(observations)
  }

  load(): Promise<void> {
    return this.lifecycle.load()
  }

  async unload(): Promise<void> {
    await this.lifecycle.unload()
  }

  protected run(
    model: RuntimeModel,
    messages: OpenAIProjectedMessage[],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    options: StreamChatOptions,
    timeoutMs: number | undefined
  ): Promise<StreamResult> {
    return llm.streamChatLocal(
      messages,
      onDelta,
      {
        ...options,
        reasoningWire: reasoningWireForGeneration(
          { reasoning: options.reasoning },
          {
            reasoning: llm.getReasoningMetadata() ?? model.reasoning
          }
        )
      },
      timeoutMs
    )
  }
}

export class DesktopRemoteGenerationAdapter extends DesktopGenerationAdapter {
  constructor(
    observations: DesktopGenerationObservations,
    readonly id = 'desktop.remote-chat'
  ) {
    super(observations)
  }

  protected run(
    model: RuntimeModel,
    messages: OpenAIProjectedMessage[],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    options: StreamChatOptions,
    timeoutMs: number | undefined
  ): Promise<StreamResult> {
    if (!model.serverId) throw new Error('The remote model route has no server identity.')
    const remote = getRemoteVisionServer(model.serverId)
    if (!remote || remote.model !== model.id) {
      throw new Error('The selected remote model route is no longer available.')
    }
    return llm.streamChatRemote(
      remote,
      messages,
      onDelta,
      {
        ...options,
        reasoningWire: reasoningWireForGeneration({ reasoning: options.reasoning }, model)
      },
      timeoutMs
    )
  }
}

/** Native non-chat engines stay behind the same provider-neutral generation port.
 * Dynamic imports keep the composition root free of cycles: the public Desktop
 * facades call GenerationService, while these adapters call the raw engine only. */
abstract class DesktopTypedGenerationAdapter implements GenerationAdapter {
  abstract readonly id: string

  classifyError(error: unknown): 'retryable' | 'unsupported' | 'fatal' {
    return classifyGenerationAdapterError(error, {
      unsupportedPatterns: ['not installed', 'not available'],
      otherwise: 'fatal'
    })
  }

  abstract generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk>
}

export class DesktopImageGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.image'

  async load(): Promise<void> {
    const { imageRuntime } = await import('./imagegen')
    await imageRuntime.warm()
  }

  async unload(): Promise<void> {
    const { imageRuntime } = await import('./imagegen')
    await imageRuntime.evict()
  }

  async *generate(
    _model: RuntimeModel,
    request: GenerationRequest
  ): AsyncIterable<GenerationChunk> {
    if (request.operation?.type !== 'image')
      throw new Error('The image adapter needs an image operation.')
    const operation = request.operation
    if (!operation.executionPlan) {
      throw new Error('Shared did not provide an image execution plan.')
    }
    const { generateImageNative } = await import('./imagegen')
    const channel = new GenerationChunkChannel()
    void generateImageNative(
      operation.executionPlan,
      (update) => {
        reportDesktopImageProgress(request.identity?.turnId ?? '', update)
        const progress = 'progress' in update ? update.progress : undefined
        const enhancedPrompt = 'enhancedPrompt' in update ? update.enhancedPrompt : undefined
        if (progress || enhancedPrompt !== undefined) {
          channel.push({
            progress: {
              completed: progress?.step ?? 0,
              total: progress?.total ?? 1,
              stage: update.stage,
              enhancedPrompt,
              ...(progress?.preview
                ? { preview: { mimeType: 'image/png', uri: progress.preview } }
                : {})
            }
          })
        }
      },
      request.signal
    ).then(
      (output) => {
        channel.push({
          output: {
            type: 'image',
            images: [
              {
                mimeType: 'image/png',
                id: output.model,
                uri: output.path,
                data: output.dataUrl.split(',', 2)[1],
                width: operation.width,
                height: operation.height,
                seed: output.seed
              }
            ]
          },
          finishReason: 'stop'
        })
        channel.finish()
      },
      (error: unknown) => channel.fail(error)
    )
    yield* channel.stream()
  }
}

export class DesktopVoiceGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.tts'

  async load(): Promise<void> {
    const { ttsRuntime } = await import('./tts')
    await ttsRuntime.warm()
  }

  async unload(): Promise<void> {
    const { ttsRuntime } = await import('./tts')
    await ttsRuntime.evict()
  }

  async *generate(
    _model: RuntimeModel,
    request: GenerationRequest
  ): AsyncIterable<GenerationChunk> {
    if (request.operation?.type !== 'voice')
      throw new Error('The voice adapter needs a voice operation.')
    const { synthesizeNative } = await import('./tts')
    const output = await synthesizeNative(request.operation.text, request.operation.voice, {
      onProgress: (progress) =>
        reportDesktopVoiceProgress(request.identity?.turnId ?? '', progress),
      signal: request.signal
    })
    yield {
      output: {
        type: 'voice',
        text: request.operation.text,
        language: request.operation.language,
        audio: { mimeType: 'audio/wav', data: output.dataUrl.split(',', 2)[1] }
      },
      finishReason: 'stop'
    }
  }
}

export class DesktopTranscriptionGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.transcription'

  async load(): Promise<void> {
    const { sttRuntime } = await import('./transcription/select')
    await sttRuntime.warm()
  }

  async unload(): Promise<void> {
    const { sttRuntime } = await import('./transcription/select')
    await sttRuntime.evict()
  }

  async *generate(
    _model: RuntimeModel,
    request: GenerationRequest
  ): AsyncIterable<GenerationChunk> {
    if (request.operation?.type !== 'transcription') {
      throw new Error('The transcription adapter needs a transcription operation.')
    }
    if (request.operation.audio.type !== 'audio' || !request.operation.audio.uri) {
      throw new Error('Desktop transcription needs an audio file URI.')
    }
    const { getNativeTranscriptionForRoute } = await import('./transcription/select')
    const transcript = await getNativeTranscriptionForRoute(_model).transcribe(
      { path: request.operation.audio.uri },
      {
        signal: request.signal,
        model: request.operation.modelId,
        language: request.operation.language,
        suppressNonSpeech: request.operation.suppressNonSpeech,
        alreadyWav16k: request.operation.alreadyWav16k,
        prompt: request.operation.prompt,
        timestamps: request.operation.timestamps
      }
    )
    const segments = transcript.segments
      ?.map((segment) => ({ ...segment, text: cleanTranscription(segment.text) }))
      .filter((segment) => segment.text.length > 0)
    yield {
      output: {
        type: 'transcription',
        text: cleanTranscription(transcript.text),
        language: transcript.language,
        segments
      },
      finishReason: 'stop'
    }
  }
}

export class DesktopRemoteImageGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.remote-image'

  async *generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const { remoteMediaRuntime } = await import('./remote-media-runtime')
    const image = await remoteMediaRuntime.image(model, request)
    yield {
      output: {
        type: 'image',
        images: [
          {
            id: model.id,
            mimeType: 'image/png',
            ...(image.base64 ? { data: image.base64 } : {}),
            ...(image.url ? { uri: image.url } : {})
          }
        ]
      },
      finishReason: 'stop'
    }
  }
}

export class DesktopRemoteVoiceGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.remote-voice'

  async *generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const { remoteMediaRuntime } = await import('./remote-media-runtime')
    const voice = await remoteMediaRuntime.voice(model, request)
    yield {
      output: {
        type: 'voice',
        text: request.operation?.type === 'voice' ? request.operation.text : undefined,
        language: request.operation?.type === 'voice' ? request.operation.language : undefined,
        audio: { mimeType: voice.mimeType, data: voice.data }
      },
      finishReason: 'stop'
    }
  }
}

export class DesktopRemoteTranscriptionGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.remote-transcription'

  async *generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const { remoteMediaRuntime } = await import('./remote-media-runtime')
    const transcript = await remoteMediaRuntime.transcription(model, request)
    yield {
      output: {
        type: 'transcription',
        text: cleanTranscription(transcript.text),
        language: transcript.language,
        segments: transcript.segments?.map((segment) => ({
          ...segment,
          text: cleanTranscription(segment.text)
        }))
      },
      finishReason: 'stop'
    }
  }
}

export class DesktopRemoteEmbeddingGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.remote-embedding'

  async *generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const { remoteMediaRuntime } = await import('./remote-media-runtime')
    const vectors = await remoteMediaRuntime.embedding(model, request)
    yield { output: { type: 'embedding', vectors }, finishReason: 'stop' }
  }
}

export class DesktopEmbeddingGenerationAdapter extends DesktopTypedGenerationAdapter {
  readonly id = 'desktop.embedding'

  async load(): Promise<void> {
    const { embeddings } = await import('./embeddings')
    await embeddings.initNative()
  }

  async unload(): Promise<void> {
    const { embeddings } = await import('./embeddings')
    await embeddings.unloadNative()
  }

  async *generate(
    _model: RuntimeModel,
    request: GenerationRequest
  ): AsyncIterable<GenerationChunk> {
    if (request.operation?.type !== 'embedding') {
      throw new Error('The embedding adapter needs an embedding operation.')
    }
    const { embeddings } = await import('./embeddings')
    const vectors: number[][] = []
    for (const input of request.operation.inputs) {
      request.signal?.throwIfAborted()
      vectors.push(await embeddings.generateEmbeddingNative(input))
    }
    yield { output: { type: 'embedding', vectors }, finishReason: 'stop' }
  }
}
