// Which accelerator the running `llama-server` offloads to, and the copy that says so.
//
// The app ships Metal engines on macOS and CUDA, Vulkan, and CPU engine variants
// on Windows/Linux. llm.ts chooses the first usable engine for the device.
// llm.ts already decides between them at spawn,
// so that decision is the only thing entitled to name the accelerator. Pure, and the
// platform is injected rather than read, so every OS is asserted rather than inferred
// from the host running the tests.

export type EngineAccelerator = 'Metal' | 'CUDA' | 'Vulkan' | 'CPU'

/** Directory holding the standard CPU-only engine. Must match the fetch/stage destination. */
export const CPU_ENGINE_DIR = 'llama-cpu'

export interface EngineAcceleratorInput {
  /** Target platform. Injected, never read from `process` here. */
  platform: NodeJS.Platform
  /** Full path of the engine binary that actually loaded the model. */
  serverPath: string
  /** Confirmed offloaded layer count; null means the GPU load was not confirmed. */
  gpuLayers?: number | null
}

/**
 * The accelerator the engine at this path uses, or null when we cannot name it.
 *
 * null is not a failure. Unknown platforms do not claim an accelerator.
 */
export function acceleratorForEngine(i: EngineAcceleratorInput): EngineAccelerator | null {
  if (!i.serverPath) return null
  const engineDir = i.serverPath.replace(/\\/g, '/').split('/').at(-2) ?? ''
  if (engineDir.endsWith('-cpu')) return 'CPU'
  if (i.gpuLayers === 0) return 'CPU'
  if (i.gpuLayers === null) return null
  if (i.platform === 'darwin') return 'Metal'
  if (i.platform === 'win32' || i.platform === 'linux') {
    if (engineDir.endsWith('-cuda')) return 'CUDA'
    if (engineDir === 'llama' || engineDir === 'llama-prism') return 'Vulkan'
  }
  return null
}

/**
 * The hint under the GPU-layers slider. The CPU case gets its own sentence: the slider
 * moves nothing there, and a user who has fallen back deserves to know why.
 */
export function gpuLayersHint(accelerator: EngineAccelerator | null): string {
  if (accelerator === 'CPU') {
    return 'This engine runs on the CPU, so this setting changes nothing.'
  }
  const api = accelerator ? ` (${accelerator})` : ''
  return `Layers offloaded to the GPU${api}. 99 = all. Lower only if you hit GPU-memory issues.`
}
