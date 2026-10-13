/**
 * Search indexing drains capture frames too short to embed (backlog item 33), against the real
 * profile database.
 *
 * The pending scans no longer measure frame text in SQL. A short frame is selected, skipped
 * without an embedding, and recorded as handled, so the backlog empties instead of keeping it.
 * Electron, the embedding model and the native vector store are the only controlled boundaries:
 * the model throws if asked, so this proves a short frame never reaches it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-backfill-short-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = PROFILE_DIR

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('@huggingface/transformers', () => ({
  pipeline: async () => {
    throw new Error('a short frame must not be embedded')
  },
  env: {}
}))
vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({ openTable: async () => ({}), tableNames: async () => [] })
}))

import { getDB } from '../database'
import { runBackfill, searchStatus } from '../search'

beforeAll(() => {
  // Pro's capture tables, as its schema creates them; a core DB test cannot import Pro.
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, surface TEXT, url TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, surface TEXT, url TEXT, ts DATETIME);
    CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, transcript TEXT, started_at INTEGER);
  `)
  try {
    getDB().exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* already present */
  }
})

afterAll(() => {
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('search indexing backlog', () => {
  it('records frames too short to embed as handled, so the backlog empties', async () => {
    const insert = getDB().prepare("INSERT INTO frames (surface, text) VALUES ('Slack', ?)")
    insert.run('ok')
    insert.run('see you at 3')

    expect((await searchStatus()).pending).toBe(2)
    await runBackfill()

    expect((await searchStatus()).pending).toBe(0)
    const handled = getDB()
      .prepare("SELECT key FROM vec_indexed WHERE key LIKE 'frame:%' ORDER BY key")
      .all() as { key: string }[]
    expect(handled.map((row) => row.key)).toEqual(['frame:1', 'frame:2'])
  })
})
