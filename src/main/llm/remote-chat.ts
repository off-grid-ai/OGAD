import { REASONING_BUDGET_AUTO, openRouterReasoningPayload } from '@offgrid/models'
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
  responseFormat?: unknown
  tools?: unknown[]
  toolChoice?: string
}

export interface RemoteChatOptions {
  signal?: AbortSignal
  timeoutMs: number
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
    ...(remote.provider === 'openrouter'
      ? openRouterReasoningPayload(
          request.thinking === true,
          request.reasoningBudget ?? REASONING_BUDGET_AUTO
        )
      : {}),
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
