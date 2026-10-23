/**
 * Embedding inference, off the main thread.
 *
 * all-MiniLM-L6-v2 runs on the ONNX/WASM runtime, and profiling the main process showed why that
 * cannot live beside the window: tokenization and mean pooling are JS (they block the event loop),
 * and the ONNX runtime spawns its own WASM threads that compete with the UI and with llama-server
 * for cores. A startup backfill of a few dozen rows held the main process at 110% CPU with no chat
 * open and no task running.
 *
 * This worker owns the pipeline and answers one request at a time. The host (embeddings.ts) keeps
 * the queue, so back-pressure and cancellation stay a host concern and this file stays a pure
 * text-in / vector-out service.
 */
import { parentPort, workerData } from 'worker_threads'
import { embedText, embedTexts, embeddingDevice, rerankPassages } from './embeddings-core'
import { configureRuntime } from './runtime-env'
import type { BackendPreference } from '../shared/backend-preferences'
import type { EmbeddingModelId } from './embedding-model-choice'

if (!parentPort) throw new Error('embeddings-worker must be started as a worker thread')
const port = parentPort

// modelsDir() reads Electron's app paths, which do not exist in a worker thread — the host
// resolves the directory and passes it in.
const {
  modelsDir,
  chosenModelsDir,
  modelReadDirectories = [modelsDir],
  backendPreference = 'auto',
  modelId
} = workerData as {
  modelsDir: string
  chosenModelsDir?: string
  modelReadDirectories?: string[]
  backendPreference?: BackendPreference
  modelId: EmbeddingModelId
}

// Preserve the host's explicit choice without treating its default path as chosen.
configureRuntime({ modelsDir: chosenModelsDir })

export interface EmbeddingRequest {
  id: number
  text: string
  /** Several texts for one model (documents attached to chat). */
  texts?: string[]
  /** Score `texts` against this query with the cross-encoder instead of embedding them. */
  rerankQuery?: string
}
export interface EmbeddingResponse {
  id: number
  vector?: number[]
  vectors?: number[][]
  scores?: number[]
  ready?: boolean
  fallbackReason?: string
  device?: string
  error?: string
}

port.on('message', (request: EmbeddingRequest) => {
  void (async () => {
    try {
      if (request.rerankQuery !== undefined) {
        const scores = await rerankPassages(
          request.rerankQuery,
          request.texts ?? [],
          modelsDir,
          backendPreference,
          modelReadDirectories
        )
        port.postMessage({ id: request.id, scores } satisfies EmbeddingResponse)
        return
      }
      if (request.texts) {
        const vectors = await embedTexts(
          request.texts,
          modelsDir,
          backendPreference,
          modelReadDirectories
        )
        port.postMessage({ id: request.id, vectors } satisfies EmbeddingResponse)
        return
      }
      const vector = await embedText(
        request.text,
        modelsDir,
        (device, fallbackReason) => {
          port.postMessage({
            id: request.id,
            ready: true,
            device,
            fallbackReason
          } satisfies EmbeddingResponse)
        },
        backendPreference,
        modelId,
        modelReadDirectories
      )
      port.postMessage({
        id: request.id,
        vector,
        device: embeddingDevice() ?? undefined
      } as EmbeddingResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      } as EmbeddingResponse)
    }
  })()
})
