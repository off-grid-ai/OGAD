// Which accelerator the running `llama-server` offloads to, and the copy that says so.
//
// The app ships a DIFFERENT engine per platform (scripts/build-llama.sh builds Metal
// on macOS; scripts/fetch-win-binaries.ps1 fetches a Vulkan build into bin/llama and a
// CPU-only fallback into bin/llama-cpu). llm.ts already decides between them at spawn,
// so that decision is the only thing entitled to name the accelerator. Pure, and the
// platform is injected rather than read, so every OS is asserted rather than inferred
// from the host running the tests.

import path from 'path'

export type EngineAccelerator = 'Metal' | 'Vulkan' | 'CPU'

/** Directory holding the CPU-only engine. Windows falls through to it when the box has
 *  no Vulkan loader. Must match the `Copy-Runtime ... 'llama-cpu'` destination. */
export const CPU_ENGINE_DIR = 'llama-cpu'

export interface EngineAcceleratorInput {
  /** Target platform. Injected, never read from `process` here. */
  platform: NodeJS.Platform
  /** Full path of the engine binary that actually loaded the model. */
  serverPath: string
}

/**
 * The accelerator the engine at this path uses, or null when we cannot name it.
 *
 * null is not a failure. Linux ships no engine of ours, so the binary under bin/llama
 * is whatever the user built, and naming an API there would be a guess. The UI drops
 * the API name in that case rather than state one we do not know.
 */
export function acceleratorForEngine(i: EngineAcceleratorInput): EngineAccelerator | null {
  if (!i.serverPath) return null
  if (path.basename(path.dirname(i.serverPath)) === CPU_ENGINE_DIR) return 'CPU'
  if (i.platform === 'darwin') return 'Metal'
  if (i.platform === 'win32') return 'Vulkan'
  return null
}

/**
 * The hint under the GPU-layers slider. The CPU case gets its own sentence: the slider
 * moves nothing there, and a user who has fallen back deserves to know why.
 */
export function gpuLayersHint(accelerator: EngineAccelerator | null): string {
  if (accelerator === 'CPU') {
    return 'This machine has no Vulkan driver, so the model runs on the CPU and this setting changes nothing.'
  }
  const api = accelerator ? ` (${accelerator})` : ''
  return `Layers offloaded to the GPU${api}. 99 = all. Lower only if you hit GPU-memory issues.`
}
