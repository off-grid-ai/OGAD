import {
  REASONING_BUDGET_AUTO,
  openRouterReasoningPayload,
  reasoningMetadataForOllama,
  reasoningMetadataFromChatTemplate,
  reasoningMetadataFromOpenRouter,
  type ModelReasoningMetadata,
  type OpenRouterPublishedReasoning,
  type ReasoningEffort,
  type ReasoningWireFragment
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
  timeoutMs: number
}

export interface RemoteNativeToolCapability {
  status: 'supported' | 'unsupported' | 'unknown'
  modelName: string
}

interface OpenRouterModelMetadata {
  id?: unknown
  name?: unknown
  supported_parameters?: unknown
  reasoning?: OpenRouterPublishedReasoning
}

const nativeToolCapabilities = new Map<string, Promise<RemoteNativeToolCapability>>()
const reasoningCapabilities = new Map<string, Promise<ModelReasoningMetadata>>()

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
    const body = (await response.json()) as { capabilities?: unknown; template?: unknown }
    if (!Array.isArray(body.capabilities) || !body.capabilities.includes('thinking')) {
      return reasoningMetadataForOllama('no-control')
    }
    const template = typeof body.template === 'string' ? body.template : ''
    const supportsEffort =
      /(?:low|medium|high).{0,160}(?:\.Think|think)/is.test(template) ||
      /(?:\.Think|think).{0,160}(?:low|medium|high)/is.test(template)
    return supportsEffort
      ? reasoningMetadataForOllama('effort', {
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
          mandatory: true
        })
      : reasoningMetadataForOllama('boolean')
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

const REASONING_TRANSPORTS = new Set([
  'llama-server',
  'llama-rn',
  'openrouter',
  'ollama',
  'openai-compatible'
])
const REASONING_CONTROLS = new Set([
  'enable-thinking',
  'reasoning-strength',
  'boolean',
  'effort',
  'provider-native',
  'no-control',
  'unsupported'
])

function publishedReasoningMetadata(value: unknown): ModelReasoningMetadata | undefined {
  if (!value || typeof value !== 'object') return undefined
  const metadata = value as Record<string, unknown>
  if (
    typeof metadata.transport !== 'string' ||
    !REASONING_TRANSPORTS.has(metadata.transport) ||
    typeof metadata.control !== 'string' ||
    !REASONING_CONTROLS.has(metadata.control)
  ) {
    return undefined
  }
  const effort = (candidate: unknown): candidate is ReasoningEffort =>
    candidate === 'minimal' ||
    candidate === 'low' ||
    candidate === 'medium' ||
    candidate === 'high' ||
    candidate === 'xhigh' ||
    candidate === 'max'
  const supportedEfforts = Array.isArray(metadata.supportedEfforts)
    ? metadata.supportedEfforts.filter(effort)
    : undefined
  return {
    transport: metadata.transport as ModelReasoningMetadata['transport'],
    control: metadata.control as ModelReasoningMetadata['control'],
    ...(metadata.supportsTokenBudget === true ? { supportsTokenBudget: true } : {}),
    ...(supportedEfforts ? { supportedEfforts } : {}),
    ...(effort(metadata.defaultEffort) ? { defaultEffort: metadata.defaultEffort } : {}),
    ...(metadata.mandatory === true ? { mandatory: true } : {}),
    ...(metadata.reasoningFormat === 'auto' || metadata.reasoningFormat === 'deepseek'
      ? { reasoningFormat: metadata.reasoningFormat }
      : {})
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
    const published = publishedReasoningMetadata(selected?.reasoning)
    if (published) return published
    const template =
      typeof selected?.chat_template === 'string' ? selected.chat_template : undefined
    return reasoningMetadataFromChatTemplate('openai-compatible', template)
  } catch {
    return { transport: 'openai-compatible', control: 'unsupported' }
  }
}

export function remoteReasoningMetadata(
  remote: RemoteTextModelConnection
): Promise<ModelReasoningMetadata> {
  const key = capabilityKey(remote)
  const cached = reasoningCapabilities.get(key)
  if (cached) return cached
  const discovered =
    remote.provider === 'openrouter'
      ? discoverOpenRouterReasoningMetadata(remote)
      : remote.provider === 'ollama'
        ? discoverOllamaReasoningMetadata(remote)
        : discoverCompatibleReasoningMetadata(remote)
  reasoningCapabilities.set(key, discovered)
  return discovered
}

function capabilityKey(remote: RemoteTextModelConnection): string {
  return `${remote.provider}\n${remote.endpoint}\n${remote.model}`
}

/** OpenRouter is the authority for native request features. A missing metadata response stays
 * unknown so providers with incomplete discovery endpoints keep their existing behavior. */
async function discoverRemoteNativeToolCapability(
  remote: RemoteTextModelConnection
): Promise<RemoteNativeToolCapability> {
  if (remote.provider !== 'openrouter') {
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
    if (!Array.isArray(body.data)) {
      return { status: 'unknown', modelName: remote.name || remote.model }
    }
    const selected = (body.data as OpenRouterModelMetadata[]).find(
      (candidate) => candidate.id === remote.model
    )
    if (!selected || !Array.isArray(selected.supported_parameters)) {
      return { status: 'unknown', modelName: remote.name || remote.model }
    }
    const modelName = typeof selected.name === 'string' ? selected.name : remote.model
    return {
      status: selected.supported_parameters.includes('tools') ? 'supported' : 'unsupported',
      modelName
    }
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
  const cached = nativeToolCapabilities.get(key)
  if (cached) return cached
  const discovered = discoverRemoteNativeToolCapability(remote)
  nativeToolCapabilities.set(key, discovered)
  return discovered
}

export function nativeToolPlannerUnavailableMessage(
  capability: RemoteNativeToolCapability
): string {
  return `${capability.modelName} cannot act as the Chat tool planner because OpenRouter reports that this model does not support native tools. Select it as the Computer Use specialist instead, then select a tool-capable text model for Chat.`
}

interface RemoteErrorBody {
  error?: {
    message?: string
    code?: string | number
    metadata?: { raw?: string; provider_name?: string }
  }
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

/** Preserve the provider's useful, non-secret failure reason. */
export function remoteTextModelProviderError(status: number, rawBody: string): Error {
  let body: RemoteErrorBody = {}
  try {
    body = JSON.parse(rawBody) as RemoteErrorBody
  } catch {
    // Non-JSON provider errors use the bounded response text below.
  }
  const detail =
    body.error?.metadata?.raw?.trim() || body.error?.message?.trim() || rawBody.trim().slice(0, 500)
  const provider = body.error?.metadata?.provider_name?.trim()
  return new Error(
    `Remote text model returned HTTP ${status}${provider ? ` from ${provider}` : ''}${detail ? `: ${detail}` : '.'}`
  )
}

/** The OpenAI-compatible request body. Pure: what we send, with nothing about how we send it. */
function completionRequestBody(
  remote: RemoteTextModelConnection,
  request: RemoteChatRequest
): string {
  return JSON.stringify({
    model: remote.model,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    ...(request.tools?.length
      ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' }
      : {}),
    // Carry the user's configured thinking cap, not just a coarse effort hint. Without this the
    // cap was dropped for every remote model and the budget setting did nothing.
    ...(request.reasoningWire ??
      (remote.provider === 'openrouter'
        ? openRouterReasoningPayload(
            request.thinking === true,
            request.reasoningBudget ?? REASONING_BUDGET_AUTO
          )
        : {})),
    stream: true
  })
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
function createIdleWatchdog(timeoutMs: number, callerSignal?: AbortSignal): IdleWatchdog {
  const controller = new AbortController()
  const firedRef = { current: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer) clearTimeout(timer)
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
  if (error instanceof Error && error.message.startsWith('Remote text model returned HTTP ')) {
    return error
  }
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
