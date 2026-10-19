/**
 * Short capture frames never hold the search backlog open (backlog item 33), against the real
 * profile database.
 *
 * A frame is not a search record: its words belong to the moment it is linked to, which is what
 * gets embedded. So frames never enter the embedding queue, and a run of short frames ("ok",
 * "see you at 3") leaves nothing pending. Electron and the embedding model are the only controlled
 * boundaries: the model throws if asked, so this proves a frame never reaches it.
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

import { getDB } from '../database'
import { runBackfill, searchStatus } from '../search'

beforeAll(() => {
  // Pro's capture tables, as its schema creates them; a core DB test cannot import Pro.
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, surface TEXT, url TEXT, text TEXT, source TEXT);
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
  it('never queues short capture frames, so the backlog stays empty', async () => {
    expect((await searchStatus()).pending).toBe(0)
    const insert = getDB().prepare("INSERT INTO frames (surface, text) VALUES ('Slack', ?)")
    insert.run('ok')
    insert.run('see you at 3')

    expect((await searchStatus()).pending).toBe(0)
    await runBackfill()

    expect((await searchStatus()).pending).toBe(0)
    expect(getDB().prepare('SELECT COUNT(*) AS n FROM record_vectors').get()).toEqual({ n: 0 })
  })
})
