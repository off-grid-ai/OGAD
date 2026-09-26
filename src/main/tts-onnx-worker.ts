import { parentPort, workerData } from 'node:worker_threads'
import type { DeviceType, ProgressInfo } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
import { configureTransformersEnv } from './embeddings-env'
import { loadWithOnnxFallback } from './onnx-device'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

if (!parentPort) throw new Error('tts-onnx-worker must be started as a worker thread')
const port = parentPort
const { modelsDir } = workerData as { modelsDir: string }
configureTransformersEnv(modelsDir)

interface TtsWorkerRequest {
  id: number
  type: 'prepare' | 'synthesize'
  text?: string
  voice: string
  outputPath?: string
  speed?: number
}

export interface TtsWorkerResponse {
  id: number
  type: 'progress' | 'complete' | 'error'
  device?: string
  downloadedBytes?: number
  totalBytes?: number | null
  percentage?: number | null
  currentAsset?: string
  error?: string
}

type KokoroRuntime = Awaited<ReturnType<typeof KokoroTTS.from_pretrained>>
let loaded: { runtime: KokoroRuntime; device: DeviceType } | null = null
let loading: Promise<{ runtime: KokoroRuntime; device: DeviceType }> | null = null
const lastProgress = new Map<number, number>()

function reportProgress(id: number, info: ProgressInfo): void {
  if (info.status === 'progress_total' || info.status === 'progress') {
    const percentage = Math.max(0, Math.min(100, Math.floor(info.progress)))
    if (lastProgress.get(id) === percentage) return
    lastProgress.set(id, percentage)
    port.postMessage({
      id,
      type: 'progress',
      downloadedBytes: info.loaded,
      totalBytes: info.total,
      percentage,
      currentAsset: info.status === 'progress' ? info.file : 'kokoro-onnx'
    } satisfies TtsWorkerResponse)
  }
}

async function runtime(id: number): Promise<{ runtime: KokoroRuntime; device: DeviceType }> {
  if (loaded) return loaded
  loading ??= loadWithOnnxFallback(async (device) => {
    // kokoro-js predates the newer ONNX Runtime provider names in its declaration
    // file. Its runtime forwards this value to Transformers.js, which supports
    // Core ML, DirectML, CUDA, WebGPU, and CPU.
    const runtime = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: device === 'cpu' ? 'q8' : device === 'webgpu' ? 'fp32' : 'fp16',
      device: device as 'cpu',
      progress_callback: (info) => reportProgress(id, info)
    })
    return runtime
  }).then((value) => {
    loaded = value
    return value
  })
  return loading
}

port.on('message', (request: TtsWorkerRequest) => {
  void (async () => {
    try {
      const selected = await runtime(request.id)
      if (request.type === 'synthesize') {
        if (!request.text || !request.outputPath) throw new Error('Speech request is incomplete.')
        const audio = await selected.runtime.generate(request.text, {
          voice: request.voice as never,
          speed: request.speed ?? 1
        })
        await audio.save(request.outputPath)
      }
      port.postMessage({
        id: request.id,
        type: 'complete',
        device: selected.device
      } satisfies TtsWorkerResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        type: 'error',
        error: error instanceof Error ? error.message : String(error)
      } satisfies TtsWorkerResponse)
    }
  })()
})
