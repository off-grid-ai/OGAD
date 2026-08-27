import path from 'path'
import { Worker } from 'worker_threads'
import { modelsDir } from './runtime-env'
import type { EmbeddingRequest, EmbeddingResponse } from './embeddings-worker'

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
    { resolve: (v: number[]) => void; reject: (e: Error) => void }
  >()
  /** Serializes requests: the tail of the queue, not a list, so memory does not grow with it. */
  private queue: Promise<unknown> = Promise.resolve()

  private spawn(): Worker {
    if (this.worker) return this.worker
    // Both entries are bundled side by side into out/main by electron.vite.config.ts.
    const worker = new Worker(path.join(__dirname, 'embeddings-worker.js'), {
      workerData: { modelsDir: modelsDir() }
    })
    worker.on('message', (response: EmbeddingResponse) => {
      const pending = this.waiting.get(response.id)
      if (!pending) return
      this.waiting.delete(response.id)
      if (response.error) pending.reject(new Error(response.error))
      else pending.resolve(response.vector ?? [])
    })
    // A dead worker must not strand callers, and the next request should get a fresh one.
    const fail = (error: Error): void => {
      this.worker = null
      for (const [, pending] of this.waiting) pending.reject(error)
      this.waiting.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
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
    const run = (): Promise<number[]> =>
      new Promise<number[]>((resolve, reject) => {
        const worker = this.spawn()
        const id = this.nextId++
        this.waiting.set(id, { resolve, reject })
        worker.postMessage({ id, text } as EmbeddingRequest)
      })
    const result = this.queue.then(run, run)
    // Keep the chain alive after a rejection, or one failure stalls every later request.
    this.queue = result.catch(() => undefined)
    return result
  }
}

export const embeddings = new EmbeddingService()
