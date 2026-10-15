import { beginRuntimeBackend, providerLabel } from './runtime-backends'
import { currentAIRequest, type AIRequestHandle } from './ai-request-log'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { clearHelperCrashes, forkHelper, type HelperProcess } from './onnx-host/utility-host'
import type { DownloadProgress } from '@offgrid/executorch-speech'
import { modelsDir } from './runtime-env'
import { modelReadDirectories } from './model-paths'
import type { TtsWorkerInit, TtsWorkerResponse } from './tts-onnx-worker'
import { onnxLadder } from './backend-facts'

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
  log?: AIRequestHandle
  voice: string
  resolve: (device: string) => void
  reject: (error: Error) => void
  onProgress?: (progress: DownloadProgress) => void
}

const SERVICE_NAME = 'offgrid-voice'

function workerEntry(): string | null {
  const built = path.join(__dirname, 'tts-onnx-worker.js')
  return existsSync(built) ? built : null
}

export class OnnxSpeechRuntime {
  private worker: HelperProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()

  private spawn(): HelperProcess {
    if (this.worker) return this.worker
    const entry = workerEntry()
    if (!entry) throw new Error('The ONNX speech worker is not built.')
    const backendState = beginRuntimeBackend('speech', 'Kokoro')
    let worker: HelperProcess
    try {
      worker = forkHelper(
        entry,
        {
          modelsDir: modelsDir(),
          modelReadDirectories: modelReadDirectories(),
          devices: onnxLadder('tts')
        } satisfies TtsWorkerInit,
        { serviceName: SERVICE_NAME, label: 'Voice' }
      )
    } catch (error) {
      backendState.fail(error)
      throw error
    }
    worker.on('message', (response: TtsWorkerResponse) => {
      if (response.type === 'ready') {
        backendState.ready(providerLabel(response.device!), undefined, response.fallbackReason)
        return
      }
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
      backendState.recordRequest(pending.log)
      if (response.type === 'error')
        pending.reject(new Error(response.error || 'ONNX speech failed.'))
      else pending.resolve(response.device || 'cpu')
    })
    const fail = (error: Error): void => {
      backendState.fail(error)
      if (this.worker !== worker) return
      this.worker = null
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
    worker.on('exit', (code) => {
      if (this.worker !== worker) {
        backendState.stop()
        return
      }
      if (code !== 0) fail(new Error(`The voice helper stopped (exit code ${code}).`))
      else {
        backendState.stop()
        this.worker = null
      }
    })
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
      this.pending.set(id, {
        voice: message.voice,
        resolve,
        reject,
        onProgress,
        log: currentAIRequest()
      })
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

  /** True while a voice helper process is running. */
  get isRunning(): boolean {
    return this.worker !== null
  }

  /** Start the next request on a fresh helper with the current backend choice and environment.
   *  Waits up to 10 s for requests in flight. */
  async restart(): Promise<void> {
    clearHelperCrashes(SERVICE_NAME)
    const deadline = Date.now() + 10_000
    while (this.pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await this.close()
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = null
    if (!worker) return
    for (const request of this.pending.values())
      request.reject(new Error('Speech runtime unloaded.'))
    this.pending.clear()
    await worker.terminate()
  }
}
