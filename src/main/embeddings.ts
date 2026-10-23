import { withStorageDownload } from './model-storage-guard'
import { beginRuntimeBackend, providerLabel } from './runtime-backends'
import path from 'path'
import { existsSync } from 'fs'
import { Worker } from 'worker_threads'
import { chosenModelsDir, modelsDir, requireModelStorage } from './runtime-env'
import { modelReadDirectories } from './model-paths'
import {
  DOCUMENT_EMBEDDER,
  DOCUMENT_RERANKER,
  disposeEmbeddingModel,
  embedText,
  embedTexts,
  embeddingDevice,
  probeEmbeddingModel,
  rerankPassages
} from './embeddings-core'
import { getResidencyMode } from './runtime-residency'
import { recordAIRequest, type AIRequestHandle } from './ai-request-log'
import type { EmbeddingRequest, EmbeddingResponse } from './embeddings-worker'
import { writeDiagnosticLog } from './diagnostics-log'
import { getBackendPreference } from './backend-preferences'
import {
  getEmbeddingModelId,
  saveEmbeddingModelId,
  type EmbeddingModelId
} from './embedding-model-choice'

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
    {
      resolve: (response: EmbeddingResponse) => void
      reject: (e: Error) => void
      log: AIRequestHandle
    }
  >()
  /** Settles once every request scheduled so far has finished; shutdown waits on it. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Requests waiting for the worker, one at a time. Interactive ones (a search someone is waiting
   *  on) go ahead of background indexing, which can queue hundreds. */
  private readonly pending: { interactive: boolean; start: () => void }[] = []
  private running = false
  private reportedDevice: string | null = null
  private shuttingDown = false

  /** Stop the worker before Electron destroys its Node environment, including a cold model load. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const worker = this.worker
    this.worker = null
    if (worker) {
      for (const pending of this.waiting.values()) {
        pending.reject(new Error('Embedding runtime is shutting down.'))
      }
      this.waiting.clear()
      await worker.terminate()
    }
    // Queued requests see shuttingDown and cannot start another worker. The source-only
    // fallback has no worker to terminate, so let its active inference finish before disposal.
    await this.queue
    if (!worker) await disposeEmbeddingModel()
    this.reportedDevice = null
  }

  private spawn(entry: string): Worker {
    if (this.worker) return this.worker
    // Built entries sit side by side in out/main (electron.vite.config.ts), but tests and any
    // run-from-source context have only the .ts next to this file. Resolve whichever EXISTS rather
    // than assuming the built layout: assuming it made every embedding fail outside a packaged
    // build, which silently demoted vector search to the FTS fallback instead of erroring.
    const modelId = getEmbeddingModelId()
    const backendState = beginRuntimeBackend('embeddings', modelId)
    const worker = new Worker(entry, {
      workerData: {
        modelsDir: modelsDir(),
        chosenModelsDir: chosenModelsDir(),
        modelReadDirectories: modelReadDirectories(),
        backendPreference: getBackendPreference('embeddings'),
        modelId
      }
    })
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
      else pending.resolve(response)
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

  /** Wait for current inference, replace its worker, then publish the new choice. */
  async switchModel(id: EmbeddingModelId, dimensions = 384): Promise<void> {
    const switchAfterCurrent = async (): Promise<void> => {
      const worker = this.worker
      this.worker = null
      if (worker) await worker.terminate()
      else await disposeEmbeddingModel()
      this.reportedDevice = null
      saveEmbeddingModelId(id, dimensions)
    }
    const result = this.queue.then(switchAfterCurrent, switchAfterCurrent)
    this.queue = result.catch(() => undefined)
    await result
  }

  /** Load a candidate separately, so a failed choice leaves the active worker untouched. */
  async probeModel(id: EmbeddingModelId): Promise<number> {
    requireModelStorage()
    const entry = builtWorkerEntry()
    if (!entry) return probeEmbeddingModel(id, modelsDir())
    const worker = new Worker(entry, {
      workerData: {
        modelsDir: modelsDir(),
        backendPreference: 'cpu',
        modelId: id
      }
    })
    try {
      const vector = await new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Model check timed out.')), 300_000)
        const done = (callback: () => void): void => {
          clearTimeout(timer)
          callback()
        }
        worker.on('message', (response: EmbeddingResponse) => {
          if (response.ready) return
          if (response.error) done(() => reject(new Error(response.error)))
          else done(() => resolve(response.vector ?? []))
        })
        worker.once('error', (error) => done(() => reject(error)))
        worker.once('exit', (code) =>
          done(() => reject(new Error(`Model check stopped (${code}).`)))
        )
        worker.postMessage({
          id: 0,
          text: 'Off Grid AI embedding check'
        } satisfies EmbeddingRequest)
      })
      if (
        !vector.length ||
        vector.length > 4096 ||
        vector.some((value) => !Number.isFinite(value))
      ) {
        throw new Error('This model returned an invalid embedding.')
      }
      return vector.length
    } finally {
      await worker.terminate()
    }
  }

  /** `interactive`: someone is waiting on this vector (a search), so it runs before background
   *  indexing that is already queued. */
  async generateEmbedding(text: string, opts: { interactive?: boolean } = {}): Promise<number[]> {
    // A cold worker may download its model while handling its first embedding.
    return withStorageDownload(() => this.generateEmbeddingInner(text, opts.interactive === true))
  }

  /** Run `task` when the worker is free, interactive requests first, then in arrival order. */
  private schedule<T>(task: () => Promise<T>, interactive: boolean): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      const start = (): void => {
        void task()
          .then(resolve, reject)
          .finally(() => {
            this.running = false
            this.pump()
          })
      }
      const entry = { interactive, start }
      const firstBackground = interactive ? this.pending.findIndex((p) => !p.interactive) : -1
      if (firstBackground >= 0) this.pending.splice(firstBackground, 0, entry)
      else this.pending.push(entry)
      this.pump()
    })
    this.queue = Promise.allSettled([this.queue, result])
    return result
  }

  private pump(): void {
    if (this.running) return
    const next = this.pending.shift()
    if (!next) return
    this.running = true
    next.start()
  }

  private async generateEmbeddingInner(text: string, interactive: boolean): Promise<number[]> {
    if (this.shuttingDown) throw new Error('Embedding runtime is shutting down.')
    return recordAIRequest(
      {
        modality: 'embedding',
        source: text ? 'Embedding' : 'Embedding warm-up',
        model: getEmbeddingModelId(),
        request: { text, pooling: 'mean', normalize: true }
      },
      async (log) => {
        const run = (): Promise<number[]> => {
          if (this.shuttingDown) throw new Error('Embedding runtime is shutting down.')
          const entry = builtWorkerEntry()
          // No built worker means we are running from source. Embed here rather than failing: a failed
          // embedding silently demotes every search to the FTS fallback, which is a far worse outcome
          // than briefly holding this thread in a context that has no UI to block.
          if (!entry)
            return embedText(
              text,
              modelsDir(),
              (device, reason) => {
                beginRuntimeBackend('embeddings', getEmbeddingModelId()).ready(
                  providerLabel(device),
                  undefined,
                  reason
                )
              },
              getBackendPreference('embeddings'),
              getEmbeddingModelId(),
              modelReadDirectories()
            )
          return this.post({ id: this.nextId++, text }, entry, log).then((r) => r.vector ?? [])
        }
        const vector = await this.schedule(() => this.withResidency(run), interactive)
        log.update({
          backend: this.reportedDevice ?? embeddingDevice() ?? 'Unknown',
          metrics: { dimensions: vector.length }
        })
        return vector
      }
    )
  }

  private post(
    request: EmbeddingRequest,
    entry: string,
    log: AIRequestHandle
  ): Promise<EmbeddingResponse> {
    return new Promise<EmbeddingResponse>((resolve, reject) => {
      const worker = this.spawn(entry)
      this.waiting.set(request.id, { resolve, reject, log })
      worker.postMessage(request)
    })
  }

  /** Long jobs (a document ingest) hold the model loaded between their requests. */
  private holds = 0

  /** Keep the worker and models loaded until the returned release is called, even on demand. */
  hold(): () => void {
    this.holds++
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds--
      if (!this.holds && getResidencyMode('embeddings') === 'on-demand' && !this.running) {
        void this.schedule(() => this.withResidency(async () => undefined), false)
      }
    }
  }

  private async withResidency<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } finally {
      if (getResidencyMode('embeddings') === 'on-demand' && !this.holds) {
        const worker = this.worker
        this.worker = null
        if (worker) await worker.terminate()
        else await disposeEmbeddingModel()
        this.reportedDevice = null
      }
    }
  }

  /**
   * Vectors for passages of documents attached to chat, with the multilingual document model.
   * Background work unless `interactive` (a question is waiting on a query vector).
   */
  async embedDocumentTexts(
    texts: string[],
    opts: { interactive?: boolean; source?: string } = {}
  ): Promise<number[][]> {
    if (!texts.length) return []
    return withStorageDownload(() =>
      this.runModel(
        texts.length === 1
          ? { text: texts[0], model: DOCUMENT_EMBEDDER }
          : { passages: texts.length, characters: texts.reduce((sum, t) => sum + t.length, 0) },
        (entry, log) =>
          entry
            ? this.post(
                { id: this.nextId++, text: '', texts },
                entry,
                log
              ).then((r) => r.vectors ?? [])
            : embedTexts(
                texts,
                modelsDir(),
                getBackendPreference('embeddings'),
                modelReadDirectories()
              ),
        opts.interactive === true,
        DOCUMENT_EMBEDDER,
        opts.source ?? (texts.length === 1 ? 'Document question embedding' : 'Document indexing')
      )
    )
  }

  /** Cross-encoder relevance of each passage to the query, same order. Someone is waiting on it. */
  async rerank(query: string, passages: string[]): Promise<number[]> {
    if (!passages.length) return []
    return withStorageDownload(() =>
      this.runModel(
        { query, passages: passages.length },
        (entry, log) =>
          entry
            ? this.post(
                { id: this.nextId++, text: '', texts: passages, rerankQuery: query },
                entry,
                log
              ).then((r) => r.scores ?? [])
            : rerankPassages(
                query,
                passages,
                modelsDir(),
                getBackendPreference('embeddings'),
                modelReadDirectories()
              ),
        true,
        DOCUMENT_RERANKER,
        'Document reranking'
      )
    )
  }

  private async runModel<T>(
    request: Record<string, unknown>,
    run: (entry: string | null, log: AIRequestHandle) => Promise<T>,
    interactive: boolean,
    model: string,
    source: string
  ): Promise<T> {
    if (this.shuttingDown) throw new Error('Embedding runtime is shutting down.')
    return recordAIRequest({ modality: 'embedding', source, model, request }, async (log) => {
      const result = await this.schedule(
        () =>
          this.withResidency(() => {
            if (this.shuttingDown) throw new Error('Embedding runtime is shutting down.')
            return run(builtWorkerEntry(), log)
          }),
        interactive
      )
      log.update({ backend: this.reportedDevice ?? embeddingDevice() ?? 'Unknown' })
      return result
    })
  }
}

export const embeddings = new EmbeddingService()
