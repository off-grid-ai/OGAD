import { describe, expect, it, vi } from 'vitest'
import { loadWithOnnxFallback, onnxDeviceCandidates } from '../onnx-device'

describe('ONNX accelerator selection', () => {
  it('uses the native GPU provider first and always keeps a CPU fallback', () => {
    expect(onnxDeviceCandidates('darwin')).toEqual(['coreml', 'webgpu', 'cpu'])
    expect(onnxDeviceCandidates('win32')).toEqual(['cuda', 'dml', 'webgpu', 'cpu'])
    expect(onnxDeviceCandidates('linux')).toEqual(['cuda', 'webgpu', 'cpu'])
    expect(onnxDeviceCandidates('linux', 'webgpu')).toEqual(['webgpu', 'cuda', 'cpu'])
    expect(onnxDeviceCandidates('darwin', 'cpu')).toEqual(['cpu'])
  })

  it('starts a fresh load with the next provider after a provider fails', async () => {
    const load = vi.fn(async (device: string) => {
      if (device === 'coreml') throw new Error('provider unavailable')
      return `runtime:${device}`
    })

    await expect(loadWithOnnxFallback(load, ['coreml', 'cpu'])).resolves.toEqual({
      runtime: 'runtime:cpu',
      device: 'cpu',
      fallbackReason: 'coreml: provider unavailable'
    })
    expect(load.mock.calls).toEqual([['coreml'], ['cpu']])
  })

  it('reports every provider failure when no runtime can start', async () => {
    await expect(
      loadWithOnnxFallback(async (device) => {
        throw new Error(`${device} unavailable`)
      }, ['dml', 'cpu'])
    ).rejects.toThrow('dml: dml unavailable | cpu: cpu unavailable')
  })
})
