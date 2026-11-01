// The frame text index on a real SQLite database: frames captured before the index existed are
// found once the backfill reaches them, new and edited frames immediately, and synced mail or chat
// frames never. Only Electron's userData folder is replaced.
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-frame-index-'))
vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import { getDB } from '../database'
import {
  ensureFrameTextIndex,
  frameTextIndexBackfilling,
  indexFrameTextBatch
} from '../frame-text-index'
import { writeFrame } from './harness/capture-fixtures'

afterAll(() => {
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

function frame(text: string | null, source = 'ax'): number {
  return writeFrame(getDB(), { text, source, surface: 'Preview' })
}

function found(words: string): number[] {
  return (
    getDB().prepare('SELECT rowid AS id FROM frame_fts WHERE frame_fts MATCH ?').all(words) as {
      id: number
    }[]
  ).map((row) => row.id)
}

describe('frame text index', () => {
  it('indexes older frames in batches, new and edited ones at once, and never synced mail', () => {
    const db = getDB()
    db.exec(`CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP,
      surface TEXT, url TEXT, text TEXT, source TEXT)`)
    // Captured before the index existed.
    const old = Array.from({ length: 5 }, (_, i) => frame(`Hephaestus forges shield number ${i}`))
    const mail = frame('Hephaestus newsletter from the forge', 'connector')

    ensureFrameTextIndex(db)
    expect(found('hephaestus')).toEqual([])
    expect(frameTextIndexBackfilling()).toBe(true)

    // New and edited frames are searchable straight away.
    const fresh = frame('Achilles sulks beside the black ships')
    expect(found('achilles')).toEqual([fresh])
    db.prepare('UPDATE frames SET text = ? WHERE id = ?').run('Patroclus wears the armour', fresh)
    expect(found('achilles')).toEqual([])
    expect(found('patroclus')).toEqual([fresh])

    // The backfill works newest first, a batch at a time, until none are left. The first batch is
    // the mail frame (skipped) and the newest older frame.
    expect(indexFrameTextBatch(2, 10_000)).toBe(true)
    expect(found('hephaestus')).toEqual([old[4]])
    while (indexFrameTextBatch(2, 10_000)) {
      /* the rest */
    }
    expect(frameTextIndexBackfilling()).toBe(false)
    expect(found('hephaestus').sort()).toEqual(old.sort())
    expect(found('newsletter')).toEqual([])
    expect(found('hephaestus')).not.toContain(mail)

    // A deleted frame leaves the index.
    db.prepare('DELETE FROM frames WHERE id = ?').run(old[0])
    expect(found('hephaestus')).not.toContain(old[0])
  })
})
