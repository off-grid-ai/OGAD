import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'

const state = vi.hoisted(() => ({
  db: null as Database.Database | null,
  dir: '',
  model: 'Xenova/all-MiniLM-L6-v2',
  dimensions: 384,
  fail: false,
  begin: vi.fn(),
  commit: vi.fn(),
  abort: vi.fn()
}))
vi.mock('../database', () => ({ getDB: () => state.db }))
vi.mock('../embedding-model-choice', () => ({
  DEFAULT_EMBEDDING_MODEL: 'Xenova/all-MiniLM-L6-v2',
  getEmbeddingModelId: () => state.model,
  getEmbeddingDimensions: () => state.dimensions
}))
vi.mock('../runtime-env', () => ({ dataDir: () => state.dir }))
vi.mock('../rag/store', () => ({ ensureRagStoreSchema: () => {} }))
vi.mock('../embeddings', () => ({ embeddings: {
  generateEmbedding: async () => {
    if (state.fail) throw new Error('embedding provider failed')
    return [0.25, 0.5]
  },
  switchModel: async (id: string, dimensions: number) => {
    state.model = id
    state.dimensions = dimensions
  }
} }))
vi.mock('../vectors', () => ({
  beginVectorRebuild: state.begin,
  commitVectorRebuild: state.commit,
  abortVectorRebuild: state.abort,
  finishVectorRebuild: vi.fn()
}))
vi.mock('../search', () => ({ runBackfill: async () => {} }))

import { getEmbeddingRebuildStatus, prepareEmbeddingIndexRebuild, savePreviousEmbeddingChoice, startEmbeddingIndexRebuild } from '../embedding-index-rebuild'
import { isEmbeddingIndexRebuilding } from '../embedding-rebuild-state'

const roots: string[] = []
beforeEach(() => {
  state.db?.close()
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'og-rebuild-'))
  roots.push(state.dir)
  state.db = new Database(':memory:')
  state.db.exec(`
    CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, embedding TEXT);
    CREATE TABLE rag_chunks (id INTEGER PRIMARY KEY, content TEXT, embedding TEXT);
    CREATE TABLE vec_indexed (key TEXT PRIMARY KEY);
    INSERT INTO memories VALUES (1, 'saved memory', '[1,0]');
    INSERT INTO rag_chunks VALUES (1, 'saved knowledge', '[1,0]');
    INSERT INTO vec_indexed VALUES ('old-key');
  `)
  fs.writeFileSync(path.join(state.dir, 'embedding-index-model.json'), JSON.stringify('Xenova/all-MiniLM-L6-v2'))
  state.model = 'Xenova/all-MiniLM-L6-v2'
  state.dimensions = 384
  state.fail = false
  state.begin.mockReset()
  state.commit.mockReset()
  state.abort.mockReset()
})
afterAll(() => {
  state.db?.close()
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function chooseNewModel(): void {
  savePreviousEmbeddingChoice()
  state.model = 'Xenova/bge-base-en-v1.5'
  state.dimensions = 768
}

it('replaces saved embeddings only after the new vector table commits', async () => {
  chooseNewModel()
  await startEmbeddingIndexRebuild()
  expect(state.begin).toHaveBeenCalledOnce()
  expect(state.commit).toHaveBeenCalledOnce()
  expect(state.abort).not.toHaveBeenCalled()
  expect(state.db!.prepare('SELECT embedding FROM memories WHERE id = 1').get()).toEqual({ embedding: '[0.25,0.5]' })
  expect(JSON.parse(fs.readFileSync(path.join(state.dir, 'embedding-index-model.json'), 'utf8'))).toBe(state.model)
  expect(getEmbeddingRebuildStatus().phase).toBe('done')
  expect(isEmbeddingIndexRebuilding()).toBe(false)
})

it('restores the old model and both SQLite indexes when inference fails', async () => {
  chooseNewModel()
  state.fail = true
  await expect(startEmbeddingIndexRebuild()).rejects.toThrow('embedding provider failed')
  expect(state.abort).toHaveBeenCalledOnce()
  expect(state.model).toBe('Xenova/all-MiniLM-L6-v2')
  expect(state.dimensions).toBe(384)
  expect(state.db!.prepare('SELECT embedding FROM memories WHERE id = 1').get()).toEqual({ embedding: '[1,0]' })
  expect(state.db!.prepare('SELECT embedding FROM rag_chunks WHERE id = 1').get()).toEqual({ embedding: '[1,0]' })
  expect(state.db!.prepare('SELECT key FROM vec_indexed').all()).toEqual([{ key: 'old-key' }])
  expect(isEmbeddingIndexRebuilding()).toBe(false)
})

it('restores the old choice after an interrupted rebuild on the next launch', async () => {
  chooseNewModel()
  await prepareEmbeddingIndexRebuild()
  expect(state.db!.prepare('SELECT embedding FROM memories WHERE id = 1').get()).toEqual({ embedding: null })
  await startEmbeddingIndexRebuild()
  expect(state.abort).toHaveBeenCalledOnce()
  expect(state.model).toBe('Xenova/all-MiniLM-L6-v2')
  expect(state.db!.prepare('SELECT embedding FROM memories WHERE id = 1').get()).toEqual({ embedding: '[1,0]' })
  expect(getEmbeddingRebuildStatus().phase).toBe('error')
})
