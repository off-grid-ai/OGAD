import { REASONING_BUDGET_AUTO, openRouterReasoningPayload } from '@offgrid/models'
import type { RemoteVisionProvider } from '../../shared/remote-vision-server'
import { createCompletionStreamAccumulator, type StreamResult } from './stream'

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

/** One OpenAI-compatible remote transport for Chat, agentic tools, planning,
 * Web Use intake, and visual policy calls. It never falls back to a local model. */
export async function streamRemoteChatCompletion(
  remote: RemoteTextModelConnection,
  request: RemoteChatRequest,
  onDelta: (text: string, kind: 'content' | 'reasoning') => void,
  options: RemoteChatOptions
): Promise<StreamResult> {
  const accumulator = createCompletionStreamAccumulator(onDelta)
  if (options.signal?.aborted) return accumulator.finish()

  const idleController = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, idleController.signal])
    : idleController.signal
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      idleController.abort()
    }, options.timeoutMs)
  }
  armIdleTimer()

  try {
    const response = await fetch(`${remote.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(remote.apiKey ? { Authorization: `Bearer ${remote.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: remote.model,
        messages: request.messages,
        max_tokens: request.maxTokens,
        temperature: request.temperature,
        ...(request.topP === undefined ? {} : { top_p: request.topP }),
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
        ...(request.tools?.length
          ? { tools: request.tools, tool_choice: request.toolChoice ?? 'auto' }
          : {}),
        // Carry the user's configured thinking cap, not just a coarse effort hint. Without this
        // the cap was dropped for every remote model and the budget setting did nothing.
        ...(remote.provider === 'openrouter'
          ? openRouterReasoningPayload(
              request.thinking === true,
              request.reasoningBudget ?? REASONING_BUDGET_AUTO
            )
          : {}),
        stream: true
      }),
      signal
    })
    armIdleTimer()
    if (!response.ok) {
      const body = (await response.text()).slice(0, 4_096)
      throw remoteTextModelProviderError(response.status, body)
    }
    if (!response.body) throw new Error('Remote text model returned an empty response stream.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      armIdleTimer()
      accumulator.push(decoder.decode(chunk.value, { stream: true }))
    }
    accumulator.push(decoder.decode())
    return accumulator.finish()
  } catch (error) {
    if (options.signal?.aborted) return accumulator.finish()
    if (idleTimedOut) throw new Error('Remote text model request timed out.')
    if (error instanceof Error && error.message.startsWith('Remote text model returned HTTP ')) {
      throw error
    }
    throw remoteTextModelTransportError(error)
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }
}
