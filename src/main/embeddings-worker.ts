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
import { embedText } from './embeddings-core'

if (!parentPort) throw new Error('embeddings-worker must be started as a worker thread')
const port = parentPort

// modelsDir() reads Electron's app paths, which do not exist in a worker thread — the host
// resolves the directory and passes it in.
const { modelsDir } = workerData as { modelsDir: string }

export interface EmbeddingRequest {
  id: number
  text: string
}
export interface EmbeddingResponse {
  id: number
  vector?: number[]
  error?: string
}

port.on('message', (request: EmbeddingRequest) => {
  void (async () => {
    try {
      const vector = await embedText(request.text, modelsDir)
      port.postMessage({ id: request.id, vector } as EmbeddingResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      } as EmbeddingResponse)
    }
  })()
})
