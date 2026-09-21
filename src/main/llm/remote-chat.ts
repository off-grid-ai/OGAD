import { REASONING_BUDGET_AUTO, openRouterReasoningPayload } from '@offgrid/models'
import type { RemoteVisionProvider } from '../../shared/remote-vision-server'
import { detectThinkingDialect, type ThinkingDialect } from './thinking-dialect'
import {
  createCompletionStreamAccumulator,
  type CompletionStreamAccumulator,
  type StreamResult
} from './stream'
import { writeDiagnosticLog } from '../diagnostics-log'

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
  topK?: number
  minP?: number
  presencePenalty?: number
  repeatPenalty?: number
  thinking?: boolean
  /** The user's thinking cap in tokens (REASONING_BUDGET_AUTO for unrestricted). */
  reasoningBudget?: number
  responseFormat?: unknown
  tools?: unknown[]
  toolChoice?: string
}

export interface RemoteChatOptions {
  signal?: AbortSignal
  timeoutMs?: number
  onToolCallStart?: (name?: string) => void
}

export interface RemoteNativeToolCapability {
  status: 'supported' | 'unsupported' | 'unknown'
  modelName: string
}

interface OpenRouterModelMetadata {
  id?: unknown
  name?: unknown
  supported_parameters?: unknown
  reasoning?: { mandatory?: boolean }
}

const nativeToolCapabilities = new Map<string, Promise<RemoteNativeToolCapability>>()
type RemoteReasoningControl = ThinkingDialect | 'openrouter' | 'ollama'
export interface RemoteReasoningCapability {
  control: RemoteReasoningControl
  mandatory?: boolean
  tokenBudget?: boolean
}
const reasoningCapabilities = new Map<string, Promise<RemoteReasoningCapability>>()

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

/** Read the server's model/template facts, never its display name. Failed probes are retried. */
export async function remoteReasoningCapability(
  remote: RemoteTextModelConnection
): Promise<RemoteReasoningCapability> {
  const key = capabilityKey(remote)
  const cached = reasoningCapabilities.get(key)
  if (cached) return cached
  const discovered = (async (): Promise<RemoteReasoningCapability> => {
    if (remote.provider === 'openrouter') {
      const response = await fetch(`${remote.endpoint}/models`, {
        headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000)
      })
      if (!response.ok) throw new Error('reasoning metadata unavailable')
      const body = (await response.json()) as { data?: OpenRouterModelMetadata[] }
      const model = body.data?.find((candidate) => candidate.id === remote.model)
      return {
        control: model?.reasoning ? 'openrouter' : 'none',
        mandatory: model?.reasoning?.mandatory === true
      }
    }
    if (remote.provider === 'ollama') {
      const response = await fetch(`${remote.endpoint.replace(/\/v1\/?$/i, '')}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: remote.model }),
        signal: AbortSignal.timeout(5_000)
      })
      if (!response.ok) throw new Error('reasoning metadata unavailable')
      const body = (await response.json()) as { capabilities?: unknown; template?: unknown }
      const template = typeof body.template === 'string' ? body.template : ''
      const supportsThinking =
        (Array.isArray(body.capabilities) && body.capabilities.includes('thinking')) ||
        /\.Think|\.Thinking|\.IsThinkSet/.test(template)
      return { control: supportsThinking ? 'ollama' : 'none' }
    }
    const response = await fetch(`${remote.endpoint.replace(/\/v1\/?$/i, '')}/props`, {
      signal: AbortSignal.timeout(5_000)
    })
    if (response.ok) {
      const body = (await response.json()) as { chat_template?: string }
      return { control: detectThinkingDialect(body.chat_template), tokenBudget: true }
    }
    // LM Studio accepts this per-request switch even though its model list has no template.
    return { control: remote.provider === 'lmstudio' ? 'enable-thinking' : 'none' }
  })().catch(() => {
    reasoningCapabilities.delete(key)
    return { control: remote.provider === 'openrouter' ? 'openrouter' : 'none' } as const
  })
  reasoningCapabilities.set(key, discovered)
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
  request: RemoteChatRequest,
  capability: RemoteReasoningCapability
): string {
  const thinking = request.thinking
  const budget = request.reasoningBudget ?? REASONING_BUDGET_AUTO
  const ollamaEffort =
    budget > 0 ? (budget <= 1024 ? 'low' : budget <= 4096 ? 'medium' : 'high') : 'medium'
  const reasoning =
    thinking === undefined || capability.control === 'none'
      ? {}
      : capability.control === 'openrouter'
        ? thinking
          ? openRouterReasoningPayload(true, budget)
          : capability.mandatory
            ? {}
            : { reasoning: { effort: 'none' } }
        : capability.control === 'ollama'
          ? { reasoning_effort: thinking ? ollamaEffort : 'none' }
          : capability.control === 'reasoning-strength'
            ? { chat_template_kwargs: { reasoning_strength: thinking ? 'high' : 'none' } }
            : {
                chat_template_kwargs: { enable_thinking: thinking },
                ...(thinking && capability.tokenBudget && budget > 0
                  ? { reasoning_budget_tokens: budget }
                  : {})
              }
  return JSON.stringify({
    model: remote.model,
    messages: request.messages,
    max_tokens: request.maxTokens,
    temperature: request.temperature,
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.topK === undefined ? {} : { top_k: request.topK }),
    ...(request.minP === undefined ? {} : { min_p: request.minP }),
    ...(request.presencePenalty === undefined ? {} : { presence_penalty: request.presencePenalty }),
    ...(request.repeatPenalty === undefined
      ? {}
      : { repeat_penalty: request.repeatPenalty, repetition_penalty: request.repeatPenalty }),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    ...(request.tools?.length
      ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' }
      : {}),
    ...reasoning,
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
function createIdleWatchdog(
  timeoutMs: number | undefined,
  callerSignal?: AbortSignal
): IdleWatchdog {
  const controller = new AbortController()
  const firedRef = { current: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    if (timer) clearTimeout(timer)
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
  const accumulator = createCompletionStreamAccumulator(input.onDelta, options.onToolCallStart)
  if (options.signal?.aborted) return accumulator.finish()

  if (request.tools?.length) {
    const capability = await remoteNativeToolCapability(remote)
    if (capability.status === 'unsupported') {
      throw new Error(nativeToolPlannerUnavailableMessage(capability))
    }
  }

  const watchdog = createIdleWatchdog(options.timeoutMs, options.signal)
  try {
    writeDiagnosticLog('remote_chat', 'request.started', {
      provider: remote.provider,
      model: remote.model
    })
    const reasoning =
      request.thinking === undefined
        ? { control: 'none' as const }
        : await remoteReasoningCapability(remote)
    const response = await fetch(`${remote.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {})
      },
      body: completionRequestBody(remote, request, reasoning),
      signal: watchdog.signal
    })
    watchdog.arm()
    if (!response.ok) {
      const body = (await response.text()).slice(0, 4_096)
      throw remoteTextModelProviderError(response.status, body)
    }
    if (!response.body) throw new Error('Remote text model returned an empty response stream.')
    await drainCompletionStream(response.body, accumulator, watchdog.arm)
    const result = accumulator.finish()
    writeDiagnosticLog('remote_chat', 'request.completed', {
      provider: remote.provider,
      model: remote.model
    })
    return result
  } catch (error) {
    // A cancelled request keeps whatever streamed — the caller asked to stop, not to discard.
    if (options.signal?.aborted) return accumulator.finish()
    const classified = classifyStreamFailure(error, {
      cancelled: false,
      timedOut: watchdog.firedRef.current
    })
    writeDiagnosticLog(
      'remote_chat',
      'request.failed',
      {
        provider: remote.provider,
        model: remote.model,
        error: classified.message
      },
      'error'
    )
    throw classified
  } finally {
    watchdog.dispose()
  }
}
