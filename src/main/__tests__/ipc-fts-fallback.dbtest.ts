// User text that is FTS5 syntax (quotes, operators, column filters, wildcards) or no words at all
// never breaks a search: the real retrieval engine over the real profile database finds the record
// by its words, and an empty query matches nothing. Electron and the embedding model are the only
// controlled boundaries; the model is unavailable, so this is the keyword path alone.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-fts-fallback-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    on: () => undefined
  },
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
    throw new Error('embedding unavailable for fallback test')
  }
}))

import { getDB } from '../database'
import { configureRuntime } from '../runtime-env'
import { ensureRagStoreSchema } from '../rag/store'
import { universalSearch } from '../search'

const CHAT_KEY = 'chat:aurora-chat'

beforeAll(() => {
  configureRuntime({ dataDir: TMP_DIR })
  ensureRagStoreSchema()
  const db = getDB()
  db.prepare('INSERT INTO rag_conversations (id, title) VALUES (?, ?)').run(
    'aurora-chat',
    'Release'
  )
  db.prepare('INSERT INTO rag_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(
    'aurora-chat',
    'user',
    'Aurora release code obsidian café 日本語'
  )
})

afterAll(() => {
  getDB().close()
  configureRuntime({ dataDir: undefined })
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

/** FTS5 syntax around words the record holds: each still finds it. */
const wordQueries = ['Aurora?', '"Aurora"', '(Aurora)', 'Aurora* ^release', 'café 日本語']
/** Column filters, operators and no words at all: each is plain text, never a syntax error. Every
 *  typed word is required, and a query with no words opens on the newest records. */
const syntaxQueries = ['title:Aurora', 'Aurora AND OR NOT NEAR', '', '   ', '?:()*^"', 'NEAR(']

describe('user text in search', () => {
  it.each(wordQueries)('finds the chat for %j', async (query) => {
    const results = await universalSearch(query, { semantic: false })
    expect(results.map((result) => result.key)).toContain(CHAT_KEY)
  })

  it.each(syntaxQueries)('searches %j without an FTS syntax error', async (query) => {
    await expect(universalSearch(query, { semantic: false })).resolves.toBeInstanceOf(Array)
  })
})
