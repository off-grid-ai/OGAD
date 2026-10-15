import type { DeviceType } from '@huggingface/transformers'

export interface LoadedOnnxRuntime<T> {
  runtime: T
  device: DeviceType
  fallbackReason?: string
}

export async function loadWithOnnxFallback<T>(
  load: (device: DeviceType) => Promise<T>,
  candidates: DeviceType[]
): Promise<LoadedOnnxRuntime<T>> {
  const failures: string[] = []
  for (const device of candidates) {
    try {
      const runtime = await load(device)
      console.log(`[ONNX] selected provider=${device}`)
      return {
        runtime,
        device,
        ...(failures.length ? { fallbackReason: failures.join('; ') } : {})
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${device}: ${message}`)
      console.warn(`[ONNX] provider ${device} failed; trying next provider: ${message}`)
    }
  }
  throw new Error(`No ONNX Runtime provider could start. ${failures.join(' | ')}`)
}
