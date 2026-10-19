import type { IncomingMessage, ServerResponse } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import type { AIRequestHandle } from './ai-request-log'
import { createCompletionStreamAccumulator } from './llm/stream'
import { AI_LOG_POLICY } from '../shared/ai-request-log'

/** Passive observer: forwarding, backpressure and cancellation remain owned by the gateway.
 *  `deferred` (team mode, many streams at once): collect the reply's text in parts and hand it to
 *  the log once when the stream ends, instead of re-copying the whole growing text on every chunk.
 *  Events are still read as they arrive, so the recorded timings and reply are the same. */
export function observeAIResponse(
  response: IncomingMessage,
  client: ServerResponse,
  log?: AIRequestHandle,
  options: { deferred?: boolean } = {}
): void {
  if (!log) return
  const sse = String(response.headers['content-type']).includes('text/event-stream')
  const deferred = options.deferred === true
  const parts = { content: [] as string[], reasoning: [] as string[] }
  const accumulator = createCompletionStreamAccumulator((text, kind) =>
    deferred ? parts[kind].push(text) : log.delta(text, kind)
  )
  let body = ''
  let retained = 0
  let truncated = false
  let ended = false
  const decoder = new StringDecoder('utf8')
  const collect = (text: string): void => {
    const remaining = AI_LOG_POLICY.maxPayloadChars - retained
    if (text.length > remaining) truncated = true
    const part = text.slice(0, Math.max(0, remaining))
    retained += part.length
    try {
      if (sse) accumulator.push(part)
      else body += part
    } catch {
      /* Logging is non-critical. */
    }
  }
  const finish = (error?: Error, cancelled = false): void => {
    if (ended) return
    ended = true
    collect(decoder.end())
    client.off('close', onClose)
    let result: unknown = body
    try {
      result = sse ? accumulator.finish() : JSON.parse(body)
    } catch {
      /* Plain text error body. */
    }
    if (truncated) result = { partial: result, note: 'Truncated: log size limit' }
    if (deferred) {
      if (parts.content.length) log.delta(parts.content.join(''), 'content')
      if (parts.reasoning.length) log.delta(parts.reasoning.join(''), 'reasoning')
    }
    log.finish(
      result,
      error ??
        ((response.statusCode ?? 200) >= 400
          ? new Error(`HTTP ${response.statusCode}`)
          : undefined),
      cancelled
    )
  }
  const onClose = (): void => finish(undefined, !client.writableFinished)
  client.on('close', onClose)
  response.on('data', (chunk: Buffer) => {
    if (ended) return
    collect(typeof chunk === 'string' ? chunk : decoder.write(chunk))
  })
  response.once('end', () => finish())
  response.once('error', (error) => finish(error))
  response.once('aborted', () => finish(new Error('Upstream response interrupted')))
}
