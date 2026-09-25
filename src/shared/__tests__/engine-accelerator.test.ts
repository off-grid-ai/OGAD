import { describe, expect, it } from 'vitest'
import { acceleratorForEngine, gpuLayersHint } from '../engine-accelerator'

describe('Linux engine accelerator', () => {
  it('labels CUDA, Vulkan, and CPU fallback binaries for both model families', () => {
    for (const variant of ['llama', 'llama-prism']) {
      expect(
        acceleratorForEngine({
          platform: 'linux',
          serverPath: `/opt/off-grid/bin/${variant}-cuda/llama-server`
        })
      ).toBe('CUDA')
      expect(
        acceleratorForEngine({
          platform: 'linux',
          serverPath: `/opt/off-grid/bin/${variant}/llama-server`
        })
      ).toBe('Vulkan')
      expect(
        acceleratorForEngine({
          platform: 'linux',
          serverPath: `/opt/off-grid/bin/${variant}-cpu/llama-server`
        })
      ).toBe('CPU')
    }
    expect(gpuLayersHint('CPU')).toContain('setting changes nothing')
    expect(
      acceleratorForEngine({
        platform: 'linux',
        serverPath: '/opt/off-grid/bin/llama-cuda/llama-server',
        gpuLayers: null
      })
    ).toBeNull()
    expect(
      acceleratorForEngine({
        platform: 'win32',
        serverPath: 'C:\\OffGrid\\bin\\llama\\llama-server.exe',
        gpuLayers: 0
      })
    ).toBe('CPU')
    expect(
      acceleratorForEngine({
        platform: 'win32',
        serverPath: 'C:\\OffGrid\\bin\\llama-prism-cuda\\llama-server.exe'
      })
    ).toBe('CUDA')
    expect(
      acceleratorForEngine({
        platform: 'linux',
        serverPath: '/opt/off-grid/bin/llama-server'
      })
    ).toBeNull()
  })
})
