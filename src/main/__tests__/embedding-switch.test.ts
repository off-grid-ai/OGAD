// Switching the embedding model, as the current design works it (26e8e9dc2): the choice is saved
// once the work already queued has finished, and the same running service then embeds with the new
// model on request - no restart. Embeddings that carry no corpus of their own (/v1/embeddings, MCP,
// tool routing) keep the default embedder whatever is chosen.
//
// Fakes: the ONNX model runtime (embeddings-core), where transformers.js would load weights, and two
// settings reads backed by the app database. The choice file, the queue and the service run for
// real on a synthetic profile.
import { expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
  embed: vi.fn<(texts: string[], model: string, ...rest: unknown[]) => Promise<number[][]>>(),
  dispose: vi.fn()
}))
vi.mock('../embeddings-core', () => ({
  embedTexts: host.embed,
  embeddingDevice: () => 'cpu',
  disposeEmbeddingModel: host.dispose
}))
// Settings the service reads from the app database (native SQLite): the defaults, not under test.
vi.mock('../backend-preferences', () => ({ getBackendPreference: () => 'auto' }))
vi.mock('../runtime-residency', () => ({ getResidencyMode: () => 'resident' }))

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureRuntime } from '../runtime-env'
import { embeddings } from '../embeddings'
import { DEFAULT_EMBEDDING_MODEL, getEmbeddingModelId } from '../embedding-model-choice'
import { DEFAULT_EMBEDDER } from '../embedding-models'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'og-embedding-switch-'))
fs.mkdirSync(path.join(profile, 'models'))
configureRuntime({ dataDir: profile, modelsDir: path.join(profile, 'models') })

const NEXT_MODEL = 'Xenova/all-MiniLM-L12-v2'

it('saves a switch after the work already queued, then embeds with the new model without a restart', async () => {
  let finish!: (vectors: number[][]) => void
  host.embed.mockImplementationOnce(
    () =>
      new Promise<number[][]>((resolve) => {
        finish = resolve
      })
  )
  const first = embeddings.generateEmbedding('first')
  await vi.waitFor(() => expect(host.embed).toHaveBeenCalledOnce())
  const switched = embeddings.switchModel(NEXT_MODEL)

  // The embedding in flight finishes under the old choice.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(getEmbeddingModelId()).toBe(DEFAULT_EMBEDDING_MODEL)
  finish([[1]])
  await expect(first).resolves.toEqual([1])
  await switched
  expect(getEmbeddingModelId()).toBe(NEXT_MODEL)
  expect(
    JSON.parse(fs.readFileSync(path.join(profile, 'embedding-model.json'), 'utf8'))
  ).toMatchObject({ id: NEXT_MODEL })

  // The same service embeds with the chosen model on request: nothing was unloaded or restarted.
  host.embed.mockResolvedValueOnce([[2], [3]])
  await expect(embeddings.embed(['a', 'b'], { model: getEmbeddingModelId() })).resolves.toEqual([
    [2],
    [3]
  ])
  expect(host.embed).toHaveBeenLastCalledWith(
    ['a', 'b'],
    NEXT_MODEL,
    path.join(profile, 'models'),
    expect.any(Function),
    expect.any(Array),
    [path.join(profile, 'models')]
  )
  expect(host.dispose).not.toHaveBeenCalled()

  // An embedding with no corpus of its own keeps the default embedder.
  host.embed.mockResolvedValueOnce([[4]])
  await expect(embeddings.generateEmbedding('second')).resolves.toEqual([4])
  expect(host.embed).toHaveBeenLastCalledWith(
    ['second'],
    DEFAULT_EMBEDDER.model,
    path.join(profile, 'models'),
    expect.any(Function),
    expect.any(Array),
    [path.join(profile, 'models')]
  )
})
