import { parentPort, workerData } from 'node:worker_threads'
import { writeFile } from 'node:fs/promises'
import type { DeviceType, ProgressInfo } from '@huggingface/transformers'
import { KokoroTTS } from 'kokoro-js'
import { configureTransformersEnv } from './embeddings-env'
import { loadWithOnnxFallback, onnxDeviceCandidates } from './onnx-device'
import type { BackendPreference } from '../shared/backend-preferences'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

if (!parentPort) throw new Error('tts-onnx-worker must be started as a worker thread')
const port = parentPort
const { modelsDir, backendPreference = 'auto' } = workerData as { modelsDir: string; backendPreference?: BackendPreference }
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
  type: 'progress' | 'ready' | 'complete' | 'error'
  device?: string
  fallbackReason?: string
  downloadedBytes?: number
  totalBytes?: number | null
  percentage?: number | null
  currentAsset?: string
  error?: string
}

type KokoroRuntime = Awaited<ReturnType<typeof KokoroTTS.from_pretrained>>

function pcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const wav = Buffer.allocUnsafe(44 + samples.length * 2)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] || 0))
    wav.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2)
  }
  return wav
}

let loaded: { runtime: KokoroRuntime; device: DeviceType } | null = null
let loading: Promise<{ runtime: KokoroRuntime; device: DeviceType }> | null = null
const unusableDevices = new Set<DeviceType>()
const lastProgress = new Map<number, number>()

function speechDeviceCandidates(): DeviceType[] {
  const candidates = onnxDeviceCandidates(process.platform, backendPreference)
  // On Linux, CPU Kokoro is substantially faster than WebGPU when CUDA cannot
  // produce audio. Keep an explicit WebGPU choice ahead of CPU.
  if (process.platform !== 'linux' || backendPreference === 'webgpu') return candidates
  return [...candidates.filter((device) => device !== 'webgpu'), ...candidates.filter((device) => device === 'webgpu')]
}

function hasAudibleSamples(samples: Float32Array): boolean {
  if (samples.length === 0) return false
  for (const value of samples) {
    if (Number.isFinite(value) && Math.abs(value) > 0.0001) return true
  }
  return false
}

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
      // Kokoro's FP16 CUDA graph can return only NaNs on NVIDIA T4. FP32
      // produced finite, audible samples on the packaged Linux test VM.
      dtype: device === 'cpu' ? 'q8' : device === 'webgpu' || device === 'cuda' ? 'fp32' : 'fp16',
      device: device as 'cpu',
      progress_callback: (info) => reportProgress(id, info)
    })
    return runtime
  }, speechDeviceCandidates().filter((device) => !unusableDevices.has(device)))
    .then((value) => {
      port.postMessage({ id, type: 'ready', device: value.device, fallbackReason: value.fallbackReason } satisfies TtsWorkerResponse)
      loaded = value
      return value
    })
    .catch((error) => {
      loading = null
      throw error
    })
  return loading
}

async function synthesizeWithFallback(request: TtsWorkerRequest): Promise<DeviceType> {
  if (!request.text || !request.outputPath) throw new Error('Speech request is incomplete.')
  const failures: string[] = []
  const maxAttempts = speechDeviceCandidates().length
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const selected = await runtime(request.id)
    try {
      const audio = await selected.runtime.generate(request.text, {
        voice: request.voice as never,
        speed: request.speed ?? 1
      })
      if (!hasAudibleSamples(audio.data)) throw new Error('Speech engine returned silent audio.')
      // Chromium's RDP audio path can advance through float WAV data without
      // sending audible samples. PCM16 works with the RDP sink and browsers.
      await writeFile(request.outputPath, pcm16Wav(audio.data, audio.sampling_rate))
      return selected.device
    } catch (error) {
      failures.push(`${selected.device}: ${error instanceof Error ? error.message : String(error)}`)
      unusableDevices.add(selected.device)
      loaded = null
      loading = null
      await (selected.runtime as Partial<typeof selected.runtime>).model?.dispose().catch(() => {})
      if (unusableDevices.size >= maxAttempts) break
    }
  }
  throw new Error(`No speech backend produced audio. ${failures.join(' | ')}`)
}

port.on('message', (request: TtsWorkerRequest) => {
  void (async () => {
    try {
      const device = request.type === 'synthesize'
        ? await synthesizeWithFallback(request)
        : (await runtime(request.id)).device
      port.postMessage({
        id: request.id,
        type: 'complete',
        device
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
