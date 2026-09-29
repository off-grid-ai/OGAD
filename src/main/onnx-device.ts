import type { DeviceType } from '@huggingface/transformers'
import { prioritizeBackend, type BackendPreference } from '../shared/backend-preferences'

/**
 * Try one accelerator at a time. ONNX Runtime does not always continue to the
 * next provider when a GPU provider is installed but its driver/runtime cannot
 * start, so the caller must create a fresh session for each candidate.
 */
export function onnxDeviceCandidates(
  platform = process.platform,
  preference: BackendPreference = 'auto'
): DeviceType[] {
  const accelerated: DeviceType[] =
    platform === 'darwin'
      ? ['coreml', 'webgpu']
      : platform === 'win32'
        ? ['dml', 'webgpu']
        : platform === 'linux'
          ? ['cuda', 'webgpu']
          : ['webgpu']

  return prioritizeBackend([...accelerated, 'cpu'], preference, (device) =>
    device === 'coreml' ? 'metal' : device === 'dml' ? 'directml' : device as BackendPreference
  )
}

export interface LoadedOnnxRuntime<T> {
  runtime: T
  device: DeviceType
  fallbackReason?: string
}

export async function loadWithOnnxFallback<T>(
  load: (device: DeviceType) => Promise<T>,
  candidates = onnxDeviceCandidates()
): Promise<LoadedOnnxRuntime<T>> {
  const failures: string[] = []
  for (const device of candidates) {
    try {
      const runtime = await load(device)
      console.log(`[ONNX] selected provider=${device}`)
      return { runtime, device, ...(failures.length ? { fallbackReason: failures.join('; ') } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${device}: ${message}`)
      console.warn(`[ONNX] provider ${device} failed; trying next provider: ${message}`)
    }
  }
  throw new Error(`No ONNX Runtime provider could start. ${failures.join(' | ')}`)
}
