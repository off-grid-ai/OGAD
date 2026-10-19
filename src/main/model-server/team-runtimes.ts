// Team gateway mode's admission, one limiter per runtime, sized from the shared policy table
// (gatewayRuntimeTable in @offgrid/models). The HTTP gateway and the MCP server take turns through
// the same limiters, so a runtime's limit holds whichever door a request came in by.
//
// Single mode never touches these: every route keeps today's serialisation.

import { totalmem } from 'os'
import {
  EMBEDDING_BATCH_WINDOW_MS,
  embeddingBatchSize,
  gatewayRuntimeTable,
  limiterQueueDepth,
  llmSlotCount,
  type GatewayRuntime
} from '@offgrid/models'
import { llm } from '../llm'
import { gatewayRequestKeyName, withGatewayRequestKeyName } from '../ai-request-log'
import { LimiterFullError, UpstreamLimiter, type Release } from './upstream-limiter'

/** The context the grounder and Decider llama-servers launch with. */
const SPECIALIST_CONTEXT = 16_384

/** Whether the gateway serves several clients at once. */
export function teamMode(): boolean {
  return llm.gatewayMode() === 'team'
}

const LABELS: Record<GatewayRuntime, string> = {
  chat: 'local model',
  grounder: 'grounding model',
  decision: 'decision model',
  kev: 'Kev decision model',
  remote: 'remote model',
  image: 'image model',
  transcription: 'transcription model',
  speech: 'voice model',
  embeddings: 'embedding model'
}

/** The concurrency each runtime gets right now (slots follow the chat model's settings). */
export function teamConcurrency(): Record<GatewayRuntime, number> {
  const totalRamGb = totalmem() / 1024 ** 3
  const table = gatewayRuntimeTable({
    chatSlots: llm.gatewaySlots(),
    specialistSlots: llmSlotCount({
      mode: 'team',
      ctxSize: SPECIALIST_CONTEXT,
      totalMemoryGb: totalRamGb
    }),
    totalRamGb
  })
  return Object.fromEntries(
    Object.entries(table).map(([runtime, row]) => [runtime, row.concurrency])
  ) as Record<GatewayRuntime, number>
}

const limiters = new Map<GatewayRuntime, UpstreamLimiter>()

/** The runtime's limiter, sized to its current concurrency. */
export function teamLimiter(runtime: GatewayRuntime): UpstreamLimiter {
  const capacity = teamConcurrency()[runtime]
  let limiter = limiters.get(runtime)
  if (!limiter) {
    limiter = new UpstreamLimiter(LABELS[runtime], capacity)
    limiters.set(runtime, limiter)
  } else limiter.setCapacity(capacity)
  // The chat model's slots share one KV pool: admit by its tokens too.
  if (runtime === 'chat') limiter.setTokenBudget(llm.gatewayPoolTokens())
  return limiter
}

export interface RuntimeStatus {
  /** Requests it serves at once; null where single mode sets no limit. */
  capacity: number | null
  running: number | null
  waiting: number | null
  /** Requests refused with 429 since the app started. */
  refused: number
}

/** Every runtime's line as team mode runs it now: from its limiter, read without resizing it.
 *  A runtime nobody has used yet reports its capacity and nothing running. */
export function teamRuntimeStatus(): Record<GatewayRuntime, RuntimeStatus> {
  const concurrency = teamConcurrency()
  const out = {} as Record<GatewayRuntime, RuntimeStatus>
  for (const runtime of Object.keys(LABELS) as GatewayRuntime[]) {
    const limiter = limiters.get(runtime)
    out[runtime] = limiter
      ? { ...limiter.status(), capacity: concurrency[runtime] }
      : { capacity: concurrency[runtime], running: 0, waiting: 0, refused: 0 }
  }
  out.embeddings = {
    capacity: concurrency.embeddings,
    running: embeddingBatchRunning ? 1 : 0,
    waiting: embeddingWaiters.length,
    refused: embeddingsRefused
  }
  return out
}

/** The chat model's limiter without resizing it (the eviction gate reads it at any time). */
export function chatLimiter(): UpstreamLimiter {
  let limiter = limiters.get('chat')
  if (!limiter) {
    limiter = new UpstreamLimiter(LABELS.chat, 1)
    limiters.set('chat', limiter)
  }
  return limiter
}

/** Run `work` on its turn. A request whose client leaves while waiting gives its place up. */
export async function withTurn<T>(
  runtime: GatewayRuntime,
  work: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release: Release = await teamLimiter(runtime).acquire(signal)
  try {
    return await work()
  } finally {
    release()
  }
}

// ─── Embeddings: concurrent requests coalesce into one batch ────────────────

interface EmbeddingWaiter {
  texts: string[]
  /** The API key that sent it, for the request log. */
  keyName: string | undefined
  resolve: (vectors: number[][]) => void
  reject: (error: unknown) => void
}

const embeddingWaiters: EmbeddingWaiter[] = []
let embeddingBatchRunning = false
let embeddingsRefused = 0

/**
 * Vectors for `texts`, batched with every other request waiting at the time: a batch starts after a
 * 3 ms window, the worker runs one batch at a time, and requests that arrive meanwhile share the
 * next forward pass instead of queueing one by one. Interactive: these run ahead of background indexing. Refused (429) past the
 * bounded line.
 */
export function embedCoalesced(texts: string[]): Promise<number[][]> {
  if (embeddingWaiters.length >= limiterQueueDepth(1) * 4) {
    embeddingsRefused += 1
    return Promise.reject(new LimiterFullError(LABELS.embeddings))
  }
  return new Promise<number[][]>((resolve, reject) => {
    embeddingWaiters.push({ texts, keyName: gatewayRequestKeyName(), resolve, reject })
    runEmbeddingBatch()
  })
}

let embeddingWindow: ReturnType<typeof setTimeout> | null = null

/** Start the next batch after a short window, so requests arriving together share it. */
function runEmbeddingBatch(): void {
  if (embeddingBatchRunning || embeddingWindow || embeddingWaiters.length === 0) return
  embeddingWindow = setTimeout(() => {
    embeddingWindow = null
    void embedNextBatch()
  }, EMBEDDING_BATCH_WINDOW_MS)
}

async function embedNextBatch(): Promise<void> {
  if (embeddingBatchRunning || embeddingWaiters.length === 0) return
  embeddingBatchRunning = true
  const take = embeddingBatchSize(
    embeddingWaiters.map((waiter) => ({
      texts: waiter.texts.length,
      chars: waiter.texts.reduce((sum, text) => sum + text.length, 0)
    }))
  )
  const batch = embeddingWaiters.splice(0, take)
  try {
    const { embeddings } = await import('../embeddings')
    // The batch's log record names a key only when every request in it came with that key.
    const keys = new Set(batch.map((waiter) => waiter.keyName))
    const vectors = await withGatewayRequestKeyName(
      keys.size === 1 ? [...keys][0] : undefined,
      () =>
        embeddings.embedDocumentTexts(
          batch.flatMap((waiter) => waiter.texts),
          { interactive: true, source: 'API embeddings' }
        )
    )
    let offset = 0
    for (const waiter of batch) {
      waiter.resolve(vectors.slice(offset, offset + waiter.texts.length))
      offset += waiter.texts.length
    }
  } catch (error) {
    for (const waiter of batch) waiter.reject(error)
  } finally {
    embeddingBatchRunning = false
    runEmbeddingBatch()
  }
}
