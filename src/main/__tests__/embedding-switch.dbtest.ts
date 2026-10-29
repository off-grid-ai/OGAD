// Switching the embedding model, as the current design works it (26e8e9dc2): the choice is saved
// once the work already queued has finished, and the same running service then embeds with the new
// model on request - no restart. Embeddings that carry no corpus of their own (/v1/embeddings, MCP,
// tool routing) keep the default embedder whatever is chosen.
//
// Fakes: Electron (app paths, keychain) and transformers.js, where the ONNX runtime would load
// weights. The choice file, the settings database, the queue and the service run for real on a
// synthetic profile.
import { afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = vi.hoisted(() => ({ dir: '' }))
// The model runtime: where it reads weights, which model each forward pass ran on (each text gets
// the next number as its vector), which pipelines were unloaded, and an optional gate that holds
// the next forward pass until the test lets it finish.
const runtime = vi.hoisted(() => ({
  env: { backends: { onnx: { wasm: {} } } } as { localModelPath?: string },
  embedded: 0,
  passes: [] as { model: string; texts: string[] }[],
  disposed: [] as string[],
  gate: null as Promise<void> | null
}))

vi.mock('electron', () => ({
  app: { getPath: () => profile.dir, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('@huggingface/transformers', () => ({
  env: runtime.env,
  pipeline: async (_task: string, model: string) =>
    Object.assign(
      async (texts: string[]) => {
        const gate = runtime.gate
        runtime.gate = null
        runtime.passes.push({ model, texts })
        if (gate) await gate
        const rows = texts.map(() => [++runtime.embedded])
        return { tolist: () => rows }
      },
      { dispose: async () => void runtime.disposed.push(model) }
    )
}))

profile.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-embedding-switch-'))
fs.mkdirSync(path.join(profile.dir, 'models'))

import { configureRuntime } from '../runtime-env'
import { getDB } from '../database'
import { embeddings } from '../embeddings'
import { DEFAULT_EMBEDDING_MODEL, getEmbeddingModelId } from '../embedding-model-choice'
import { DEFAULT_EMBEDDER } from '../embedding-models'

configureRuntime({ dataDir: profile.dir, modelsDir: path.join(profile.dir, 'models') })

const NEXT_MODEL = 'Xenova/all-MiniLM-L12-v2'

afterAll(async () => {
  await embeddings.shutdown()
  getDB().close()
  fs.rmSync(profile.dir, { recursive: true, force: true })
})

it('saves a switch after the work already queued, then embeds with the new model without a restart', async () => {
  let finish!: () => void
  runtime.gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const first = embeddings.generateEmbedding('first')
  await vi.waitFor(() => expect(runtime.passes).toHaveLength(1))
  const switched = embeddings.switchModel(NEXT_MODEL)

  // The embedding in flight finishes under the old choice.
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(getEmbeddingModelId()).toBe(DEFAULT_EMBEDDING_MODEL)
  finish()
  await expect(first).resolves.toEqual([1])
  await switched
  expect(getEmbeddingModelId()).toBe(NEXT_MODEL)
  expect(
    JSON.parse(fs.readFileSync(path.join(profile.dir, 'embedding-model.json'), 'utf8'))
  ).toMatchObject({ id: NEXT_MODEL })

  // The same service embeds with the chosen model on request: nothing was unloaded or restarted.
  await expect(embeddings.embed(['a', 'b'], { model: getEmbeddingModelId() })).resolves.toEqual([
    [2],
    [3]
  ])
  expect(runtime.passes.at(-1)).toEqual({ model: NEXT_MODEL, texts: ['a', 'b'] })
  expect(runtime.env.localModelPath).toBe(path.join(profile.dir, 'models'))
  expect(runtime.disposed).toEqual([])

  // An embedding with no corpus of its own keeps the default embedder.
  await expect(embeddings.generateEmbedding('second')).resolves.toEqual([4])
  expect(runtime.passes.at(-1)).toEqual({ model: DEFAULT_EMBEDDER.model, texts: ['second'] })
})
