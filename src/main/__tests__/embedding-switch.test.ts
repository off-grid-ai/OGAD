import { expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  embed: vi.fn(),
  dispose: vi.fn(),
  selected: 'Xenova/all-MiniLM-L6-v2'
}))
vi.mock('../embeddings-core', () => ({
  embedText: host.embed,
  embeddingDevice: () => 'cpu',
  disposeEmbeddingModel: host.dispose
}))
vi.mock('../embedding-model-choice', () => ({
  getEmbeddingModelId: () => host.selected,
  saveEmbeddingModelId: (id: string) => {
    host.selected = id
  }
}))
vi.mock('../runtime-env', () => ({ modelsDir: () => '/synthetic/models' }))
vi.mock('../backend-preferences', () => ({ getBackendPreference: () => 'auto' }))
vi.mock('../runtime-residency', () => ({ getResidencyMode: () => 'resident' }))

import { embeddings } from '../embeddings'

it('waits for current inference, then uses the new model without a restart', async () => {
  let finish!: (value: number[]) => void
  host.embed.mockImplementationOnce(
    () =>
      new Promise<number[]>((resolve) => {
        finish = resolve
      })
  )
  const first = embeddings.generateEmbedding('first')
  const switched = embeddings.switchModel('Xenova/all-MiniLM-L12-v2')
  expect(host.selected).toBe('Xenova/all-MiniLM-L6-v2')
  await vi.waitFor(() => expect(host.embed).toHaveBeenCalledOnce())
  finish([1])
  await first
  await switched
  expect(host.selected).toBe('Xenova/all-MiniLM-L12-v2')
  expect(host.dispose).toHaveBeenCalledOnce()

  host.embed.mockResolvedValueOnce([2])
  await expect(embeddings.generateEmbedding('second')).resolves.toEqual([2])
  expect(host.embed).toHaveBeenLastCalledWith(
    'second',
    '/synthetic/models',
    expect.any(Function),
    'auto',
    'Xenova/all-MiniLM-L12-v2'
  )
})
