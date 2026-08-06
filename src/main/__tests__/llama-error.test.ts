/**
 * Guards the llama-server failure classifier. The motivating bug: a shipped
 * build's bundled engine couldn't parse newer model archs and exited with
 * "unknown model architecture: 'gemma4'", but the app showed a blank
 * "Model installed but server is not running" — so it got misdiagnosed as a
 * code-signing problem for days. This maps the real stderr to a clear reason.
 */
import { describe, it, expect } from 'vitest'
import { classifyLlamaError, isContextOverflowError } from '../llama-error'

describe('classifyLlamaError', () => {
  it('flags an engine too old for the model architecture (the reported bug)', () => {
    const stderr = `llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'gemma4'
common_init_from_params: failed to load model 'gemma-4-E4B-it-Q4_K_M.gguf'
main: exiting due to model loading error`
    const f = classifyLlamaError(stderr)
    expect(f?.code).toBe('engine_outdated')
    expect(f?.reason).toMatch(/too old/i)
    expect(f?.reason).toMatch(/gemma4/) // names the offending arch
  })

  it('handles qwen35 too', () => {
    expect(classifyLlamaError("unknown model architecture: 'qwen35'")?.code).toBe('engine_outdated')
  })

  it('flags a macOS-too-old (dyld) failure', () => {
    expect(
      classifyLlamaError('dyld: ... was built for newer macOS version than being run')?.code
    ).toBe('os_too_old')
  })

  it('flags out-of-memory on load', () => {
    expect(
      classifyLlamaError('ggml_metal_buffer: failed to allocate buffer, size = 9216.00 MiB')?.code
    ).toBe('out_of_memory')
  })

  it('names the machine per platform in the OOM reason (Mac on macOS, device elsewhere)', () => {
    const oom = 'ggml_metal_buffer: failed to allocate buffer, size = 9216.00 MiB'
    expect(classifyLlamaError(oom, 'darwin')?.reason).toContain('too large for this Mac')
    expect(classifyLlamaError(oom, 'win32')?.reason).toContain('too large for this device')
    expect(classifyLlamaError(oom, 'linux')?.reason).toContain('too large for this device')
  })

  it('flags a missing dylib', () => {
    expect(classifyLlamaError('dyld: Library not loaded: @rpath/libomp.dylib')?.code).toBe(
      'missing_library'
    )
  })

  it('flags a corrupt model file', () => {
    expect(classifyLlamaError('gguf_init_from_file: invalid magic characters')?.code).toBe(
      'model_corrupt'
    )
  })

  it('classifies native port contention as another live app, not model corruption (#146)', () => {
    const failure = classifyLlamaError('error: listen tcp 127.0.0.1:8439: address already in use')
    expect(failure).toEqual({
      code: 'port_in_use',
      reason:
        'Model engine port 8439 is already owned by another Off Grid AI Desktop instance. Close the other app, development server, or capture run, then restart Chat model in Settings.'
    })
  })

  describe('GPU driver missing a required extension', () => {
    // Verbatim capture from a hybrid-graphics Windows laptop (AMD Radeon 740M iGPU +
    // NVIDIA RTX 4050 dGPU, both 2025 drivers). Every launch failed here and fell
    // through to the CPU engine, while Health showed a blank "server is not running".
    const REAL_STDERR = `ggml_vulkan: Found 2 Vulkan devices:
ERROR: loader_validate_device_extensions: Device extension VK_KHR_shader_bfloat16 not supported by selected physical device or enabled layers.
ERROR: vkCreateDevice: Failed to validate extensions in list
llama_model_load: error loading model: vk::PhysicalDevice::createDevice: ErrorExtensionNotPresent
common_init_from_params: failed to load model 'gemma-4-E4B-it-Q4_K_M.gguf'
main: exiting due to model loading error`

    it('classifies it as a GPU driver gap', () => {
      expect(classifyLlamaError(REAL_STDERR)?.code).toBe('gpu_unsupported')
    })

    it('names the missing extension so the reason is actionable', () => {
      expect(classifyLlamaError(REAL_STDERR)?.reason).toContain('VK_KHR_shader_bfloat16')
    })

    it('says GPU work fell back to the CPU engine', () => {
      expect(classifyLlamaError(REAL_STDERR)?.reason).toMatch(/cpu engine/i)
    })

    // THE ORDERING GUARD. This stderr also contains "failed to load model", which the
    // model_corrupt branch matches. If gpu_unsupported is ever moved below it, a
    // perfectly good download gets reported as corrupt and the user re-downloads
    // several GB for nothing. This test fails the moment that ordering breaks.
    it('is not misreported as a corrupt model despite the "failed to load model" line', () => {
      expect(REAL_STDERR).toContain('failed to load model') // the decoy is really present
      expect(classifyLlamaError(REAL_STDERR)?.code).not.toBe('model_corrupt')
    })

    it('still classifies when the loader trace is absent, without naming an extension', () => {
      const f = classifyLlamaError(
        'llama_model_load: error loading model: vk::PhysicalDevice::createDevice: ErrorExtensionNotPresent'
      )
      expect(f?.code).toBe('gpu_unsupported')
      expect(f?.reason).not.toMatch(/VK_/)
    })

    // A Vulkan OOM is a DIFFERENT failure with a different remedy (smaller model),
    // and it must keep its own classification rather than being swallowed here.
    it('leaves a Vulkan out-of-device-memory failure classified as OOM', () => {
      expect(
        classifyLlamaError(
          'ggml_vulkan: Device memory allocation failed: VK_ERROR_OUT_OF_DEVICE_MEMORY'
        )?.code
      ).toBe('out_of_memory')
    })
  })

  it('returns null for healthy / unrecognized output (caller falls back)', () => {
    expect(classifyLlamaError('srv  load_model: loading model ... server is listening')).toBeNull()
    expect(classifyLlamaError('')).toBeNull()
  })
})

describe('isContextOverflowError', () => {
  it('detects the "exceeds the available context size" family (the observed silent-fail cause)', () => {
    expect(
      isContextOverflowError(
        'the request exceeds the available context size. try increasing the context size or enable context shift'
      )
    ).toBe(true)
  })

  it('detects prompt/input too-long phrasings across engine versions', () => {
    expect(isContextOverflowError('input is too large to process')).toBe(true)
    expect(isContextOverflowError('prompt is too long for this context')).toBe(true)
    expect(isContextOverflowError('the prompt is larger than the context window')).toBe(true)
    expect(isContextOverflowError('requested tokens (5000) exceed context window (2048)')).toBe(true)
  })

  it('is not fooled by an unreachable / dead engine (that must stay retryable)', () => {
    expect(isContextOverflowError('fetch failed: ECONNREFUSED 127.0.0.1:8439')).toBe(false)
    expect(isContextOverflowError('llama-server is not running')).toBe(false)
    expect(isContextOverflowError('')).toBe(false)
  })
})
