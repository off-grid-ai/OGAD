import {
  pipeline,
  type DeviceType,
  type FeatureExtractionPipeline
} from '@huggingface/transformers'
import { configureTransformersEnv } from './embeddings-env'
import { loadWithOnnxFallback, onnxDeviceCandidates } from './onnx-device'
import type { BackendPreference } from '../shared/backend-preferences'

/**
 * Text -> vector. The actual inference, owned in ONE place.
 *
 * It runs in two contexts and must behave identically in both: the worker thread (production, where
 * keeping native ONNX inference off the main thread is the whole point - see embeddings-worker.ts), and
 * in-process, where there is no built worker to spawn. Sharing the implementation is what keeps the
 * second path honest: the alternative was a second copy that could drift from the one users run.
 *
 * The pipeline is cached per process, because loading it is the expensive part.
 */
let pipe: FeatureExtractionPipeline | null = null
let loading: Promise<FeatureExtractionPipeline> | null = null
let activeDevice: DeviceType | null = null

export function embeddingDevice(): DeviceType | null {
  return activeDevice
}

/** Called after serialized inference when the model is configured on demand. */
export async function disposeEmbeddingModel(): Promise<void> {
  const previous = pipe
  pipe = null
  loading = null
  activeDevice = null
  await previous?.dispose()
}

export async function embedText(
  text: string,
  modelsDir: string,
  onReady?: (device: string, reason?: string) => void,
  backendPreference: BackendPreference = 'auto'
): Promise<number[]> {
  if (!pipe) {
    configureTransformersEnv(modelsDir)
    loading ??= loadWithOnnxFallback((device) =>
      pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device }),
      onnxDeviceCandidates(process.platform, backendPreference)
    )
      .then(({ runtime, device, fallbackReason }) => {
        onReady?.(device, fallbackReason)
        activeDevice = device
        return runtime
      })
      .catch((error) => {
        loading = null
        throw error
      })
    pipe = await loading
  }
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}
