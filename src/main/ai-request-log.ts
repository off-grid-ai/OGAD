import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { AIRequestRecord, AIModality } from '../shared/ai-request-log'
import { AI_LOG_POLICY } from '../shared/ai-request-log'
import type { RuntimeBackend } from '../shared/runtime-backends'

type Metadata = {
  modality: AIModality
  source: string
  model?: string
  backend?: string
  request?: unknown
  signal?: AbortSignal
  isCancelled?: (error: unknown) => boolean
}
type Update = Partial<
  Pick<AIRequestRecord, 'model' | 'effectiveRequest' | 'metrics' | 'response' | 'source'>
> & { backend?: string | null }
type Sink = (record: AIRequestRecord) => void
let sink: Sink | undefined
let epoch = 0
const context = new AsyncLocalStorage<AIRequestHandle>()
const unrecorded = new AsyncLocalStorage<true>()

/** No database, Electron, network, or synchronous disk access in inference paths. */
export function setAIRequestSink(next: Sink | undefined): void {
  sink = next
  epoch++
}
export function invalidateAIRequests(): void {
  epoch++
}
/**
 * Run work the request log must never keep: not its input, not its output, not that it happened.
 * Every request started inside, however deeply nested, is left out. For audio the user never
 * meant to send anywhere, such as the always-on wake word check.
 */
export function withoutAIRequestLog<T>(fn: () => T): T {
  return unrecorded.run(true, fn)
}
export function currentAIRequest(): AIRequestHandle | undefined {
  return context.getStore()
}

/** Snapshot before callers can mutate their buffers. Limits are explicit in the viewer. */
export function snapshotAIValue(value: unknown): unknown {
  let budget = AI_LOG_POLICY.maxPayloadChars as number
  let mediaBudget = AI_LOG_POLICY.maxAttachmentBytes * 2
  const seen = new WeakSet<object>()
  function visit(v: unknown, depth: number): unknown {
    if (budget <= 0 || depth > 15) return '[Not retained: log size limit]'
    if (typeof v === 'string') {
      if (/^data:(image\/(png|jpeg|webp)|audio\/[\w.+-]+);base64,/i.test(v)) {
        if (v.length > mediaBudget) return '[Media not retained: log size limit]'
        mediaBudget -= v.length
        return v
      }
      const result = v.slice(0, budget)
      budget -= result.length
      return result.length < v.length ? result + '\n[Truncated: log size limit]' : result
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') {
      budget -= 16
      return v
    }
    if (typeof v !== 'object') return undefined
    if (seen.has(v)) return '[Repeated reference]'
    seen.add(v)
    if (v instanceof Error) return { message: visit(v.message, depth + 1), name: v.name }
    if (Array.isArray(v)) return v.slice(0, 8192).map((item) => visit(item, depth + 1))
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(v).slice(0, 256)) {
      if (
        /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|cookie|signal)$/i.test(
          key
        )
      )
        continue
      result[key] = visit(item, depth + 1)
    }
    return result
  }
  try {
    return visit(value, 0)
  } catch {
    return '[Payload unavailable]'
  }
}

export class AIRequestHandle {
  readonly id = randomUUID()
  private readonly generation = epoch
  private readonly enabled = !!sink && unrecorded.getStore() !== true
  private done = false
  private content = ''
  private reasoning = ''
  private runtime?: RuntimeBackend
  private readonly parent = context.getStore()
  private record: AIRequestRecord
  constructor(meta: Metadata) {
    const parent = context.getStore()
    this.record = {
      id: this.id,
      parentId: parent?.id,
      modality: meta.modality,
      source: meta.source,
      model: meta.model,
      backend: meta.backend,
      status: 'running',
      startedAt: Date.now(),
      preview: '',
      request: this.enabled ? snapshotAIValue(meta.request) : undefined
    }
    this.publish()
  }
  private publish(): void {
    if (!this.enabled || this.generation !== epoch) return
    try {
      sink?.({ ...this.record })
    } catch {
      /* Recording must never break generation. */
    }
  }
  update(update: Update): void {
    if (!this.enabled) return
    try {
      Object.assign(this.record, snapshotAIValue(update))
    } catch {
      /* best effort */
    }
  }
  /** Keep request evidence separate from the live state, which is cleared on unload. */
  useRuntime(runtime: RuntimeBackend): void {
    if (!this.enabled || this.done || runtime.state !== 'loaded' || !runtime.backend) return
    if (
      this.runtime?.id === runtime.id &&
      this.runtime.model === runtime.model &&
      this.runtime.backend === runtime.backend &&
      this.runtime.device === runtime.device &&
      this.runtime.detail === runtime.detail
    )
      return
    this.runtime = { ...runtime }
    this.record.backend = runtime.backend
    this.publish()
  }
  delta(text: string, kind: 'content' | 'reasoning'): void {
    if (!this.enabled) return
    if (kind === 'content')
      this.content = (this.content + text).slice(0, AI_LOG_POLICY.maxPayloadChars)
    else this.reasoning = (this.reasoning + text).slice(0, AI_LOG_POLICY.maxPayloadChars)
  }
  /** Read only the submitted media, before its owner removes a temporary file. */
  async inputFile(file: string, mime = 'audio/wav'): Promise<void> {
    if (!this.enabled) return
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(file, 'r')
      const size = (await handle.stat()).size
      if (size > AI_LOG_POLICY.maxAttachmentBytes) {
        this.update({ effectiveRequest: { file, media: '[Not retained: larger than 8 MB]' } })
        return
      }
      const bytes = Buffer.alloc(size)
      const read = await handle.read(bytes, 0, size, 0)
      this.update({
        effectiveRequest: {
          file,
          media: `data:${mime};base64,${bytes.subarray(0, read.bytesRead).toString('base64')}`
        }
      })
    } catch {
      /* Missing input still reaches the runtime's normal error path. */
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  finish(result: unknown, error?: unknown, cancelled = false): void {
    if (this.done) return
    this.done = true
    this.record.finishedAt = Date.now()
    this.record.durationMs = this.record.finishedAt - this.record.startedAt
    this.record.status = cancelled ? 'cancelled' : error !== undefined ? 'failed' : 'completed'
    try {
      if (this.enabled) {
        if (error !== undefined)
          this.record.error = String(error instanceof Error ? error.message : error).slice(0, 4096)
        if (result && typeof result === 'object') {
          const output = result as Record<string, unknown>
          if (!this.runtime && typeof output.computeBackend === 'string')
            this.record.backend = output.computeBackend
          if (typeof output.model === 'string') this.record.model = output.model
          if (output.metrics && typeof output.metrics === 'object')
            this.record.metrics = snapshotAIValue({
              ...output.metrics,
              ...(this.record.backend ? { computeBackend: this.record.backend } : {})
            }) as Record<string, unknown>
        }
        this.record.response = snapshotAIValue(
          this.record.response ?? result ?? { content: this.content, reasoning: this.reasoning }
        )
        if (this.reasoning)
          this.record.response = { result: this.record.response, reasoning: this.reasoning }
        if (this.runtime) {
          this.record.backend = this.runtime.backend
          this.record.metrics = {
            ...this.record.metrics,
            computeBackend: this.runtime.backend,
            runtime: { ...this.runtime }
          }
          // A successful retry owns the parent result. Failed attempts retain
          // their own evidence without labelling the eventual fallback result.
          if (
            this.record.status === 'completed' &&
            this.record.modality !== 'text' &&
            this.parent?.record.modality === this.record.modality
          )
            this.parent.useRuntime(this.runtime)
        }
      }
    } catch {
      /* A malformed payload must not change the inference result. */
    }
    this.publish()
  }
  run<T>(fn: () => T): T {
    return context.run(this, fn)
  }
}

export async function recordAIRequest<T>(
  meta: Metadata,
  fn: (log: AIRequestHandle) => Promise<T>
): Promise<T> {
  const log = new AIRequestHandle(meta)
  return log.run(async () => {
    try {
      const result = await fn(log)
      log.finish(result, undefined, meta.signal?.aborted)
      return result
    } catch (error) {
      let cancelled =
        meta.signal?.aborted || (error instanceof Error && error.name === 'AbortError')
      try {
        cancelled ||= meta.isCancelled?.(error) === true
      } catch {
        /* Best-effort status classification. */
      }
      log.finish(undefined, error, cancelled)
      throw error
    }
  })
}
