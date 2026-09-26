import { existsSync } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { DownloadProgress } from '@offgrid/executorch-speech'
import { modelsDir } from './runtime-env'
import type { TtsWorkerResponse } from './tts-onnx-worker'

export interface OnnxSynthesisInput {
  text: string
  voice: string
  outputPath: string
  speed?: number
  onProgress?: (progress: DownloadProgress) => void
}

interface TtsWorkerMessage {
  type: 'prepare' | 'synthesize'
  voice: string
  text?: string
  outputPath?: string
  speed?: number
}

interface PendingRequest {
  voice: string
  resolve: (device: string) => void
  reject: (error: Error) => void
  onProgress?: (progress: DownloadProgress) => void
}

function workerEntry(): string | null {
  const built = path.join(__dirname, 'tts-onnx-worker.js')
  return existsSync(built) ? built : null
}

export class OnnxSpeechRuntime {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  private spawn(): Worker {
    if (this.worker) return this.worker
    const entry = workerEntry()
    if (!entry) throw new Error('The ONNX speech worker is not built.')
    const worker = new Worker(entry, { workerData: { modelsDir: modelsDir() } })
    worker.on('message', (response: TtsWorkerResponse) => {
      const pending = this.pending.get(response.id)
      if (!pending) return
      if (response.type === 'progress') {
        pending.onProgress?.({
          voiceId: pending.voice,
          downloadedBytes: response.downloadedBytes ?? 0,
          totalBytes: response.totalBytes ?? null,
          percentage: response.percentage ?? null,
          currentAsset: response.currentAsset ?? 'kokoro-onnx'
        })
        return
      }
      this.pending.delete(response.id)
      if (response.type === 'error') pending.reject(new Error(response.error || 'ONNX speech failed.'))
      else pending.resolve(response.device || 'cpu')
    })
    const fail = (error: Error): void => {
      this.worker = null
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (code !== 0) fail(new Error(`ONNX speech worker exited with code ${code}.`))
      else this.worker = null
    })
    worker.unref()
    this.worker = worker
    return worker
  }

  private request(
    message: TtsWorkerMessage,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<string> {
    const worker = this.spawn()
    const id = this.nextId++
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { voice: message.voice, resolve, reject, onProgress })
      worker.postMessage({ ...message, id })
    })
  }

  prepare(voice: string, onProgress?: (progress: DownloadProgress) => void): Promise<string> {
    return this.request({ type: 'prepare', voice }, onProgress)
  }

  synthesize(input: OnnxSynthesisInput): Promise<string> {
    return this.request(
      {
        type: 'synthesize',
        voice: input.voice,
        text: input.text,
        outputPath: input.outputPath,
        speed: input.speed
      },
      input.onProgress
    )
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    await worker.terminate()
  }
}
