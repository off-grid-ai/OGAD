import type {
  GenerationAdapter,
  GenerationChunk,
  GenerationContentPart,
  GenerationFinishReason,
  GenerationMessage,
  GenerationRequest,
  GenerationResponseFormat,
  GenerationToolChoice,
  RuntimeModel
} from '@offgrid/models'
import { llm, type StreamChatOptions } from './llm'
import type { StreamResult } from './llm/stream'
import type { GenerationMetrics } from '../shared/generation-metrics'
import { getRemoteVisionServer } from './vision/remote-vision-server'

interface OpenAIMessage {
  role: GenerationMessage['role']
  content: string | Array<Record<string, unknown>>
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

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

function openAIContentPart(part: GenerationContentPart): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text }
  if (part.type === 'image') {
    const url = part.data
      ? `data:${part.mimeType ?? 'image/png'};base64,${part.data}`
      : (part.uri ?? '')
    return { type: 'image_url', image_url: { url, detail: part.detail } }
  }
  if (part.type === 'audio') {
    return {
      type: 'input_audio',
      input_audio: {
        data: part.data ?? part.uri ?? '',
        format: part.mimeType?.split('/').pop() ?? 'wav'
      }
    }
  }
  return {
    type: 'file',
    file: {
      filename: part.name,
      file_data: part.data ?? part.uri ?? '',
      mime_type: part.mimeType
    }
  }
}

function openAIMessages(messages: GenerationMessage[]): OpenAIMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: Array.isArray(message.content)
      ? message.content.map(openAIContentPart)
      : message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments }
          }))
        }
      : {})
  }))
}

function openAIResponseFormat(
  value: GenerationResponseFormat | undefined
): Record<string, unknown> | undefined {
  if (!value || value.type === 'text') return undefined
  if (value.type === 'json_object') return value
  return {
    type: 'json_schema',
    json_schema: {
      name: value.name,
      schema: value.schema,
      ...(value.strict === undefined ? {} : { strict: value.strict })
    }
  }
}

function openAIToolChoice(value: GenerationToolChoice | undefined): unknown {
  if (!value || typeof value === 'string') return value
  return { type: 'function', function: { name: value.name } }
}

function streamOptions(request: GenerationRequest): StreamChatOptions {
  return {
    temperature: request.sampling?.temperature,
    topP: request.sampling?.topP,
    thinking: request.requiredCapabilities?.thinking,
    signal: request.signal,
    maxTokens: request.maxTokens,
    responseFormat: openAIResponseFormat(request.responseFormat),
    tools: request.tools?.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    })),
    toolChoice: openAIToolChoice(request.toolChoice)
  }
}

function finishReason(value: string | null): GenerationFinishReason {
  if (value === 'stop' || value === 'length' || value === 'content_filter') return value
  if (value === 'tool_calls' || value === 'function_call') return 'tool_calls'
  return value ? 'unknown' : 'stop'
}

function finalChunk(result: StreamResult, request: GenerationRequest): GenerationChunk {
  const promptTokens = result.metrics?.promptTokens
  const outputTokens = result.metrics?.completionTokens
  return {
    ...(result.toolCalls.length && request.operation?.type !== 'tool_selection'
      ? {
          toolCallDeltas: result.toolCalls.map((call, index) => ({
            index,
            id: call.id,
            name: call.name,
            argumentsDelta: call.arguments
          }))
        }
      : {}),
    ...(request.operation?.type === 'tool_selection'
      ? {
          output: {
            type: 'tool_selection' as const,
            toolCalls: result.toolCalls
          }
        }
      : {}),
    ...(promptTokens || outputTokens
      ? {
          usage: {
            ...(promptTokens ? { inputTokens: promptTokens } : {}),
            ...(outputTokens ? { outputTokens } : {}),
            totalTokens: (promptTokens ?? 0) + (outputTokens ?? 0)
          }
        }
      : {}),
    finishReason: finishReason(result.finishReason)
  }
}

abstract class DesktopGenerationAdapter implements GenerationAdapter {
  abstract readonly id: string

  constructor(private readonly observations: DesktopGenerationObservations) {}

  async *generate(model: RuntimeModel, request: GenerationRequest): AsyncIterable<GenerationChunk> {
    const channel = new GenerationChunkChannel()
    void this.run(
      model,
      openAIMessages(request.messages ?? []),
      (text, kind) => channel.push(kind === 'reasoning' ? { reasoning: text } : { content: text }),
      streamOptions(request),
      request.timeoutMs ?? 300_000
    ).then(
      (result) => {
        this.observations.record(request.identity?.turnId, result.metrics)
        channel.push(finalChunk(result, request))
        channel.finish()
      },
      (error: unknown) => channel.fail(error)
    )
    yield* channel.stream()
  }

  classifyError(error: unknown): 'retryable' | 'unsupported' | 'fatal' {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
    if (message.includes('does not support') || message.includes('unsupported'))
      return 'unsupported'
    return 'retryable'
  }

  protected abstract run(
    model: RuntimeModel,
    messages: OpenAIMessage[],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    options: StreamChatOptions,
    timeoutMs: number
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
    readonly id = 'desktop.llama'
  ) {
    super(observations)
  }

  load(): Promise<void> {
    return llm.init()
  }

  async unload(): Promise<void> {
    await llm.unload()
  }

  protected run(
    _model: RuntimeModel,
    messages: OpenAIMessage[],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    options: StreamChatOptions,
    timeoutMs: number
  ): Promise<StreamResult> {
    return llm.streamChatLocal(messages, onDelta, options, timeoutMs)
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
    messages: OpenAIMessage[],
    onDelta: (text: string, kind: 'content' | 'reasoning') => void,
    options: StreamChatOptions,
    timeoutMs: number
  ): Promise<StreamResult> {
    if (!model.serverId) throw new Error('The remote model route has no server identity.')
    const remote = getRemoteVisionServer(model.serverId)
    if (!remote || remote.model !== model.id) {
      throw new Error('The selected remote model route is no longer available.')
    }
    return llm.streamChatRemote(remote, messages, onDelta, options, timeoutMs)
  }
}
