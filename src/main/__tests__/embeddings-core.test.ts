import { afterEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ pipeline: vi.fn() }))
vi.mock('@huggingface/transformers', () => ({ pipeline: host.pipeline }))
vi.mock('../embeddings-env', () => ({ configureTransformersEnv: vi.fn() }))
vi.mock('../onnx-device', () => ({
  onnxDeviceCandidates: () => ['cpu'],
  loadWithOnnxFallback: async (load: (device: string) => Promise<unknown>) => ({
    runtime: await load('cpu'),
    device: 'cpu'
  })
}))

import { disposeEmbeddingModel, embedText } from '../embeddings-core'

afterEach(async () => {
  await disposeEmbeddingModel()
  host.pipeline.mockReset()
})

it('retries an embedding model load after a temporary provider failure', async () => {
  const runtime = Object.assign(
    vi.fn(async () => ({ data: new Float32Array([0.25, 0.5]) })),
    { dispose: vi.fn() }
  )
  host.pipeline.mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue(runtime)

  await expect(embedText('first', '/synthetic/models')).rejects.toThrow('provider unavailable')
  await expect(embedText('second', '/synthetic/models')).resolves.toEqual([0.25, 0.5])
  expect(host.pipeline).toHaveBeenCalledTimes(2)
})
