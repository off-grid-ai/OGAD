/**
 * What the retrieval engine reads from each record source, against the real profile database:
 * a question that is only a time ("what did I do yesterday") lists that day's records of every
 * kind, a to-do reads as the user sees it, and a short run in a script written without spaces
 * (two Chinese characters) still finds its record. Electron and the embedding model are the only
 * controlled boundaries; the model is unavailable, so this is the keyword and time paths alone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-record-sources-'))
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
import { ensureRecordSchema, recordSearch } from '../records'

/** Noon, local time, on 2026-10-14; "yesterday" is the 13th. */
const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime()
const YESTERDAY_NOON = new Date(2026, 9, 13, 12, 0, 0).getTime()
const LAST_WEEK = new Date(2026, 9, 6, 12, 0, 0).getTime()

/** SQLite's UTC text timestamp, as the capture pipeline stores it. */
const sqliteTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')

const ids = { moment: 0, oldMoment: 0, todo: 0, done: 0, dismissed: 0, meeting: 0, chinese: 0 }

function moment(summary: string, ms: number): number {
  return Number(
    getDB()
      .prepare("INSERT INTO observations (summary, surface, ts) VALUES (?, 'Notes', ?)")
      .run(summary, sqliteTime(ms)).lastInsertRowid
  )
}

function todo(
  text: string,
  status: string,
  ms: number,
  extra: { due?: string; dueAt?: number; entity?: string } = {}
): number {
  return Number(
    getDB()
      .prepare(
        `INSERT INTO action_items (text, raw_text, status, created_at, due, due_at, entity_name, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0.9)`
      )
      .run(text, text, status, ms, extra.due ?? null, extra.dueAt ?? null, extra.entity ?? null)
      .lastInsertRowid
  )
}

beforeAll(() => {
  // Pro's capture, to-do and meeting tables, as its schema creates them; a core DB test cannot
  // import Pro.
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, surface TEXT, surface_app TEXT,
      url TEXT, source_session_id TEXT, source_key TEXT, memory_id INTEGER,
      category TEXT NOT NULL DEFAULT 'work', engagement REAL NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0, ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME, source TEXT);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
    CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, raw_text TEXT, due TEXT,
      entity_name TEXT, source_app TEXT, source_summary TEXT, source_ts INTEGER,
      confidence REAL NOT NULL DEFAULT 0.6, status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL DEFAULT 0, dedup_key TEXT UNIQUE, due_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, transcript TEXT, summary TEXT,
      started_at INTEGER, ended_at INTEGER, duration_sec INTEGER, created_at INTEGER NOT NULL DEFAULT 0
    );
  `)
  ensureRagStoreSchema()
  // The index and its triggers exist before anything is recorded, as at app start-up.
  ensureRecordSchema()

  ids.moment = moment('Reviewed the vendor contract renewal terms', YESTERDAY_NOON)
  ids.oldMoment = moment('Sketched the garden layout', LAST_WEEK)
  ids.chinese = moment('明天的会议改到下午三点', YESTERDAY_NOON)
  ids.todo = todo('Send the signed contract to legal', 'suggested', YESTERDAY_NOON, {
    dueAt: new Date(2026, 9, 16, 17, 0, 0).getTime(),
    entity: 'Priya'
  })
  ids.done = todo('Book the venue', 'done', YESTERDAY_NOON, { due: 'by Friday' })
  ids.dismissed = todo('Order more staples', 'dismissed', YESTERDAY_NOON)
  ids.meeting = Number(
    getDB()
      .prepare('INSERT INTO meetings (title, summary, started_at) VALUES (?, ?, ?)')
      .run('Vendor sync', 'Agreed the renewal price', YESTERDAY_NOON).lastInsertRowid
  )
})

afterAll(() => {
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('record sources', () => {
  it('lists the records of a day when the question is only that day', async () => {
    const { hits, window } = await recordSearch('yesterday', { semantic: false, now: NOW })
    expect(window).toMatchObject({
      start: new Date(2026, 9, 13).getTime(),
      end: new Date(2026, 9, 14).getTime()
    })
    const keys = hits.map((hit) => hit.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        `obs:${ids.moment}`,
        `obs:${ids.chinese}`,
        `act:${ids.todo}`,
        `act:${ids.done}`,
        `mtg:${ids.meeting}`
      ])
    )
    // Another day's moment and a dismissed to-do are not that day's records.
    expect(keys).not.toContain(`obs:${ids.oldMoment}`)
    expect(keys).not.toContain(`act:${ids.dismissed}`)
  })

  it('reads a to-do as the list shows it: its state, who it is for and when it is due', async () => {
    const { hits } = await recordSearch('signed contract legal', {
      semantic: false,
      window: null,
      kinds: ['action']
    })
    expect(hits[0]).toMatchObject({
      key: `act:${ids.todo}`,
      kind: 'action',
      title: 'Suggested to-do · Priya',
      surface: 'To-do'
    })
    // A resolved deadline reads as its day.
    expect(hits[0]!.text).toMatch(/^Send the signed contract to legal \(due .+16.+\)$/)

    const done = await recordSearch('book venue', {
      semantic: false,
      window: null,
      kinds: ['action']
    })
    expect(done.hits[0]).toMatchObject({
      key: `act:${ids.done}`,
      title: 'Done',
      text: 'Book the venue (due by Friday)'
    })
  })

  it('finds a two-character run in a script written without spaces', async () => {
    const { hits } = await recordSearch('会议', { semantic: false, window: null })
    expect(hits.map((hit) => hit.key)).toContain(`obs:${ids.chinese}`)
  })

  it('keeps a time-filtered keyword search inside its day', async () => {
    const yesterday = await recordSearch('vendor yesterday', { semantic: false, now: NOW })
    const keys = yesterday.hits.map((hit) => hit.key)
    expect(keys).toEqual(expect.arrayContaining([`obs:${ids.moment}`, `mtg:${ids.meeting}`]))
    const lastMonth = await recordSearch('vendor last month', { semantic: false, now: NOW })
    expect(lastMonth.hits.map((hit) => hit.key)).not.toContain(`obs:${ids.moment}`)
  })
})
