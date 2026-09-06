import path from 'path'
import { existsSync } from 'fs'
import { Worker } from 'worker_threads'
import { modelsDir } from './runtime-env'
import { embedText } from './embeddings-core'
import type { EmbeddingRequest, EmbeddingResponse } from './embeddings-worker'
import { generateDesktopOperation } from './desktop-generation'

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
    { resolve: (v: number[]) => void; reject: (e: Error) => void }
  >()
  /** Serializes requests: the tail of the queue, not a list, so memory does not grow with it. */
  private queue: Promise<unknown> = Promise.resolve()

  private spawn(entry: string): Worker {
    if (this.worker) return this.worker
    // Built entries sit side by side in out/main (electron.vite.config.ts), but tests and any
    // run-from-source context have only the .ts next to this file. Resolve whichever EXISTS rather
    // than assuming the built layout: assuming it made every embedding fail outside a packaged
    // build, which silently demoted vector search to the FTS fallback instead of erroring.
    const worker = new Worker(entry, { workerData: { modelsDir: modelsDir() } })
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

  async initNative(): Promise<void> {
    await this.generateEmbeddingNative('')
  }

  async unloadNative(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const result = await generateDesktopOperation(
      { type: 'embedding', inputs: [text] },
      { profile: 'embedding' }
    )
    if (result.output.type !== 'embedding' || !result.output.vectors[0]) {
      throw new Error('The embedding engine returned no vector.')
    }
    return result.output.vectors[0]
  }

  async generateEmbeddingNative(text: string): Promise<number[]> {
    const run = (): Promise<number[]> => {
      const entry = builtWorkerEntry()
      // No built worker means we are running from source. Embed here rather than failing: a failed
      // embedding silently demotes every search to the FTS fallback, which is a far worse outcome
      // than briefly holding this thread in a context that has no UI to block.
      if (!entry) return embedText(text, modelsDir())
      return new Promise<number[]>((resolve, reject) => {
        const worker = this.spawn(entry)
        const id = this.nextId++
        this.waiting.set(id, { resolve, reject })
        worker.postMessage({ id, text } as EmbeddingRequest)
      })
    }
    const result = this.queue.then(run, run)
    // Keep the chain alive after a rejection, or one failure stalls every later request.
    this.queue = result.catch(() => undefined)
    return result
  }
}

export const embeddings = new EmbeddingService()
