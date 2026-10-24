/**
 * Changing the search embedding model, against the real profile database and the real record
 * store, embedding service and rebuild owner. Electron and the embedding model are the only
 * controlled boundaries (a bag-of-words embedder). A person picks a new model: every record is
 * embedded again beside the live vectors and swapped in at the end; a cancel, a failure or a launch
 * after an interrupted change keeps the old index and the old choice.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-embedding-switch-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = PROFILE_DIR

const model = vi.hoisted(() => ({
  calls: 0,
  texts: [] as string[],
  failAfter: Infinity,
  delayMs: 0
}))

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

vi.mock('@huggingface/transformers', () => {
  const DIMENSIONS = 64
  // One dimension per word (by a stable hash), normalized: shared words are what make texts near.
  const embed = (text: string): number[] => {
    const vector = new Array<number>(DIMENSIONS).fill(0)
    const words = text
      .replace(/^(query|passage): /, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
    for (const word of words) {
      let hash = 0
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
      vector[hash % DIMENSIONS]! += 1
    }
    const norm = Math.hypot(...vector) || 1
    return vector.map((value) => value / norm)
  }
  return {
    env: { backends: { onnx: { wasm: {} } } },
    pipeline: async () => async (input: string | string[]) => {
      const texts = Array.isArray(input) ? input : [input]
      model.calls++
      if (model.calls > model.failAfter) throw new Error('The embedding model stopped.')
      if (model.delayMs) await new Promise((resolve) => setTimeout(resolve, model.delayMs))
      model.texts.push(...texts)
      const rows = texts.map(embed)
      return {
        data: Float32Array.from(rows.flat()),
        dims: [rows.length, DIMENSIONS],
        tolist: () => rows
      }
    }
  }
})

import { getDB } from '../database'
import { embedRecordBacklog, ensureRecordSchema, releaseRecordIndex } from '../records'
import { hasStagedRecordVectors } from '../records/store'
import {
  getEmbeddingModelId,
  getIndexedEmbeddingModelId,
  saveEmbeddingModelId
} from '../embedding-model-choice'
import {
  cancelEmbeddingIndexRebuild,
  getEmbeddingRebuildStatus,
  savePreviousEmbeddingChoice,
  startEmbeddingIndexRebuild
} from '../embedding-index-rebuild'

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small'
const NEW_MODEL = 'Xenova/bge-small-en-v1.5'

function moment(summary: string): void {
  getDB()
    .prepare("INSERT INTO observations (summary, surface, ts) VALUES (?, 'Notes', ?)")
    .run(summary, '2026-10-10 10:00:00')
}

function vectorModels(): string[] {
  return (
    getDB().prepare('SELECT DISTINCT model FROM record_vectors ORDER BY model').all() as {
      model: string
    }[]
  ).map((row) => row.model)
}

/** What the Models screen does when a person picks a model: remember the old one, select the new. */
function choose(id: string): void {
  savePreviousEmbeddingChoice()
  saveEmbeddingModelId(id, 384)
}

beforeAll(async () => {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, surface TEXT, surface_app TEXT,
      url TEXT, source_session_id TEXT, source_key TEXT, memory_id INTEGER,
      category TEXT NOT NULL DEFAULT 'work', engagement REAL NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0, ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME, source TEXT);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
  `)
  ensureRecordSchema()
  for (let i = 0; i < 40; i++) moment(`Planning note ${i} about the quarterly budget review`)
  await embedRecordBacklog()
})

beforeEach(() => {
  releaseRecordIndex()
  model.calls = 0
  model.texts.length = 0
  model.failAfter = Infinity
  model.delayMs = 0
})

afterAll(() => {
  releaseRecordIndex()
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('changing the search embedding model', () => {
  it('starts on the default model with every record embedded', () => {
    expect(getIndexedEmbeddingModelId()).toBe(DEFAULT_MODEL)
    expect(vectorModels()).toEqual([DEFAULT_MODEL])
  })

  it('keeps the old index and choice when the new model fails mid-rebuild', async () => {
    choose(NEW_MODEL)
    model.failAfter = 1
    await expect(startEmbeddingIndexRebuild()).rejects.toThrow('The embedding model stopped.')
    expect(getEmbeddingRebuildStatus().phase).toBe('error')
    expect(getEmbeddingModelId()).toBe(DEFAULT_MODEL)
    expect(getIndexedEmbeddingModelId()).toBe(DEFAULT_MODEL)
    expect(vectorModels()).toEqual([DEFAULT_MODEL])
    expect(hasStagedRecordVectors()).toBe(false)
  })

  it('restores the old model after a launch that interrupted a change', async () => {
    choose(NEW_MODEL)
    // The app quit with half the records staged.
    getDB().exec(`CREATE TABLE record_vectors_rebuild AS SELECT * FROM record_vectors LIMIT 5`)
    await startEmbeddingIndexRebuild()
    expect(getEmbeddingRebuildStatus().phase).toBe('restored')
    expect(getEmbeddingModelId()).toBe(DEFAULT_MODEL)
    expect(vectorModels()).toEqual([DEFAULT_MODEL])
    expect(hasStagedRecordVectors()).toBe(false)
  })

  it('cancels between batches and keeps the old index', async () => {
    choose(NEW_MODEL)
    // A slow model, so the cancel lands while records are still being embedded.
    model.delayMs = 50
    const running = startEmbeddingIndexRebuild()
    await vi.waitFor(() => expect(getEmbeddingRebuildStatus().phase).toBe('rebuilding'))
    expect(await cancelEmbeddingIndexRebuild()).toBe(true)
    await running
    expect(getEmbeddingModelId()).toBe(DEFAULT_MODEL)
    expect(vectorModels()).toEqual([DEFAULT_MODEL])
    expect(hasStagedRecordVectors()).toBe(false)
  })

  it('embeds every record with the new model, then searches with it', async () => {
    choose(NEW_MODEL)
    await startEmbeddingIndexRebuild()
    expect(getEmbeddingRebuildStatus()).toMatchObject({
      phase: 'done',
      model: NEW_MODEL,
      total: 40
    })
    expect(getIndexedEmbeddingModelId()).toBe(NEW_MODEL)
    expect(vectorModels()).toEqual([NEW_MODEL])
    expect(hasStagedRecordVectors()).toBe(false)
    // The new model has no E5 prefixes: passages were embedded without "passage: ".
    expect(model.texts.every((text) => !text.startsWith('passage: '))).toBe(true)
  })
})
