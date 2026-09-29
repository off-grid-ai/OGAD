import { beginRuntimeBackend, providerLabel } from './runtime-backends'
import path from 'path'
import { existsSync } from 'fs'
import { Worker } from 'worker_threads'
import { modelsDir } from './runtime-env'
import { embedText, embeddingDevice, disposeEmbeddingModel } from './embeddings-core'
import { getResidencyMode } from './runtime-residency'
import { recordAIRequest, type AIRequestHandle } from './ai-request-log'
import type { EmbeddingRequest, EmbeddingResponse } from './embeddings-worker'
import { writeDiagnosticLog } from './diagnostics-log'
import { getBackendPreference } from './backend-preferences'

/**
 * The built worker, when there is one.
 *
 * Production and dev both run from out/main, where electron.vite.config.ts puts both entries side
 * by side. Running from SOURCE (tests) there is only the .ts, which a Worker cannot load - it gets
 * no TypeScript transform, so its own imports fail to resolve. Returning null there is deliberate:
 * the caller embeds in-process instead, using the same implementation.
 */
function builtWorkerEntry(): string | null {
  const built = path.join(__dirname, 'embeddings-worker.js')
  return existsSync(built) ? built : null
}

/**
 * Text -> vector, executed in a worker thread (see embeddings-worker.ts for why).
 *
 * The public surface is unchanged: callers still `await embeddings.generateEmbedding(text)`. What
 * changed is where that runs. Requests are serialized onto one worker rather than issued
 * concurrently, because the ONNX runtime is already multi-threaded internally — firing several at
 * once multiplies its WASM threads and starves the UI, which is the behaviour this move exists to
 * stop.
 */
class EmbeddingService {
  private worker: Worker | null = null
  private nextId = 1
  private readonly waiting = new Map<
    number,
    { resolve: (v: number[]) => void; reject: (e: Error) => void; log: AIRequestHandle }
  >()
  /** Serializes requests: the tail of the queue, not a list, so memory does not grow with it. */
  private queue: Promise<unknown> = Promise.resolve()
  private reportedDevice: string | null = null

  private spawn(entry: string): Worker {
    if (this.worker) return this.worker
    // Built entries sit side by side in out/main (electron.vite.config.ts), but tests and any
    // run-from-source context have only the .ts next to this file. Resolve whichever EXISTS rather
    // than assuming the built layout: assuming it made every embedding fail outside a packaged
    // build, which silently demoted vector search to the FTS fallback instead of erroring.
    const backendState = beginRuntimeBackend('embeddings', 'Xenova/all-MiniLM-L6-v2')
    const worker = new Worker(entry, { workerData: { modelsDir: modelsDir(), backendPreference: getBackendPreference('embeddings') } })
    worker.on('message', (response: EmbeddingResponse) => {
      if (response.ready && response.device) {
        backendState.ready(providerLabel(response.device), undefined, response.fallbackReason)
        this.reportedDevice = response.device
        return
      }
      const pending = this.waiting.get(response.id)
      if (!pending) return
      this.waiting.delete(response.id)
      backendState.recordRequest(pending.log)
      if (response.device && response.device !== this.reportedDevice) {
        this.reportedDevice = response.device
        writeDiagnosticLog('embeddings', 'runtime.ready', {
          backend: 'onnxruntime',
          device: response.device
        })
      }
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response.vector ?? [])
    })
    // A dead worker must not strand callers, and the next request should get a fresh one.
    const fail = (error: Error): void => {
      backendState.fail(error)
      if (this.worker !== worker) return
      this.reportedDevice = null
      this.worker = null
      for (const [, pending] of this.waiting) pending.reject(error)
      this.waiting.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      backendState.stop()
      if (this.worker !== worker) return
      this.reportedDevice = null
      if (code !== 0) fail(new Error(`Embedding worker exited with code ${code}`))
      else this.worker = null
    })
    worker.unref() // never hold the app open just for this
    this.worker = worker
    return worker
  }

  /** Kept for callers that want to pay the model load cost up front. */
  async init(): Promise<void> {
    await this.generateEmbedding('')
  }

  async generateEmbedding(text: string): Promise<number[]> {
    return recordAIRequest(
      {
        modality: 'embedding',
        source: text ? 'Embedding' : 'Embedding warm-up',
        model: 'Xenova/all-MiniLM-L6-v2',
        request: { text, pooling: 'mean', normalize: true }
      },
      async (log) => {
        const run = (): Promise<number[]> => {
          const entry = builtWorkerEntry()
          // No built worker means we are running from source. Embed here rather than failing: a failed
          // embedding silently demotes every search to the FTS fallback, which is a far worse outcome
          // than briefly holding this thread in a context that has no UI to block.
          if (!entry)
            return embedText(text, modelsDir(), (device, reason) => {
              beginRuntimeBackend('embeddings', 'Xenova/all-MiniLM-L6-v2').ready(
                providerLabel(device),
                undefined,
                reason
              )
            }, getBackendPreference('embeddings'))
          return new Promise<number[]>((resolve, reject) => {
            const worker = this.spawn(entry)
            const id = this.nextId++
            this.waiting.set(id, { resolve, reject, log })
            worker.postMessage({ id, text } as EmbeddingRequest)
          })
        }
        const runWithResidency = async (): Promise<number[]> => {
          try {
            return await run()
          } finally {
            if (getResidencyMode('embeddings') === 'on-demand') {
              const worker = this.worker
              this.worker = null
              if (worker) await worker.terminate()
              else await disposeEmbeddingModel()
              this.reportedDevice = null
            }
          }
        }
        const result = this.queue.then(runWithResidency, runWithResidency)
        // Keep the chain alive after a rejection, or one failure stalls every later request.
        this.queue = result.catch(() => undefined)
        const vector = await result
        log.update({
          backend: this.reportedDevice ?? embeddingDevice() ?? 'Unknown',
          metrics: { dimensions: vector.length }
        })
        return vector
      }
    )
  }
}

export const embeddings = new EmbeddingService()
