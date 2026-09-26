import { describe, expect, it } from 'vitest'
import { hasGpuDevice, offloadedGpuLayers } from '../gpu-device-probe'

describe('hasGpuDevice', () => {
  it('accepts an enumerated Vulkan GPU', () => {
    expect(hasGpuDevice('Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4060', 'Vulkan')).toBe(true)
    expect(hasGpuDevice('Available devices:\n  Vulkan1: AMD Radeon', 'Vulkan')).toBe(true)
  })

  it('accepts CUDA only when a CUDA device is listed', () => {
    expect(hasGpuDevice('Available devices:\n  CUDA0: NVIDIA GeForce RTX 4060', 'CUDA')).toBe(true)
    expect(hasGpuDevice('Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4060', 'CUDA')).toBe(false)
  })

  it('rejects a binary that can only run on the CPU', () => {
    expect(hasGpuDevice('Available devices:\n  (none)', 'Vulkan')).toBe(false)
    expect(hasGpuDevice('Available devices:\n  CPU0: x86_64', 'CUDA')).toBe(false)
    expect(hasGpuDevice('failed to list devices', 'CUDA')).toBe(false)
    expect(hasGpuDevice('Available devices:\n  Vulkan0: llvmpipe (LLVM 15.0.7)', 'Vulkan')).toBe(false)
    expect(hasGpuDevice('Available devices:\n  Vulkan0: Microsoft Basic Render Driver', 'Vulkan')).toBe(false)
  })
})

describe('offloadedGpuLayers', () => {
  it('reads the engine confirmation after a model load', () => {
    expect(offloadedGpuLayers('llama_model_load_tensors: offloaded 25/25 layers to GPU')).toBe(25)
    expect(offloadedGpuLayers('offloaded 0/25 layers to GPU')).toBe(0)
  })

  it('does not infer offload from a device list or requested layer count', () => {
    expect(offloadedGpuLayers('Available devices:\n  CUDA0: NVIDIA RTX 4060')).toBeNull()
    expect(offloadedGpuLayers('n_gpu_layers = 99')).toBeNull()
  })
})
