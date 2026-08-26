// Single SSE-transport for a streaming completion. chatStream (message-in,
// answer-out) and streamChat (raw messages + tool-calls) had this ~40-line
// Promise body copy-pasted twice — the buffered newline split, parseSseLine,
// reasoning/answer routing, tool-call accumulation, timeout, cooperative abort,
// and error handling. It lives ONCE here; both callers build their payload and
// hand the JSON body to streamCompletion, which returns the answer text plus any
// assembled tool calls (empty for the plain chat path, which sends no tools).
import http from 'http'
import {
  parseSseLine,
  createThinkSplitter,
  createToolCallAccumulator,
  createToolMarkupFilter,
  type AssembledToolCall
} from './sse-stream'
import { modelRequestOptions, serverResponseError } from './http-post'

export interface StreamResult {
  content: string
  toolCalls: AssembledToolCall[]
  /** Raw OpenAI-compatible stop reason. Product layers normalize this value. */
  finishReason: string | null
}

export interface StreamOptions {
  signal?: AbortSignal
  timeoutMs: number
}

export interface CompletionStreamAccumulator {
  push(chunk: string): void
  finish(): StreamResult
}

/** Transport-neutral OpenAI SSE projection. Local HTTP and selected remote
 * models feed the same parser, reasoning split, markup filter, and tool-call
 * accumulator so model location cannot change the caller-visible contract. */
export function createCompletionStreamAccumulator(
  onDelta: (text: string, kind: 'content' | 'reasoning') => void
): CompletionStreamAccumulator {
  let buffer = ''
  let finishReason: string | null = null
  const markup = createToolMarkupFilter((text) => onDelta(text, 'content'))
  const reasoningMarkup = createToolMarkupFilter((text) => onDelta(text, 'reasoning'))
  const splitter = createThinkSplitter((event) => {
    if (event.kind === 'content') markup.push(event.text)
    else reasoningMarkup.push(event.text)
  })
  const tools = createToolCallAccumulator()

  const push = (chunk: string): void => {
    buffer += chunk
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const frame = parseSseLine(line)
      if (!frame) continue
      if (frame.finishReason) finishReason = frame.finishReason
      if (frame.delta.reasoning_content) reasoningMarkup.push(frame.delta.reasoning_content)
      if (frame.delta.content) splitter.push(frame.delta.content)
      if (frame.delta.tool_calls) tools.push(frame.delta.tool_calls)
    }
  }

  return {
    push,
    finish() {
      // A conforming SSE stream ends frames with a newline. Parse a final line
      // defensively because remote OpenAI-compatible providers can omit it.
      if (buffer) {
        push('\n')
      }
      markup.end()
      reasoningMarkup.end()
      return {
        content: splitter.answer(),
        toolCalls: tools.list(),
        finishReason
      }
    }
  }
}

/**
 * POST a `stream: true` completion body to the local model server and stream the
 * response. `onDelta` fires per token, separated into the reasoning channel
 * (delta.reasoning_content or text inside think tags, via the splitter) and the
 * answer channel. Resolves with the full answer + any tool calls the model
 * emitted when the stream ends, on abort (returning whatever streamed so far),
 * and rejects on a non-200 status, transport error, or timeout.
 *
 * Fresh connection per request (llm/http-post modelRequestOptions) — no
 * keep-alive pool, so the tool loop's back-to-back requests never hit a
 * half-closed socket (ECONNRESET).
 */
export function streamCompletion(
  port: number,
  body: string,
  onDelta: (text: string, kind: 'content' | 'reasoning') => void,
  opts: StreamOptions
): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    let timedOut = false
    let aborted = false
    const accumulator = createCompletionStreamAccumulator(onDelta)
    // opts.signal is REUSED across the whole tool loop, so every completed stream
    // must detach its abort listener — otherwise handlers accumulate on the shared
    // signal for the loop's lifetime. cleanup() runs on every terminal path.
    let onAbort: (() => void) | null = null
    let idleTimer: ReturnType<typeof setTimeout>
    const cleanup = (): void => {
      clearTimeout(idleTimer)
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort)
    }
    // IDLE timeout, re-armed on every chunk — NOT a total-duration cap. A long but healthy stream
    // (output is no longer capped at 1024, so a real answer can run for minutes) must never be killed
    // while tokens keep flowing; only a genuinely stalled/hung generation (no data for opts.timeoutMs)
    // times out. This was previously a single total-duration timer that killed long responses
    // mid-stream the moment output was uncapped ("LLM request timed out" at ~5 min).
    const armIdleTimer = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        cleanup()
        req.destroy()
        reject(new Error('LLM request timed out'))
      }, opts.timeoutMs)
    }
    armIdleTimer()

    const req = http.request(modelRequestOptions(port, Buffer.byteLength(body)), (res) => {
      if (res.statusCode !== 200) {
        // Read the server's error body (small, capped) so we surface an ACTIONABLE
        // message (e.g. context overflow from too many connectors, or a tool schema
        // that won't compile to a grammar) instead of a bare status code. B2.
        let err = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (err.length < 4096) err += c
        })
        res.on('end', () => {
          cleanup()
          if (!timedOut && !aborted) {
            reject(serverResponseError(res.statusCode, err))
          }
        })
        return
      }
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        armIdleTimer() // progress: reset the idle timeout on every chunk so a long stream survives
        accumulator.push(chunk)
      })
      res.on('end', () => {
        cleanup()
        if (!timedOut && !aborted) {
          resolve(accumulator.finish())
        }
      })
    })
    req.on('error', (e) => {
      cleanup()
      if (!timedOut && !aborted) {
        reject(e)
      }
    })
    // Cooperative cancellation: stop the request and return whatever streamed so far.
    if (opts.signal) {
      onAbort = (): void => {
        aborted = true
        cleanup()
        try {
          req.destroy()
        } catch {
          /* already gone */
        }
        resolve(accumulator.finish())
      }
      if (opts.signal.aborted) {
        // Already aborted before we sent anything (the tool loop reuses one signal and a
        // later round can start already-cancelled). onAbort() destroyed the request, so
        // return WITHOUT write/end — writing to a destroyed request fires a doomed socket
        // write whose 'error' is then swallowed by the aborted guard. cleanup() already ran.
        onAbort()
        return
      }
      opts.signal.addEventListener('abort', onAbort)
    }
    req.write(body)
    req.end()
  })
}
