// Retry-with-deadline loop shared by the model-server gateway proxies.
//
// The gateway proxies a request to the bundled llama-server. When the engine is
// briefly down (it reloads after image generation, or is still starting) a
// connection error is TRANSIENT - waiting a moment and replaying the same
// request succeeds. But only if the request is REPLAYABLE: a piped/streamed
// request has already consumed its source, so it can't be re-sent and must fail
// fast. HTTP errors from a reachable engine (>= 400) are FATAL - they are the
// engine's real answer and are never retried.
//
// This module isolates that decision as a pure function so it can be unit-tested
// with an injected clock, with zero network or Electron I/O.

/** Minimal clock seam so tests inject fake time instead of sleeping for real. */
export interface Clock {
  /** Current epoch milliseconds (like `Date.now()`). */
  now(): number
  /** Schedule `cb` after `ms` (like `setTimeout`, return value ignored). */
  setTimeout(cb: () => void, ms: number): void
}

/** Real wall-clock backed by the host timers. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => {
    setTimeout(cb, ms)
  }
}

export interface RetryOptions {
  /**
   * Absolute epoch-ms deadline. A transient failure is retried only while
   * `clock.now() < deadlineMs`; once reached, the last failure is thrown.
   * A deadline at or before the first attempt means "no retries" (fail fast).
   */
  deadlineMs: number
  /**
   * Whether this attempt may be replayed. A streamed/piped request that has
   * already consumed its body is NOT replayable and must fail fast even within
   * the deadline. Defaults to `true` (the common replayable case).
   */
  replayable?: boolean
  /**
   * Classify a rejection: `true` = transient (connection error, worth
   * retrying), `false` = fatal (e.g. an HTTP >= 400 answer, never retried).
   * Defaults to treating every rejection as transient, matching the callers
   * that only ever reject on a connection error.
   */
  isTransient?: (err: unknown) => boolean
  /** Delay between attempts in ms. Defaults to 1000, matching the proxies. */
  delayMs?: number
  /** Clock seam (defaults to the real system clock). */
  clock?: Clock
}

/**
 * Run `fn`, and on a TRANSIENT rejection wait `delayMs` and retry until the
 * deadline passes - but only while the request is `replayable`. A fatal
 * rejection (or a non-replayable request) rejects immediately. The resolved
 * value of the first successful attempt is returned.
 */
export function retryWithDeadline<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const {
    deadlineMs,
    replayable = true,
    isTransient = () => true,
    delayMs = 1000,
    clock = systemClock
  } = opts

  return new Promise<T>((resolve, reject) => {
    const attempt = (): void => {
      fn().then(resolve, (err) => {
        if (replayable && isTransient(err) && clock.now() < deadlineMs) {
          clock.setTimeout(attempt, delayMs)
        } else {
          reject(err)
        }
      })
    }
    attempt()
  })
}
