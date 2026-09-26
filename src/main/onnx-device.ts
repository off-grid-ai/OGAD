import type { DeviceType } from '@huggingface/transformers'

/**
 * Try one accelerator at a time. ONNX Runtime does not always continue to the
 * next provider when a GPU provider is installed but its driver/runtime cannot
 * start, so the caller must create a fresh session for each candidate.
 */
export function onnxDeviceCandidates(platform = process.platform): DeviceType[] {
  const accelerated: DeviceType[] =
    platform === 'darwin'
      ? ['coreml', 'webgpu']
      : platform === 'win32'
        ? ['dml', 'webgpu']
        : platform === 'linux'
          ? ['cuda', 'webgpu']
          : ['webgpu']

  return [...accelerated, 'cpu']
}

export interface LoadedOnnxRuntime<T> {
  runtime: T
  device: DeviceType
}

export async function loadWithOnnxFallback<T>(
  load: (device: DeviceType) => Promise<T>,
  candidates = onnxDeviceCandidates()
): Promise<LoadedOnnxRuntime<T>> {
  const failures: string[] = []
  for (const device of candidates) {
    try {
      return { runtime: await load(device), device }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${device}: ${message}`)
    }
  }
  throw new Error(`No ONNX Runtime provider could start. ${failures.join(' | ')}`)
}
