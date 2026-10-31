/**
 * A screen moment whose screenshot capture retention has deleted still comes up in Search, but
 * without a picture: its card names no image, so it shows its glyph instead of a broken image.
 * A moment whose screenshot is still on disk keeps its picture. Real profile database and real
 * retrieval engine; Electron and the embedding model are the only controlled boundaries (the
 * model is unavailable, so this is the keyword path).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-missing-capture-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = PROFILE_DIR

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    throw new Error('no embedding model in this journey')
  }
}))

import { getDB } from '../database'
import { ensureRagStoreSchema } from '../rag/store'
import { ensureRecordSchema } from '../records'
import { universalSearch } from '../search'

const kept = path.join(PROFILE_DIR, 'captures', 'capture-kept.png')
const deleted = path.join(PROFILE_DIR, 'captures', 'capture-deleted.png')
const ids = { kept: 0, deleted: 0 }

/** A moment and the screenshot frame it was summarised from, as the capture pipeline links them. */
function moment(summary: string, imagePath: string): number {
  const db = getDB()
  const id = Number(
    db
      .prepare("INSERT INTO observations (summary, surface, ts) VALUES (?, 'Brave Browser', ?)")
      .run(summary, new Date().toISOString().slice(0, 19).replace('T', ' ')).lastInsertRowid
  )
  const frame = Number(
    db
      .prepare("INSERT INTO frames (image_path, text, surface) VALUES (?, '', 'Brave Browser')")
      .run(imagePath).lastInsertRowid
  )
  db.prepare('INSERT INTO observation_frames (observation_id, frame_id) VALUES (?, ?)').run(
    id,
    frame
  )
  return id
}

beforeAll(() => {
  // Pro's capture tables, as its schema creates them; a core DB test cannot import Pro.
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, surface TEXT, surface_app TEXT,
      url TEXT, source_session_id TEXT, source_key TEXT, memory_id INTEGER,
      category TEXT NOT NULL DEFAULT 'work', engagement REAL NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0, ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, source TEXT);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
  `)
  ensureRagStoreSchema()
  ensureRecordSchema()
  fs.mkdirSync(path.dirname(kept), { recursive: true })
  fs.writeFileSync(kept, Buffer.from('89504e470d0a1a0a', 'hex'))
  ids.kept = moment('Compared licence seat prices on the Keygen pricing page', kept)
  // Captured, then removed by capture retention: the row stays, the file does not.
  ids.deleted = moment('Read the Keygen licence seat reclaim docs', deleted)
})

afterAll(() => {
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('search results for screen moments', () => {
  it('show a screenshot only while the file is still on disk', async () => {
    const results = await universalSearch('Keygen licence seat', { semantic: false })
    const byKey = new Map(results.map((result) => [result.key, result]))

    expect(byKey.get(`obs:${ids.kept}`)?.imagePath).toBe(kept)
    expect(byKey.get(`obs:${ids.deleted}`)).toBeDefined()
    expect(byKey.get(`obs:${ids.deleted}`)?.imagePath).toBeNull()
  })
})
