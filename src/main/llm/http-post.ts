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
import { textServerFailure, type TextServerFailureKind } from '@offgrid/models'

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
export type ModelServerFailureKind = TextServerFailureKind

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

/** @deprecated Import `textServerFailure` from `@offgrid/models`. */
export const classifyServerError = textServerFailure

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
  timeoutMs: number | undefined,
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
    // No deadline unless the caller set one: a slow prompt is not a failure.
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            req.destroy()
            finish(() =>
              reject(
                new ModelServerError('unavailable', 'LLM request timed out - try a shorter prompt')
              )
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
