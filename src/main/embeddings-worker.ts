/**
 * Embedding inference, in its own utility process (onnx-host/utility-host.ts).
 *
 * all-MiniLM-L6-v2 runs on the ONNX/WASM runtime, and profiling the main process showed why that
 * cannot live beside the window: tokenization and mean pooling are JS (they block the event loop),
 * and the ONNX runtime spawns its own WASM threads that compete with the UI and with llama-server
 * for cores. A startup backfill of a few dozen rows held the main process at 110% CPU with no chat
 * open and no task running.
 *
 * This helper process owns the pipeline and answers one request at a time. The host (embeddings.ts) keeps
 * the queue, so back-pressure and cancellation stay a host concern and this file stays a pure
 * text-in / vector-out service.
 */
import { DEFAULT_EMBEDDER, embedTexts, embeddingDevice, rerankPassages } from './embeddings-core'
import { configureRuntime } from './runtime-env'
import type { OnnxDevice } from '@offgrid/models'
import { connectHelper, type HelperPort } from './onnx-host/helper-port'

// modelsDir() reads Electron's app paths, which a helper process does not have — the host
// resolves the directories and sends them as the first message.
export interface EmbeddingWorkerInit {
  modelsDir: string
  chosenModelsDir?: string
  modelReadDirectories?: string[]
  devices: OnnxDevice[]
}

let port: HelperPort<EmbeddingRequest>
let modelsDir = ''
let modelReadDirectories: string[] = []
let devices: OnnxDevice[] = ['cpu']

export interface EmbeddingRequest {
  id: number
  /** The texts to embed, or to score against `rerankQuery`. */
  texts: string[]
  /** The sentence embedder (embeddings-core EMBEDDERS); DEFAULT_EMBEDDER when absent. */
  model?: string
  /** Score `texts` against this query with the cross-encoder instead of embedding them. */
  rerankQuery?: string
}
export interface EmbeddingResponse {
  id: number
  vectors?: number[][]
  scores?: number[]
  ready?: boolean
  fallbackReason?: string
  device?: string
  error?: string
}

function handle(request: EmbeddingRequest): void {
  void (async () => {
    try {
      if (request.rerankQuery !== undefined) {
        const scores = await rerankPassages(
          request.rerankQuery,
          request.texts,
          modelsDir,
          devices,
          modelReadDirectories
        )
        port.post({ id: request.id, scores } satisfies EmbeddingResponse)
        return
      }
      const vectors = await embedTexts(
        request.texts,
        request.model ?? DEFAULT_EMBEDDER.model,
        modelsDir,
        (device, fallbackReason) => {
          port.post({
            id: request.id,
            ready: true,
            device,
            fallbackReason
          } satisfies EmbeddingResponse)
        },
        devices,
        modelReadDirectories
      )
      port.post({
        id: request.id,
        vectors,
        device: embeddingDevice() ?? undefined
      } satisfies EmbeddingResponse)
    } catch (error) {
      port.post({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      } satisfies EmbeddingResponse)
    }
  })()
}

void connectHelper<EmbeddingWorkerInit, EmbeddingRequest>().then(({ init, port: connected }) => {
  port = connected
  modelsDir = init.modelsDir
  modelReadDirectories = init.modelReadDirectories ?? [init.modelsDir]
  devices = init.devices
  // Preserve the host's explicit choice without treating its default path as chosen.
  configureRuntime({ modelsDir: init.chosenModelsDir })
  port.onRequest(handle)
})
