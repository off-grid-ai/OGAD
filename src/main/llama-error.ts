// Turn llama-server's stderr into a human, actionable reason when it dies on
// load. Kept pure + Electron-free so it's unit-testable (see __tests__). The app
// otherwise shows a blank "Model installed but server is not running", which has
// led to real users (and us) guessing at code-signing when the truth was in the
// stderr the whole time — e.g. "unknown model architecture: 'gemma4'".

import { deviceNoun, type DevicePlatform } from '../shared/device'

export interface LlamaFailure {
  /** Stable code for UI/branching. */
  code:
    | 'engine_outdated'
    | 'os_too_old'
    | 'out_of_memory'
    | 'gpu_unsupported'
    | 'missing_library'
    | 'model_corrupt'
    | 'port_in_use'
    | 'unknown'
  /** One-line, user-facing explanation + what to do. */
  reason: string
}

/** One source of truth for a live second-instance conflict, whether it is detected before spawn
 * from process ownership or reported by the native engine as EADDRINUSE. */
export function modelPortConflictReason(port: number): string {
  return `Model engine port ${port} is already owned by another Off Grid AI Desktop instance. Close the other app, development server, or capture run, then restart Chat model in Settings.`
}

/**
 * True when a chat/completions failure is the model rejecting a prompt that does not fit the
 * running context window (n_ctx). Distinct from a dead/unreachable engine: retrying is useless
 * until the context is raised or the prompt shrunk, so callers treat this as TERMINAL rather
 * than backing off forever. Pure + Electron-free so it is unit-tested. llama-server phrases this
 * a few ways across versions ("the request exceeds the available context size", "input is too
 * large", "prompt is too long", "n_ctx" overflow), so match the family, not one string.
 */
export function isContextOverflowError(text: string): boolean {
  const s = (text || '').toLowerCase()
  if (!s.trim()) return false
  return (
    /exceed(s|ed)?\s+the\s+(available\s+)?context/.test(s) ||
    /context\s+(size|window|length)\s+(exceeded|too\s+small)/.test(s) ||
    /(prompt|input)\s+(is\s+)?(too\s+(long|large)|larger\s+than)/.test(s) ||
    /(tokens?|prompt)\b.*\bexceed(s|ed)?\b.*\b(n_?ctx|context)/.test(s) ||
    /requested\s+tokens.*exceed.*context/.test(s)
  )
}

/**
 * Classify the most recent llama-server stderr. Returns null if nothing in the
 * text looks like a known fatal cause (so callers can fall back to a generic
 * message). Order matters: most specific first.
 */
export function classifyLlamaError(
  stderr: string,
  platform: DevicePlatform = process.platform
): LlamaFailure | null {
  const s = (stderr || '').toLowerCase()
  if (!s.trim()) return null

  if (/eaddrinuse|address already in use|failed to (bind|listen).*port/.test(s)) {
    const port = Number(stderr.match(/(?:port\s+|:)(\d{2,5})/i)?.[1] ?? 8439)
    return {
      code: 'port_in_use',
      reason: modelPortConflictReason(port)
    }
  }

  // The model's architecture is newer than the bundled engine understands.
  // e.g. "error loading model architecture: unknown model architecture: 'gemma4'"
  if (/unknown model architecture|unsupported model architecture|unknown architecture/.test(s)) {
    const arch = stderr.match(/architecture:?\s*'([^']+)'/i)?.[1]
    return {
      code: 'engine_outdated',
      reason: arch
        ? `The model engine is too old for this model (${arch}). Update Off Grid AI, or switch to a supported model in Models.`
        : `The model engine is too old for this model. Update Off Grid AI, or switch to a supported model in Models.`
    }
  }

  // The native binary requires a newer macOS than the user is running (dyld).
  if (
    /newer than the running os|built for (mac\s?os|ios).*newer|minimum.*os.*version|dyld.*newer/.test(
      s
    )
  ) {
    return {
      code: 'os_too_old',
      reason: 'The model engine needs a newer version of macOS than this Mac is running.'
    }
  }

  // Memory pressure on load (Metal/host alloc, OOM kill).
  if (
    /failed to allocate|out of memory|insufficient memory|cannot allocate|ggml_metal.*alloc|unable to allocate|vk_error_out_of_device_memory|oom/.test(
      s
    )
  ) {
    return {
      code: 'out_of_memory',
      reason: `Out of memory - this model is too large for this ${deviceNoun(platform)}. Try a smaller model or Conservative mode.`
    }
  }

  // The GPU backend could not create a logical device because the driver does not
  // expose an extension the engine asked for. MUST stay above `model_corrupt`: the
  // same stderr carries llama.cpp's generic "failed to load model" line, so a lower
  // placement reports a working GPU-less machine as a corrupt download.
  //
  // Real capture from a hybrid-graphics Windows laptop (AMD iGPU + NVIDIA dGPU):
  //   loader_validate_device_extensions: Device extension VK_KHR_shader_bfloat16
  //     not supported by selected physical device or enabled layers
  //   vkCreateDevice: Failed to validate extensions in list
  //   llama_model_load: error loading model:
  //     vk::PhysicalDevice::createDevice: ErrorExtensionNotPresent
  if (
    /errorextensionnotpresent|loader_validate_device_extensions|failed to validate extensions in list/.test(
      s
    )
  ) {
    // Name the extension when the loader trace includes it - "your driver is missing
    // VK_KHR_shader_bfloat16" is actionable; "GPU setup failed" is not.
    const ext = stderr.match(/device extension\s+(VK_[A-Za-z0-9_]+)/i)?.[1]
    return {
      code: 'gpu_unsupported',
      reason: ext
        ? `GPU acceleration is unavailable - this graphics driver does not support ${ext}. Chat is running on the CPU engine, which is slower.`
        : 'GPU acceleration is unavailable - this graphics driver is missing a feature the GPU engine needs. Chat is running on the CPU engine, which is slower.'
    }
  }

  // A required dylib is missing or unloadable.
  if (
    /library not loaded|image not found|dyld: .*not found|no such file.*\.dylib|symbol not found/.test(
      s
    )
  ) {
    return {
      code: 'missing_library',
      reason: 'A required engine library is missing or could not be loaded.'
    }
  }

  // Corrupt / truncated weights.
  if (
    /failed to load model|invalid magic|tensor.*not found|gguf.*(invalid|corrupt|truncat)|done_getting_tensors.*wrong/.test(
      s
    )
  ) {
    return {
      code: 'model_corrupt',
      reason: 'The model file looks corrupt or incomplete. Re-download it from Models.'
    }
  }

  return null
}
