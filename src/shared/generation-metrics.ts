/**
 * Structural, not imported from the SSE layer: this module lives in shared so the renderer can read
 * the same shape it renders, and shared must not depend on main. The wire types satisfy these.
 */
interface UsageCounts {
  prompt_tokens?: number
  completion_tokens?: number
}

interface ServerTimings {
  prompt_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
}

/**
 * What a generation cost, as shown under an assistant message.
 *
 * Every field is optional on purpose: this has to describe a local llama.cpp run, a remote
 * OpenAI-compatible model, and a server that reports nothing at all. What we can always measure
 * ourselves is time - when the first token arrived and when the last one did. Everything else comes
 * from the server if it chooses to send it, and is simply absent otherwise. The renderer shows the
 * fields that are present rather than inventing zeros, because "0 tok/s" is a lie and a missing rate
 * is the truth.
 */
export interface GenerationMetrics {
  /** Seconds from request to the first visible token. Measured here, so always available. */
  timeToFirstTokenSeconds?: number
  /** Seconds from request to the end of the stream. Measured here, so always available. */
  totalSeconds?: number
  /** Output tokens per second. Prefers the server's own measurement over our estimate. */
  decodeTokensPerSecond?: number
  /** Prompt tokens per second, when the server measures it (llama.cpp does). */
  prefillTokensPerSecond?: number
  promptTokens?: number
  completionTokens?: number
}

/**
 * Format the elapsed time for an assistant response.
 *
 * A synced turn's explicit duration is authoritative. Local generations currently carry the same
 * fact as total seconds in their measured metrics, so that value is the fallback until persistence
 * gives every turn one representation.
 */
export function formatGenerationDuration(input: {
  generationTimeMs?: number
  totalSeconds?: number
}): string | undefined {
  const explicitDuration =
    typeof input.generationTimeMs === 'number' &&
    Number.isFinite(input.generationTimeMs) &&
    input.generationTimeMs >= 0
      ? input.generationTimeMs
      : undefined
  const fallbackDuration =
    typeof input.totalSeconds === 'number' &&
    Number.isFinite(input.totalSeconds) &&
    input.totalSeconds >= 0
      ? input.totalSeconds * 1000
      : undefined
  const durationMs = explicitDuration ?? fallbackDuration
  if (durationMs === undefined) return undefined
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`

  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`

  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.floor(seconds % 60)}s`
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Fold what we timed together with what the server reported.
 *
 * The server's own rate wins when it sends one: it measures decode time alone, whereas our wall
 * clock includes queueing, prefill, and network, so dividing tokens by total time understates the
 * rate - sometimes by a lot on a cold prompt. We fall back to that estimate only when there is
 * nothing better, and only when we know the token count.
 */
export function generationMetrics(input: {
  startedAtMs: number
  firstTokenAtMs?: number
  finishedAtMs: number
  usage?: UsageCounts
  timings?: ServerTimings
}): GenerationMetrics {
  const { startedAtMs, firstTokenAtMs, finishedAtMs, usage, timings } = input
  const totalSeconds = positive((finishedAtMs - startedAtMs) / 1000)
  const timeToFirstTokenSeconds =
    firstTokenAtMs === undefined ? undefined : positive((firstTokenAtMs - startedAtMs) / 1000)
  const completionTokens = positive(usage?.completion_tokens) ?? positive(timings?.predicted_n)

  const serverDecodeRate = positive(timings?.predicted_per_second)
  const decodeSeconds =
    positive(timings?.predicted_ms) !== undefined
      ? positive(timings?.predicted_ms)! / 1000
      : firstTokenAtMs === undefined
        ? undefined
        : positive((finishedAtMs - firstTokenAtMs) / 1000)
  const estimatedDecodeRate =
    completionTokens !== undefined && decodeSeconds !== undefined
      ? positive(completionTokens / decodeSeconds)
      : undefined

  return {
    ...(timeToFirstTokenSeconds === undefined ? {} : { timeToFirstTokenSeconds }),
    ...(totalSeconds === undefined ? {} : { totalSeconds }),
    ...((serverDecodeRate ?? estimatedDecodeRate)
      ? { decodeTokensPerSecond: serverDecodeRate ?? estimatedDecodeRate }
      : {}),
    ...(positive(timings?.prompt_per_second) === undefined
      ? {}
      : { prefillTokensPerSecond: positive(timings?.prompt_per_second) }),
    ...((positive(usage?.prompt_tokens) ?? positive(timings?.prompt_n))
      ? { promptTokens: positive(usage?.prompt_tokens) ?? positive(timings?.prompt_n) }
      : {}),
    ...(completionTokens === undefined ? {} : { completionTokens })
  }
}

/** The compact one-line summary, in the order mobile shows it. Empty when nothing was measured. */
export function formatGenerationMetrics(metrics: GenerationMetrics): string[] {
  const parts: string[] = []
  if (metrics.prefillTokensPerSecond) {
    parts.push(`prefill ${metrics.prefillTokensPerSecond.toFixed(0)} tok/s`)
  }
  if (metrics.decodeTokensPerSecond) {
    parts.push(`${metrics.decodeTokensPerSecond.toFixed(1)} tok/s`)
  }
  if (metrics.timeToFirstTokenSeconds) {
    parts.push(`TTFT ${metrics.timeToFirstTokenSeconds.toFixed(2)}s`)
  }
  if (metrics.completionTokens) parts.push(`${metrics.completionTokens} tokens`)
  if (metrics.totalSeconds) parts.push(`${metrics.totalSeconds.toFixed(1)}s total`)
  return parts
}
