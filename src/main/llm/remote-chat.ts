import { REASONING_BUDGET_AUTO, openRouterReasoningPayload } from '@offgrid/models'
import type { RemoteTextModelConnection } from './remote-chat-types'
import { detectThinkingDialect, type ThinkingDialect } from './thinking-dialect'
import {
  createCompletionStreamAccumulator,
  type CompletionStreamAccumulator,
  type StreamResult
} from './stream'
import type { AssembledToolCall, SseWaitStatus } from './sse-stream'
import { writeDiagnosticLog } from '../diagnostics-log'
import { currentAIRequest } from '../ai-request-log'
import { screenTaskRequestSource } from '../actions/remote-screen-session'

export type { RemoteTextModelConnection } from './remote-chat-types'

export interface RemoteChatRequest {
  messages: unknown[]
  /** Left out when the server's window is unknown, so the server's own limit applies. */
  maxTokens?: number
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
  onToolCallReady?: (call: AssembledToolCall) => void
  /** What the server says the request waits for, as a line to show: its turn, a model loading. */
  onWaitStatus?: (label: string) => void
}

/** "Waiting for RTX Pro 6000 · 2 ahead", "RTX Pro 6000 is loading Flint…". */
export function remoteWaitLabel(serverName: string, status: SseWaitStatus): string {
  if (status.phase === 'loading') return `${serverName} is loading ${status.model || 'the model'}…`
  return status.ahead
    ? `Waiting for ${serverName} · ${status.ahead} ahead`
    : `Waiting for ${serverName}…`
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
  /** llama.cpp reports the template reads the standard `reasoning_effort` (its chat_template_caps). */
  reasoningEffort?: boolean
  /** With thinking on, the rendered prompt already opens the <think> block: the reply starts inside
   *  it and only closes it. llama.cpp splits that out itself only for templates it recognises. */
  thinkingOpensInPrompt?: boolean
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
  if (cached !== undefined) return cached
  const discovered = discoverRemoteNativeToolCapability(remote)
  nativeToolCapabilities.set(key, discovered)
  return discovered
}

/** A model server on this machine reached through the remote seam: the local grounding specialist
 *  (grounder-runtime.ts). It holds memory here, so it is not a remote model. */
export function isLocalModelServer(remote: RemoteTextModelConnection): boolean {
  return remote.id.startsWith('local-grounder:')
}

/** Whether llama.cpp renders a thinking-on prompt that ends inside an open <think> block. Asked of
 *  the server (/apply-template), so it holds for any template that does this, whatever its family. */
async function promptOpensThinking(
  remote: RemoteTextModelConnection,
  reasoningEffort: boolean
): Promise<boolean> {
  try {
    const response = await fetch(`${remote.endpoint.replace(/\/v1\/?$/i, '')}/apply-template`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: remote.model,
        messages: [{ role: 'user', content: 'Hi' }],
        chat_template_kwargs: { enable_thinking: true },
        ...(reasoningEffort ? { reasoning_effort: 'high' } : {})
      }),
      signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) return false
    const { prompt } = (await response.json()) as { prompt?: unknown }
    return typeof prompt === 'string' && /<think[^>]*>\s*$/.test(prompt)
  } catch {
    return false
  }
}

/** Read the server's model/template facts, never its display name. Failed probes are retried. */
export async function remoteReasoningCapability(
  remote: RemoteTextModelConnection
): Promise<RemoteReasoningCapability> {
  const key = capabilityKey(remote)
  const cached = reasoningCapabilities.get(key)
  if (cached !== undefined) return cached
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
    // Ask about this model: a server holding several (a llama.cpp router, an Off Grid gateway
    // keeping models loaded) answers /props per model; a single-model server ignores the query.
    const response = await fetch(
      `${remote.endpoint.replace(/\/v1\/?$/i, '')}/props?model=${encodeURIComponent(remote.model)}`,
      {
        headers: remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000)
      }
    )
    if (response.ok) {
      const body = (await response.json()) as {
        chat_template?: string
        chat_template_caps?: { supports_reasoning_effort?: boolean }
      }
      const reasoningEffort = body.chat_template_caps?.supports_reasoning_effort === true
      return {
        control: detectThinkingDialect(body.chat_template),
        tokenBudget: true,
        reasoningEffort,
        thinkingOpensInPrompt: await promptOpensThinking(remote, reasoningEffort)
      }
    }
    // A server error is not an answer. An Off Grid gateway answers 502 until its model loads;
    // caching that as 'none' dropped the thinking switch for the whole session. Ask again later.
    if (response.status >= 500)
      throw new Error(`reasoning metadata unavailable: ${response.status}`)
    // LM Studio accepts this per-request switch even though its model list has no template.
    return { control: remote.provider === 'lmstudio' ? 'enable-thinking' : 'none' }
  })().catch(() => {
    reasoningCapabilities.delete(key)
    return { control: remote.provider === 'openrouter' ? 'openrouter' : 'none' } as const
  })
  reasoningCapabilities.set(key, discovered)
  return discovered
}

const contextWindows = new Map<string, Promise<number | null>>()
/** A failed window probe answers unknown for this long, so one turn does not wait on it again. */
const CONTEXT_PROBE_RETRY_MS = 20_000

function positiveTokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

/** The context window one request gets on the remote server, or null when it does not say. The
 *  model list answers first (OpenRouter and Off Grid gateways: `context_length`; vLLM:
 *  `max_model_len`); a llama.cpp server answers through /props. Failed probes are asked again. */
export function remoteContextWindow(remote: RemoteTextModelConnection): Promise<number | null> {
  const key = capabilityKey(remote)
  const cached = contextWindows.get(key)
  if (cached !== undefined) return cached
  const headers: Record<string, string> = remote.apiKey
    ? { Authorization: `Bearer ${remote.apiKey}` }
    : {}
  const discovered = (async (): Promise<number | null> => {
    const models = await fetch(`${remote.endpoint.replace(/\/$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(5_000)
    }).catch(() => null)
    if (models?.ok) {
      const body = (await models.json().catch(() => ({}))) as { data?: unknown }
      const entry = Array.isArray(body.data)
        ? (body.data as Record<string, unknown>[]).find((model) => model.id === remote.model)
        : undefined
      const listed = positiveTokens(entry?.context_length) ?? positiveTokens(entry?.max_model_len)
      if (listed) return listed
    }
    if (remote.provider === 'openrouter' || remote.provider === 'ollama') return null
    const props = await fetch(`${remote.endpoint.replace(/\/v1\/?$/i, '')}/props`, {
      headers,
      signal: AbortSignal.timeout(5_000)
    })
    if (props.status >= 500) throw new Error(`context window unavailable: ${props.status}`)
    if (!props.ok) return null
    // llama.cpp reports the window one request may use.
    const body = (await props.json()) as { default_generation_settings?: { n_ctx?: unknown } }
    return positiveTokens(body.default_generation_settings?.n_ctx)
  })().catch(() => {
    setTimeout(() => contextWindows.delete(key), CONTEXT_PROBE_RETRY_MS).unref()
    return null
  })
  contextWindows.set(key, discovered)
  return discovered
}

/** Forget what was learned about a server's models (context window, thinking controls, native
 *  tools), so the next request asks it again. Testing or saving a server means its setup may have
 *  changed, such as a larger context window, and a remembered answer would hide that. */
export function forgetRemoteServerFacts(endpoint: string): void {
  const base = endpoint.replace(/\/+$/, '')
  for (const cache of [contextWindows, reasoningCapabilities, nativeToolCapabilities] as Map<
    string,
    unknown
  >[]) {
    for (const key of [...cache.keys()]) {
      if (key.split('\n')[1]?.replace(/\/+$/, '') === base) cache.delete(key)
    }
  }
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

/** Network codes that mean the server is not answering at all. Their messages carry the
 * endpoint ("connect ECONNREFUSED 127.0.0.1:17878"), so they are said in words instead. */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN'
])

/** The plain reason for an unreachable remote model, or null when the code means something else. */
export function remoteModelUnreachable(code: string): string | null {
  return UNREACHABLE_CODES.has(code)
    ? "The remote model's server is not answering. Check that it is running, or choose a local model."
    : null
}

/** Keep remote transport errors useful without exposing the endpoint, headers,
 * API key, or request body. */
function remoteTextModelTransportError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error('Remote text model request failed.')
  const cause = error.cause
  if (!cause || typeof cause !== 'object') {
    return new Error(`Remote text model request failed: ${error.message}`)
  }
  const detail = cause as { message?: unknown; code?: unknown }
  const message = typeof detail.message === 'string' ? detail.message.trim() : ''
  const code = typeof detail.code === 'string' ? detail.code.trim() : ''
  const unreachable = remoteModelUnreachable(code)
  if (unreachable) return new Error(unreachable)
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

/**
 * The request fields that turn a remote model's reasoning on or off, for its provider. One owner for
 * Chat and the gateway: a model whose reasoning is mandatory never gets it switched off, which the
 * provider refuses ("Reasoning is mandatory for this endpoint and cannot be disabled").
 */
export function remoteReasoningFields(
  thinking: boolean | undefined,
  budget: number,
  capability: RemoteReasoningCapability
): Record<string, unknown> {
  const ollamaEffort =
    budget > 0 ? (budget <= 1024 ? 'low' : budget <= 4096 ? 'medium' : 'high') : 'medium'
  // llama.cpp's own controls: it reads enable_thinking itself, maps the standard reasoning_effort
  // into whichever variable the template uses ("none" switches thinking off), and caps whatever
  // thinking it finds with the budget. Templates with no switch at all (Flint) still get the cap.
  const llamaCpp = (on: boolean): Record<string, unknown> => ({
    chat_template_kwargs: { enable_thinking: on },
    ...(capability.reasoningEffort ? { reasoning_effort: on ? 'high' : 'none' } : {}),
    ...(on && budget > 0 ? { reasoning_budget_tokens: budget } : {})
  })
  return thinking === undefined
    ? {}
    : capability.tokenBudget &&
        (capability.control === 'none' || capability.control === 'enable-thinking')
      ? llamaCpp(thinking)
      : capability.control === 'none'
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
              : // LM Studio: the per-request switch, without llama.cpp's budget.
                { chat_template_kwargs: { enable_thinking: thinking } }
}

/** The OpenAI-compatible request body. Pure: what we send, with nothing about how we send it. */
function completionRequestBody(
  remote: RemoteTextModelConnection,
  request: RemoteChatRequest,
  capability: RemoteReasoningCapability
): string {
  const reasoning = remoteReasoningFields(
    request.thinking,
    request.reasoningBudget ?? REASONING_BUDGET_AUTO,
    capability
  )
  // Alibaba rejects forced tool choice while Qwen is thinking. Keep reasoning and let the
  // model select a tool; the visual policy caller still validates exactly one transition.
  const toolChoice =
    remote.provider === 'openrouter' &&
    remote.model.startsWith('qwen/') &&
    request.thinking === true &&
    request.toolChoice === 'required'
      ? 'auto'
      : (request.toolChoice ?? 'auto')
  return JSON.stringify({
    model: remote.model,
    messages: request.messages,
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    temperature: request.temperature,
    ...(request.topP === undefined ? {} : { top_p: request.topP }),
    ...(request.topK === undefined ? {} : { top_k: request.topK }),
    ...(request.minP === undefined ? {} : { min_p: request.minP }),
    ...(request.presencePenalty === undefined ? {} : { presence_penalty: request.presencePenalty }),
    ...(request.repeatPenalty === undefined
      ? {}
      : { repeat_penalty: request.repeatPenalty, repetition_penalty: request.repeatPenalty }),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    ...(request.tools?.length ? { tools: request.tools, tool_choice: toolChoice } : {}),
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
  const log = currentAIRequest()
  const local = isLocalModelServer(remote)
  log?.update({
    model: remote.model,
    backend: remote.computeBackend ?? (local ? 'Unknown' : 'Remote'),
    ...(local ? { source: screenTaskRequestSource('Grounding specialist', 'grounding') } : {})
  })
  const accumulator = createCompletionStreamAccumulator(
    (text, kind) => {
      log?.delta(text, kind)
      input.onDelta(text, kind)
    },
    options.onToolCallStart,
    options.onToolCallReady,
    options.onWaitStatus
      ? (status) => options.onWaitStatus?.(remoteWaitLabel(remote.name, status))
      : undefined
  )
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
    const body = completionRequestBody(remote, request, reasoning)
    if (request.thinking && 'thinkingOpensInPrompt' in reasoning && reasoning.thinkingOpensInPrompt)
      accumulator.startInsideThinking()
    log?.update({ effectiveRequest: JSON.parse(body) })
    const response = await fetch(`${remote.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {})
      },
      body,
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
    log?.update({ response: result, metrics: { ...result.metrics } })
    writeDiagnosticLog('remote_chat', 'request.completed', {
      provider: remote.provider,
      model: remote.model,
      // Why it stopped and what came back (sizes only), so an empty answer can be explained.
      finishReason: result.finishReason ?? 'none',
      contentChars: result.content.length,
      toolCalls: result.toolCalls.length,
      maxTokens: request.maxTokens
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
