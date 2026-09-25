// Single source of truth for the ENVIRONMENT `llama-server` is spawned with, the
// counterpart to buildLaunchArgs()'s ownership of the argv. Pure (no electron, no
// process.platform read) so every platform's env is asserted directly instead of
// being inferred from the host the tests happen to run on.

import path from 'path'

/**
 * ggml-vulkan's opt-out for `VK_KHR_shader_bfloat16`. Set on Windows ONLY.
 *
 * Why: on a hybrid-graphics Windows laptop (AMD iGPU + NVIDIA dGPU), the Vulkan
 * stack ADVERTISES this extension through `vkEnumerateDeviceExtensionProperties`
 * and then REJECTS the same string at `vkCreateDevice`:
 *
 *   ERROR: loader_validate_device_extensions: Device extension
 *          VK_KHR_shader_bfloat16 not supported by selected physical device
 *   ERROR: vkCreateDevice: Failed to validate extensions in list
 *
 * ggml-vulkan requests it only when enumeration claims it exists (ggml-vulkan.cpp
 * `bfloat16_support`), so the request is legitimate - the Vulkan stack is
 * self-inconsistent, most likely the switchable-graphics proxy layer that
 * `vulkaninfo` reports as API 1.3 under a 1.4 app. The failure is NOT
 * model-specific (a GGUF with zero bf16 tensors fails identically), NOT
 * device-specific (both GPUs fail), and NOT layer-specific
 * (`VK_LOADER_LAYERS_DISABLE=*` changes nothing, because the switchable-graphics
 * and Optimus layers ship via the driver's own manifest path, not the registry's
 * ImplicitLayers values). Without this var, `vkCreateDevice` fails for every
 * Windows user whose driver does not truly implement bf16 shaders - which today
 * is nearly all of them, since only NVIDIA BETA drivers ship it - and the app
 * silently drops to the CPU engine.
 *
 * Cost of disabling: nothing for our workload. It gates bf16-specific kernels
 * only; our GGUFs carry no bf16 tensors, and mat-vec multiply promotes bf16 to
 * fp32 without the extension anyway.
 *
 * TRAP: ggml-vulkan tests this with `!getenv(...)`, so ANY value disables bf16 -
 * including the string "0". Re-enabling requires UNSETTING the variable. Never
 * ship a control that writes "0" expecting to turn bf16 back on.
 */
export const VULKAN_DISABLE_BFLOAT16 = 'GGML_VK_DISABLE_BFLOAT16'

export interface EngineSpawnEnvInput {
  /** Target platform. Injected, never read from `process` here, so tests cover every OS. */
  platform: NodeJS.Platform
  /** Directory holding the engine binary and its co-located libraries. */
  binDir: string
  /** The inherited environment the overrides are layered onto. */
  currentEnv?: Record<string, string | undefined>
}

/**
 * The env OVERRIDES for a `llama-server` spawn - the caller layers these over the
 * inherited environment. Returns only the keys this platform needs, so a macOS
 * spawn can be asserted to carry no Vulkan variable at all.
 */
export function engineSpawnEnv(i: EngineSpawnEnvInput): Record<string, string> {
  const pathApi = i.platform === 'win32' ? path.win32 : path.posix
  const cudaRuntimeDir = i.binDir.endsWith('-cuda')
    ? pathApi.join(pathApi.dirname(i.binDir), 'cuda-runtime')
    : null
  if (i.platform === 'linux') {
    const inherited = i.currentEnv ?? {}
    const libraryDirs = cudaRuntimeDir ? [i.binDir, cudaRuntimeDir] : [i.binDir]
    if (inherited.LD_LIBRARY_PATH) libraryDirs.push(inherited.LD_LIBRARY_PATH)
    return {
      LD_LIBRARY_PATH: libraryDirs.join(path.posix.delimiter)
    }
  }
  const env: Record<string, string> = {
    // macOS: rpath for the co-located dylibs. Harmless elsewhere.
    DYLD_LIBRARY_PATH: i.binDir
  }
  if (i.platform !== 'win32') return env

  // Windows: the loader already searches the exe's own dir for DLLs, but prepend
  // binDir to PATH so the ggml/llama DLLs resolve even if that is restricted.
  const inherited = i.currentEnv ?? {}
  env.PATH = `${[i.binDir, ...(cudaRuntimeDir ? [cudaRuntimeDir] : []), inherited.PATH ?? ''].join(path.win32.delimiter)}`
  // Respect an explicit choice already in the environment (present-vs-absent is
  // the only override that works - see the TRAP note above).
  if (inherited[VULKAN_DISABLE_BFLOAT16] === undefined) {
    env[VULKAN_DISABLE_BFLOAT16] = '1'
  }
  return env
}
