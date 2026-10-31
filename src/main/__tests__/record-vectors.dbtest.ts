/**
 * Meaning search over records, against the real profile database: the embed queue the record
 * triggers fill, the background drain that writes vectors into record_vectors, the in-memory int8
 * index, and the hydrated hits a search returns. Electron and the embedding model are the only
 * controlled boundaries. The model is a bag-of-words embedder, so texts that share words are near
 * each other and the ranking can be read from the test data.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-record-vectors-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = PROFILE_DIR

const model = vi.hoisted(() => ({ calls: 0, texts: [] as string[] }))

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
import {
  embedRecordBacklog,
  ensureRecordSchema,
  recordIndexStatus,
  recordSearch,
  releaseRecordIndex
} from '../records'

function moment(summary: string, ts = '2026-10-10 10:00:00'): number {
  return Number(
    getDB()
      .prepare("INSERT INTO observations (summary, surface, ts) VALUES (?, 'Notes', ?)")
      .run(summary, ts).lastInsertRowid
  )
}

function meeting(title: string, summary: string): number {
  return Number(
    getDB()
      .prepare('INSERT INTO meetings (title, summary, started_at) VALUES (?, ?, ?)')
      .run(title, summary, Date.parse('2026-10-11T09:00:00Z')).lastInsertRowid
  )
}

/** Meaning search alone. The Search screen's keywords need every word (keywordTypeahead), and no
 *  record holds this one, so every hit here comes from the vectors. */
const UNMATCHED_WORD = 'xylophonequartz'

async function meaning(question: string, kinds?: string[]): Promise<string[]> {
  const { hits } = await recordSearch(`${question} ${UNMATCHED_WORD}`, {
    semantic: true,
    keywordTypeahead: true,
    window: null,
    ...(kinds ? { kinds } : {})
  })
  return hits.map((hit) => hit.key)
}

beforeAll(() => {
  // Pro's capture and meeting tables, as its schema creates them; a core DB test cannot import Pro.
  getDB().exec(`
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
  ensureRecordSchema()
})

beforeEach(() => {
  releaseRecordIndex()
  model.calls = 0
  model.texts.length = 0
})

afterAll(() => {
  releaseRecordIndex()
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('record vectors', () => {
  it('embeds every queued record in the background, then finds them by meaning', async () => {
    const budget = moment('Quarterly budget review with the finance team')
    moment('Dentist appointment moved to Tuesday morning')
    const launch = meeting('Product launch planning', 'Launch checklist and press timing agreed')

    expect(recordIndexStatus().pending).toBe(3)
    await embedRecordBacklog()
    expect(recordIndexStatus()).toEqual({ vectors: 3, pending: 0 })
    // Records are embedded as passages, in batches.
    expect(model.texts.every((text) => text.startsWith('passage: '))).toBe(true)

    expect((await meaning('finance budget quarterly'))[0]).toBe(`obs:${budget}`)
    // The question was embedded as a query.
    expect(model.texts).toContain(`query: finance budget quarterly ${UNMATCHED_WORD}`)
    // Keyword search alone finds nothing for it: the hits above are meaning hits.
    const keywordOnly = await recordSearch(`finance budget quarterly ${UNMATCHED_WORD}`, {
      typeahead: true,
      window: null
    })
    expect(keywordOnly.hits).toEqual([])
    expect(await meaning('launch checklist', ['meeting'])).toEqual([`mtg:${launch}`])
    // A kind with no records matches nothing.
    expect(await meaning('budget', ['attachment'])).toEqual([])
  })

  it('embeds again only what changed, and forgets a record whose text is gone', async () => {
    const edited = moment('Hiking trip packing list')
    const unchanged = moment('Garden watering schedule')
    await embedRecordBacklog()
    model.texts.length = 0

    getDB()
      .prepare('UPDATE observations SET summary = ? WHERE id = ?')
      .run('Hiking trip permits and maps', edited)
    getDB().prepare('UPDATE observations SET summary = summary WHERE id = ?').run(unchanged)
    expect(recordIndexStatus().pending).toBe(2)
    await embedRecordBacklog()

    // The unchanged record leaves the queue without a forward pass; the edited one is embedded.
    expect(model.texts).toEqual(['passage: Hiking trip permits and maps'])
    expect(recordIndexStatus().pending).toBe(0)
    expect((await meaning('hiking permits maps'))[0]).toBe(`obs:${edited}`)

    getDB().prepare("UPDATE observations SET summary = '' WHERE id = ?").run(unchanged)
    await embedRecordBacklog()
    const stored = getDB()
      .prepare('SELECT COUNT(*) AS n FROM record_vectors WHERE key = ?')
      .get(`obs:${unchanged}`)
    expect(stored).toEqual({ n: 0 })
  })

  it('keeps a loaded index in step with writes and deletes', async () => {
    const first = moment('Violin lesson notes on bowing')
    await embedRecordBacklog()
    // Load the index with one search, then write and delete while it is in memory.
    expect((await meaning('violin bowing lesson'))[0]).toBe(`obs:${first}`)

    const second = moment('Cello rehearsal schedule for the orchestra')
    await embedRecordBacklog()
    expect((await meaning('cello orchestra rehearsal'))[0]).toBe(`obs:${second}`)

    getDB().prepare('DELETE FROM observations WHERE id = ?').run(first)
    expect(await meaning('violin bowing lesson')).not.toContain(`obs:${first}`)

    // Dropped (idle, or its data deleted), the index reloads from SQLite on the next search.
    releaseRecordIndex()
    expect((await meaning('cello orchestra rehearsal'))[0]).toBe(`obs:${second}`)
  })

  it('searches only the time window it is given', async () => {
    const october = moment('Tax filing documents gathered', '2026-10-05 12:00:00')
    const july = moment('Tax filing extension requested', '2026-07-05 12:00:00')
    await embedRecordBacklog()
    const window = {
      start: Date.parse('2026-10-01T00:00:00Z'),
      end: Date.parse('2026-11-01T00:00:00Z'),
      phrase: 'October'
    }
    const { hits } = await recordSearch(`tax filing ${UNMATCHED_WORD}`, {
      semantic: true,
      keywordTypeahead: true,
      window,
      kinds: ['screen']
    })
    const keys = hits.map((hit) => hit.key)
    expect(keys).toContain(`obs:${october}`)
    expect(keys).not.toContain(`obs:${july}`)
  })
})
