import {
  openAICompatibleCompletionPayload,
  RemoteHttpError,
  reasoningMetadataForOllama,
  reasoningMetadataFromChatTemplate,
  reasoningMetadataFromOpenRouter,
  publishedCompatibleReasoningMetadata,
  ollamaReasoningMetadata,
  openRouterNativeToolCapability,
  remoteCapabilityDiscoveryPlan,
  nativeToolPlannerUnavailableMessage,
  RemoteCapabilityCache,
  remoteCapabilityCacheKey,
  type ModelReasoningMetadata,
  type OpenRouterPublishedReasoning,
  type ReasoningWireFragment,
  type RemoteNativeToolCapability
} from '@offgrid/models'
import type { RemoteVisionProvider } from '../../shared/remote-vision-server'
import {
  createCompletionStreamAccumulator,
  type CompletionStreamAccumulator,
  type StreamResult
} from './stream'

export interface RemoteTextModelConnection {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  apiKey: string
}

export interface RemoteChatRequest {
  messages: unknown[]
  maxTokens: number
  temperature: number
  topP?: number
  thinking?: boolean
  /** The user's thinking cap in tokens (REASONING_BUDGET_AUTO for unrestricted). */
  reasoningBudget?: number
  reasoningWire?: ReasoningWireFragment
  responseFormat?: unknown
  tools?: unknown[]
  toolChoice?: unknown
}

export interface RemoteChatOptions {
  signal?: AbortSignal
  /** Idle limit between chunks. Undefined means none. */
  timeoutMs?: number
}

interface OpenRouterModelMetadata {
  id?: unknown
  name?: unknown
  supported_parameters?: unknown
  reasoning?: OpenRouterPublishedReasoning
}

const nativeToolCapabilities = new RemoteCapabilityCache<RemoteNativeToolCapability>()
const reasoningCapabilities = new RemoteCapabilityCache<ModelReasoningMetadata>()

function ollamaApiBase(endpoint: string): string {
  return endpoint.replace(/\/v1\/?$/i, '')
}

async function discoverOllamaReasoningMetadata(
  remote: RemoteTextModelConnection
): Promise<ModelReasoningMetadata> {
  try {
    const response = await fetch(`${ollamaApiBase(remote.endpoint)}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: remote.model }),
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) return reasoningMetadataForOllama('unsupported')
    return ollamaReasoningMetadata(await response.json())
  } catch {
    return reasoningMetadataForOllama('unsupported')
  }
}

async function discoverOpenRouterReasoningMetadata(
  remote: RemoteTextModelConnection
): Promise<ModelReasoningMetadata> {
  try {
    const response = await fetch(`${remote.endpoint}/models`, {
      headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) return reasoningMetadataFromOpenRouter(undefined)
    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) return reasoningMetadataFromOpenRouter(undefined)
    const selected = (body.data as OpenRouterModelMetadata[]).find(
      (candidate) => candidate.id === remote.model
    )
    return reasoningMetadataFromOpenRouter(selected?.reasoning)
  } catch {
    return reasoningMetadataFromOpenRouter(undefined)
  }
}

async function discoverCompatibleReasoningMetadata(
  remote: RemoteTextModelConnection
): Promise<ModelReasoningMetadata> {
  try {
    const response = await fetch(`${remote.endpoint}/models`, {
      headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) throw new Error('metadata unavailable')
    const body = (await response.json()) as { data?: unknown }
    if (!Array.isArray(body.data)) throw new Error('metadata unavailable')
    const selected = (body.data as Array<Record<string, unknown>>).find(
      (candidate) => candidate.id === remote.model
    )
    const published = publishedCompatibleReasoningMetadata(selected?.reasoning)
    if (published) return published
    const template =
      typeof selected?.chat_template === 'string' ? selected.chat_template : undefined
    return reasoningMetadataFromChatTemplate('openai-compatible', template)
  } catch {
    return { transport: 'openai-compatible', control: 'unsupported' }
  }
}

/** The learned reasoning dialect for a server, or undefined until the background probe lands. */
export function peekRemoteReasoningMetadata(
  remote: RemoteTextModelConnection
): ModelReasoningMetadata | undefined {
  return reasoningCapabilities.peek(capabilityKey(remote))
}

export function remoteReasoningMetadata(
  remote: RemoteTextModelConnection
): Promise<ModelReasoningMetadata> {
  const key = capabilityKey(remote)
  return reasoningCapabilities.getOrLoad(key, () => {
    const plan = remoteCapabilityDiscoveryPlan(remote.provider)
    return plan.reasoning === 'openrouter'
      ? discoverOpenRouterReasoningMetadata(remote)
      : plan.reasoning === 'ollama'
        ? discoverOllamaReasoningMetadata(remote)
        : discoverCompatibleReasoningMetadata(remote)
  })
}

function capabilityKey(remote: RemoteTextModelConnection): string {
  return remoteCapabilityCacheKey({
    provider: remote.provider,
    endpoint: remote.endpoint,
    modelId: remote.model
  })
}

/** OpenRouter is the authority for native request features. A missing metadata response stays
 * unknown so providers with incomplete discovery endpoints keep their existing behavior. */
async function discoverRemoteNativeToolCapability(
  remote: RemoteTextModelConnection
): Promise<RemoteNativeToolCapability> {
  if (remoteCapabilityDiscoveryPlan(remote.provider).nativeTools === 'unknown') {
    return { status: 'unknown', modelName: remote.name || remote.model }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetch(`${remote.endpoint}/models`, {
      headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
      signal: controller.signal
    })
    if (!response.ok) return { status: 'unknown', modelName: remote.name || remote.model }
    const body = (await response.json()) as { data?: unknown }
    return openRouterNativeToolCapability(body.data, remote.model, remote.name || remote.model)
  } catch {
    return { status: 'unknown', modelName: remote.name || remote.model }
  } finally {
    clearTimeout(timeout)
  }
}

export function remoteNativeToolCapability(
  remote: RemoteTextModelConnection
): Promise<RemoteNativeToolCapability> {
  const key = capabilityKey(remote)
  return nativeToolCapabilities.getOrLoad(key, () => discoverRemoteNativeToolCapability(remote))
}

/** Keep remote transport errors useful without exposing the endpoint, headers,
 * API key, or request body. */
export function remoteTextModelTransportError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Remote text model request failed.')
  const cause = error.cause
  if (!cause || typeof cause !== 'object') {
    return new Error(`Remote text model request failed: ${error.message}`)
  }
  const detail = cause as { message?: unknown; code?: unknown }
  const message = typeof detail.message === 'string' ? detail.message.trim() : ''
  const code = typeof detail.code === 'string' ? detail.code.trim() : ''
  return new Error(
    `Remote text model connection failed: ${message || error.message || 'network error'}${code ? ` (${code})` : ''}.`
  )
}

/** Preserve the provider's useful, non-secret failure reason (the shared typed failure). */
export function remoteTextModelProviderError(status: number, rawBody: string): Error {
  return new RemoteHttpError(status, rawBody)
}

/** The OpenAI-compatible request body. Pure: what we send, with nothing about how we send it. */
function completionRequestBody(
  remote: RemoteTextModelConnection,
  request: RemoteChatRequest
): string {
  return JSON.stringify(
    openAICompatibleCompletionPayload({
      model: remote.model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      responseFormat: request.responseFormat,
      tools: request.tools,
      toolChoice: request.toolChoice,
      // Carry the user's configured thinking cap, not just a coarse effort hint. Without this the
      // cap was dropped for every remote model and the budget setting did nothing.
      reasoningWire: request.reasoningWire,
      provider: remote.provider,
      thinking: request.thinking,
      reasoningBudget: request.reasoningBudget,
      stream: true
    })
  )
}

interface IdleWatchdog {
  /** Abort signal combining the caller's cancellation with this watchdog's. */
  signal: AbortSignal
  /** Restart the countdown — called whenever the stream shows progress. */
  arm: () => void
  /** True only if THIS watchdog fired, so a timeout is distinguishable from a cancellation. */
  firedRef: { current: boolean }
  dispose: () => void
}

/**
 * Fail a stream that stops producing, rather than one that takes a long time.
 *
 * A long agentic completion is legitimately slow; a dead connection is not, and only silence
 * separates them. Rearming on every chunk measures the gap between chunks instead of total
 * duration.
 *
 * `firedRef` is an object, not a boolean return: the write happens inside the timer callback, which
 * the compiler cannot order against a later read, so a plain flag narrowed to `false` and made the
 * timeout branch look statically dead.
 */
function createIdleWatchdog(
  timeoutMs: number | undefined,
  callerSignal?: AbortSignal
): IdleWatchdog {
  const controller = new AbortController()
  const firedRef = { current: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    // No idle limit unless the caller set one: a generation runs until it finishes or is stopped.
    if (timeoutMs === undefined) return
    timer = setTimeout(() => {
      firedRef.current = true
      controller.abort()
    }, timeoutMs)
  }
  arm()
  return {
    signal: callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal,
    arm,
    firedRef,
    dispose: () => {
      if (timer) clearTimeout(timer)
    }
  }
}

/** Drain the SSE body into the accumulator, rearming the watchdog on each chunk. */
async function drainCompletionStream(
  body: ReadableStream<Uint8Array>,
  accumulator: CompletionStreamAccumulator,
  onProgress: () => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  // for (;;) rather than while (true): the loop ends on the reader, not on a condition, and a
  // literal condition reads as one the type system should be checking.
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    onProgress()
    accumulator.push(decoder.decode(chunk.value, { stream: true }))
  }
  accumulator.push(decoder.decode())
}

/**
 * Which error the caller should see. Order matters: a caller-requested cancellation is not a
 * failure, our own idle timeout is not the provider's fault, and an already-classified HTTP error
 * must not be re-wrapped as a transport fault.
 */
function classifyStreamFailure(
  error: unknown,
  cause: { cancelled: boolean; timedOut: boolean }
): Error {
  if (cause.timedOut) return new Error('Remote text model request timed out.')
  if (error instanceof RemoteHttpError) return error
  return remoteTextModelTransportError(error)
}

/** One OpenAI-compatible remote transport for Chat, agentic tools, planning,
 * Web Use intake, and visual policy calls. It never falls back to a local model.
 *
 * A single input object rather than four positional arguments: the connection, what to send, where
 * deltas go, and how long to wait are four unrelated things, and at four positions a caller can
 * silently swap two of them. */
export async function streamRemoteChatCompletion(input: {
  remote: RemoteTextModelConnection
  request: RemoteChatRequest
  onDelta: (text: string, kind: 'content' | 'reasoning') => void
  options: RemoteChatOptions
}): Promise<StreamResult> {
  const { remote, request, options } = input
  const accumulator = createCompletionStreamAccumulator(input.onDelta)
  if (options.signal?.aborted) return accumulator.finish()

  if (request.tools?.length) {
    const capability = await remoteNativeToolCapability(remote)
    if (capability.status === 'unsupported') {
      throw new Error(nativeToolPlannerUnavailableMessage(capability))
    }
  }

  const watchdog = createIdleWatchdog(options.timeoutMs, options.signal)
  try {
    const response = await fetch(`${remote.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {})
      },
      body: completionRequestBody(remote, request),
      signal: watchdog.signal
    })
    watchdog.arm()
    if (!response.ok) {
      const body = (await response.text()).slice(0, 4_096)
      throw remoteTextModelProviderError(response.status, body)
    }
    if (!response.body) throw new Error('Remote text model returned an empty response stream.')
    await drainCompletionStream(response.body, accumulator, watchdog.arm)
    return accumulator.finish()
  } catch (error) {
    // A cancelled request keeps whatever streamed — the caller asked to stop, not to discard.
    if (options.signal?.aborted) return accumulator.finish()
    throw classifyStreamFailure(error, {
      cancelled: false,
      timedOut: watchdog.firedRef.current
    })
  } finally {
    watchdog.dispose()
  }
}
