/**
 * Document passages in scripts written without spaces, and the passage indexes on an upgraded
 * profile, against the real profile database and document engine. A Japanese passage is found by
 * a word of three or more characters (the trigram twin) and by a two-character one. When a profile
 * from an older schema opens, its passage indexes are rebuilt in the background after start-up
 * and every passage is found again. Electron and the embedding model are the only controlled
 * boundaries; the model is unavailable, so this is the keyword path alone.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-document-index-'))
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

const JAPANESE =
  '東京オフィスの移転は来月の予定です。新しい会議室の予約は総務部が担当します。引っ越しの日程は後日連絡します。'
const ENGLISH =
  'The harbourfront lease renews in March. Parking permits are issued by the building office.'

let japaneseId = ''
let englishId = ''

type Documents = typeof import('../documents')

async function found(documents: Documents, query: string): Promise<string[]> {
  const passages = await documents.documentTurns.searchPassages(
    { documentIds: [japaneseId, englishId] },
    query
  )
  return [...new Set(passages.map((passage) => passage.documentId))]
}

beforeAll(async () => {
  const { ingestTextDocument } = await import('../files')
  japaneseId = (await ingestTextDocument('移転計画', 'audio', JAPANESE)).documentId!
  englishId = (await ingestTextDocument('Lease notes', 'audio', ENGLISH)).documentId!
})

afterAll(async () => {
  const { stopIndexRebuilds, getDB } = await import('../database')
  stopIndexRebuilds()
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('document passage indexes', () => {
  it('finds a Japanese passage by a long word and by a two-character one', async () => {
    const documents = await import('../documents')
    await vi.waitFor(
      async () => expect(await found(documents, 'harbourfront lease')).toEqual([englishId]),
      {
        timeout: 15_000,
        interval: 100
      }
    )
    await vi.waitFor(async () => expect(await found(documents, 'オフィス')).toEqual([japaneseId]), {
      timeout: 15_000,
      interval: 100
    })
    expect(await found(documents, '会議')).toEqual([japaneseId])
    // Both scripts in one question: each finds its own document.
    expect((await found(documents, 'parking 総務部')).sort()).toEqual(
      [englishId, japaneseId].sort()
    )
  })

  it('rebuilds the passage indexes of an older profile in the background after start-up', async () => {
    // The profile as an older schema left it: the indexes are not current, the twin is gone.
    const database = await import('../database')
    database
      .getDB()
      .prepare('DELETE FROM fts_schema WHERE name IN (?, ?)')
      .run('attached_document_fts', 'attached_document_fts_tri')
    database.getDB().exec('DROP TABLE IF EXISTS attached_document_fts_tri')
    database.getDB().close()
    vi.resetModules()

    const reopened = await import('../database')
    const documents = await import('../documents')
    // Opening the store queues the rebuilds; start-up then runs them.
    await documents.documentStore.getDocument(japaneseId)
    reopened.startIndexRebuilds()

    await vi.waitFor(
      async () => {
        expect(await found(documents, 'オフィス')).toEqual([japaneseId])
        expect(await found(documents, 'harbourfront lease')).toEqual([englishId])
      },
      { timeout: 20_000, interval: 100 }
    )
    expect(await found(documents, '会議')).toEqual([japaneseId])
    // Both indexes end current, so the next launch does not rebuild them again.
    await vi.waitFor(
      () =>
        expect(
          reopened
            .getDB()
            .prepare(
              "SELECT name FROM fts_schema WHERE name LIKE 'attached_document_fts%' ORDER BY name"
            )
            .all()
        ).toEqual([{ name: 'attached_document_fts' }, { name: 'attached_document_fts_tri' }]),
      { timeout: 10_000, interval: 100 }
    )
  })
})
