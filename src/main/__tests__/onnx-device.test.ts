import { describe, expect, it, vi } from 'vitest'
import { loadWithOnnxFallback } from '../onnx-device'

describe('ONNX accelerator selection', () => {
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
      loadWithOnnxFallback(
        async (device) => {
          throw new Error(`${device} unavailable`)
        },
        ['dml', 'cpu']
      )
    ).rejects.toThrow('dml: dml unavailable | cpu: cpu unavailable')
  })
})
