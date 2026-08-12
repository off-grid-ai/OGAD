// The single source of truth for how we talk HTTP to the local model server, isolated from
// the electron-bound LLMService so it can be exercised by a real integration test.
//
// Why this exists: the agentic tool loop makes BACK-TO-BACK requests to llama-server. The
// server closes its socket after each response; Node's global keep-alive agent pools that
// socket, so the next request grabs a half-closed socket and the write fails with ECONNRESET.
// Single-shot chat never reused a socket, so only the multi-round tool loop broke. The fix is
// a FRESH connection per request (`agent: false` + `Connection: close`). This module defines
// that contract ONCE; every request site in llm.ts builds its options from here (DRY), and the
// integration test drives postCompletionOnce against a real socket-closing server (behaviour).

import * as http from 'http'

/**
 * WHY a failure happened, decided by the only layer that can see it.
 *
 * - `unavailable` — the server is not answering: transport error, timeout, still loading a model.
 *   The same request may well succeed later.
 * - `overflow` — the request does not fit the loaded model's context window. Deterministic: the
 *   identical request can never succeed against this model.
 * - `rejected` — the server is up and refused this request (malformed body, uncompilable grammar).
 *   Also deterministic for this input.
 * - `aborted` — the caller cancelled. Not a failure of the request at all.
 *
 * A caller must NOT re-derive this from the message text. Capture did exactly that, called every
 * refusal `capture-model-unavailable`, and retried a permanently broken request 32 times.
 */
export type ModelServerFailureKind = 'unavailable' | 'overflow' | 'rejected' | 'aborted'

export class ModelServerError extends Error {
  readonly kind: ModelServerFailureKind
  readonly statusCode: number | undefined

  constructor(kind: ModelServerFailureKind, message: string, statusCode?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ModelServerError'
    this.kind = kind
    this.statusCode = statusCode
  }
}

/** The server's own explanation of a non-200, unwrapped from its JSON envelope. */
function serverDetail(body: string): string {
  const raw = (body || '').trim()
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown } | null
    const m = j?.error?.message ?? j?.message
    if (typeof m === 'string' && m) return m
  } catch {
    /* non-JSON body — use the raw text */
  }
  return raw
}

/** Classify a non-200 model-server response into a durable reason plus an ACTIONABLE message.
 *  llama-server returns a JSON body like {"error":{"message":"request (22825 tokens) exceeds
 *  the available context size (16384 tokens) …"}}; the bare status code alone is useless both
 *  to the user and to a retry policy. */
export function classifyServerError(
  statusCode: number | undefined,
  body: string
): { kind: ModelServerFailureKind; message: string } {
  const detail = serverDetail(body)
  // Context overflow — usually too many connectors enabled at once (their tool
  // schemas + grammar overflow the context window).
  if (/exceeds the available context size/i.test(detail)) {
    return {
      kind: 'overflow',
      message:
        'The request is larger than the model’s context window — usually too many connectors enabled at once. Disable some connectors, or raise the context window in Settings, then try again.'
    }
  }
  // A tool schema that can't be compiled into a valid grammar for the engine.
  if (/failed to (parse|initialize|compile) (grammar|json ?schema)/i.test(detail)) {
    return {
      kind: 'rejected',
      message:
        'A connected tool’s schema couldn’t be turned into a valid grammar for the local model. Disable the most recently added connector and try again.'
    }
  }
  // The server could not READ our request. A lone surrogate from Accessibility text makes the JSON
  // body unparseable to nlohmann, and a prompt whose media markers do not match its images cannot
  // be tokenized. Both are deterministic: the identical bytes fail identically, forever.
  if (/json\.exception|parse error|failed to tokenize/i.test(detail)) {
    return {
      kind: 'rejected',
      message: `LLM Server Error: ${statusCode ?? '?'}${detail ? ` ${detail}` : ''}`
    }
  }
  // A 4xx means the server understood the request and refused it. Anything else — 502, 503, 504, a
  // bare 500 — is the server failing to service it, which is the definition of an outage.
  //
  // Deliberately generous: an outage misread as a refusal loses a frame permanently, while a
  // refusal misread as an outage costs at most the bounded retry budget. Before that budget
  // existed the generous reading was dangerous. Now it is the safe one.
  const refused = statusCode !== undefined && statusCode >= 400 && statusCode < 500
  const kind: ModelServerFailureKind = refused ? 'rejected' : 'unavailable'
  return { kind, message: `LLM Server Error: ${statusCode ?? '?'}${detail ? ` ${detail}` : ''}` }
}

/** Turn a non-200 model-server response into an ACTIONABLE message. */
export function describeServerError(statusCode: number | undefined, body: string): string {
  return classifyServerError(statusCode, body).message
}

/** The typed rejection for a non-200 response, carrying the reason with the message. */
export function serverResponseError(
  statusCode: number | undefined,
  body: string
): ModelServerError {
  const { kind, message } = classifyServerError(statusCode, body)
  return new ModelServerError(kind, message, statusCode)
}

/** The request options that guarantee a fresh, non-pooled connection to the model server.
 *  This is the contract that unbroke the tool loop — defined once, consumed everywhere. */
export function modelRequestOptions(port: number, contentLength: number): http.RequestOptions {
  return {
    hostname: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    // Fresh connection per request — do NOT reuse a pooled keep-alive socket (the server
    // closes its socket after each response; a reused one is half-closed -> ECONNRESET).
    agent: false,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': contentLength,
      Connection: 'close'
    }
  }
}

/** One non-streaming POST to /v1/chat/completions, resolving the raw body text. Rejects on a
 *  non-200, a transport error, a timeout, or an abort via `signal`. Electron-free so it can be
 *  integration-tested. The abort matters: a pre-stream call (intent classify / image-prompt)
 *  otherwise runs to completion after the user hits Stop, leaving the model busy and blocking
 *  the next turn. */
export function postCompletionOnce(
  port: number,
  body: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelServerError('aborted', 'aborted'))
      return
    }
    let done = false
    const finish = (fn: () => void): void => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      req.destroy()
      finish(() => reject(new ModelServerError('aborted', 'aborted')))
    }
    const timer = setTimeout(() => {
      req.destroy()
      finish(() =>
        reject(new ModelServerError('unavailable', 'LLM request timed out - try a shorter prompt'))
      )
    }, timeoutMs)

    const req = http.request(modelRequestOptions(port, Buffer.byteLength(body)), (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () =>
        finish(() => {
          if (res.statusCode !== 200) {
            reject(serverResponseError(res.statusCode, data))
            return
          }
          resolve(data)
        })
      )
    })
    // A transport error (ECONNREFUSED, ECONNRESET, socket hang up) means the server never
    // answered. Always retryable — never a property of this request.
    req.on('error', (e) =>
      finish(() =>
        reject(
          new ModelServerError(
            'unavailable',
            e instanceof Error ? e.message : String(e),
            undefined,
            e
          )
        )
      )
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    req.write(body)
    req.end()
  })
}
