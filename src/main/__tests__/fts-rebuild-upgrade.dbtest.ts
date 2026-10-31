/**
 * The upgrade path of the keyword indexes, against the real profile database. A profile from
 * before the retrieval engine already holds moments and meetings; their indexes are created empty
 * and filled in the background after start-up, a slice at a time. Once that finishes every old row
 * is found, and a row added or edited while it ran is found as it is now. Electron and the
 * embedding model are the only controlled boundaries.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-fts-rebuild-'))
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

import { getDB, startIndexRebuilds, stopIndexRebuilds } from '../database'
import { ensureRecordSchema, recordSearch } from '../records'

/** Enough rows that the background rebuild takes several slices. */
const OLD_MEETINGS = 4_000

const keysFor = async (question: string, kinds: string[]): Promise<string[]> =>
  (await recordSearch(question, { semantic: false, window: null, kinds, limit: 50 })).hits.map(
    (hit) => hit.key
  )

beforeAll(() => {
  // A profile written before the retrieval engine: Pro's tables, already full.
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, surface TEXT, surface_app TEXT,
      url TEXT, source_session_id TEXT, source_key TEXT, memory_id INTEGER,
      category TEXT NOT NULL DEFAULT 'work', engagement REAL NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0, ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME, source TEXT);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, transcript TEXT, summary TEXT,
      started_at INTEGER, ended_at INTEGER, duration_sec INTEGER, created_at INTEGER NOT NULL DEFAULT 0
    );
  `)
  const meeting = db.prepare('INSERT INTO meetings (title, summary, started_at) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (let i = 1; i <= OLD_MEETINGS; i++)
      meeting.run(`Standup ${i}`, `Daily standup notes number ${i}`, 1_700_000_000_000 + i)
    meeting.run(
      'Harbourfront lease review',
      'Lease renewal for the harbourfront office',
      1_700_100_000_000
    )
    db.prepare("INSERT INTO observations (summary, surface) VALUES (?, 'Notes')").run(
      'Read the harbourfront parking rules'
    )
    db.prepare("INSERT INTO observations (summary, surface) VALUES (?, 'Notes')").run(
      '東京オフィスの移転計画'
    )
  })()
})

afterAll(() => {
  stopIndexRebuilds()
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('keyword indexes on an upgraded profile', () => {
  it('fills in the background after start-up and keeps edits made while it runs', async () => {
    // Start-up: the indexes exist but are not filled yet, so old rows are not found.
    ensureRecordSchema()
    expect(await keysFor('harbourfront lease', ['meeting'])).toEqual([])

    startIndexRebuilds()
    // While the rebuild runs: a new meeting, and an old one renamed.
    const added = Number(
      getDB()
        .prepare('INSERT INTO meetings (title, summary, started_at) VALUES (?, ?, ?)')
        .run('Quayside budget call', 'Budget for the quayside fitout', Date.now()).lastInsertRowid
    )
    getDB()
      .prepare('UPDATE meetings SET title = ?, summary = ? WHERE id = ?')
      .run('Lighthouse retrospective', 'What went well at the lighthouse event', 2)

    await vi.waitFor(
      async () => {
        expect(await keysFor('harbourfront lease', ['meeting'])).toEqual(
          expect.arrayContaining([expect.stringMatching(/^mtg:\d+$/)])
        )
        expect(await keysFor(`standup number ${OLD_MEETINGS}`, ['meeting'])).toContain(
          `mtg:${OLD_MEETINGS}`
        )
      },
      { timeout: 20_000, interval: 100 }
    )
    expect(await keysFor('quayside budget', ['meeting'])).toEqual([`mtg:${added}`])
    expect(await keysFor('lighthouse retrospective', ['meeting'])).toEqual(['mtg:2'])
    // The renamed meeting is found by what it says now, not by its old words.
    expect(await keysFor('standup number 2', ['meeting'])).not.toContain('mtg:2')

    // Moments too, including text in a script written without spaces (the trigram twin).
    await vi.waitFor(
      async () => {
        expect(await keysFor('harbourfront parking', ['screen'])).toHaveLength(1)
        expect(await keysFor('オフィス', ['screen'])).toHaveLength(1)
      },
      { timeout: 20_000, interval: 100 }
    )

    // Once swapped in, the filled index follows edits live.
    getDB().prepare('UPDATE meetings SET summary = ? WHERE id = ?').run('Marina berth fees', 3)
    expect(await keysFor('marina berth', ['meeting'])).toEqual(['mtg:3'])
  })
})
