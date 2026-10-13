// Real SQLite and IPC retrieval, with model transport controlled without a local server.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown
interface IpcEvent {
  sender: { send: (channel: string, payload: unknown) => void }
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-fts-fallback-'))
const handlers = new Map<string, IpcHandler>()

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    on: () => undefined
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    on: () => undefined
  },
  BrowserWindow: { fromWebContents: () => undefined },
  clipboard: { readText: () => '', writeText: () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted'
  },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  desktopCapturer: { getSources: async () => [] },
  dialog: {}
}))

vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    throw new Error('embedding unavailable for fallback test')
  }
}))

vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({
    tableNames: async () => [],
    openTable: async () => {
      throw new Error('no vector table in a fresh profile')
    }
  })
}))

import { getDB } from '../database'
import { configureRuntime } from '../runtime-env'
import { setupIPC } from '../ipc'
import { llm } from '../llm'
import { listProjects } from '../rag/store'

beforeAll(() => {
  configureRuntime({ dataDir: TMP_DIR })
  setupIPC()
  listProjects()
  vi.spyOn(llm, 'chat').mockResolvedValue('{"intent":"chat","urls":[]}')
  vi.spyOn(llm, 'chatStream').mockResolvedValue({
    content: 'Grounded answer.',
    toolCalls: [],
    finishReason: 'stop',
    maxTokens: 200
  })
  getDB()
    .prepare('INSERT INTO memories(content, source_app) VALUES (?, ?)')
    .run('Aurora release code obsidian café 日本語', 'synthetic')
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT NOT NULL,
      surface TEXT,
      url TEXT,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observation_fts USING fts5(
      summary, content='observations', content_rowid='id'
    );
    CREATE TABLE IF NOT EXISTS frames (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_path TEXT,
      text TEXT,
      surface TEXT,
      url TEXT,
      ts DATETIME
    );
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      summary TEXT,
      transcript TEXT,
      started_at INTEGER
    );
  `)
  try {
    getDB().exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* already present */
  }
})

afterAll(() => {
  vi.restoreAllMocks()
  getDB().close()
  configureRuntime({ dataDir: undefined })
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

const event: IpcEvent = { sender: { send: () => undefined } }
const queries = [
  'Aurora?',
  '"Aurora"',
  'title:Aurora',
  '(Aurora)',
  'Aurora AND OR NOT NEAR',
  'Aurora* ^release',
  'café 日本語'
]

describe('user text in IPC FTS fallbacks', () => {
  it.each(queries)('retrieves memory for %j without FTS syntax errors', async (query) => {
    const search = handlers.get('db:search-memories')!
    await expect(search(event, query)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Aurora') })
      ])
    )
    const chat = handlers.get('rag:chat')!
    const reply = (await chat(event, query, 'All', [], null, 'fts-fallback-chat')) as {
      answer: string
      context: { memories: Array<{ content: string }> }
    }
    expect(reply.answer).toBe('Grounded answer.')
    expect(reply.context.memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: expect.stringContaining('Aurora') })
      ])
    )
  })

  it.each(['', '   ', '?:()*^"'])('skips MATCH for empty terms in %j', async (query) => {
    const prepared = vi.spyOn(getDB(), 'prepare')
    try {
      await expect(handlers.get('db:search-memories')!(event, query)).resolves.toEqual([])
      const reply = (await handlers.get('rag:chat')!(
        event,
        query,
        'All',
        [],
        null,
        'fts-empty-chat'
      )) as {
        answer: string
        context: { memories: unknown[]; messages: unknown[] }
      }
      expect(reply.answer).toBe('Grounded answer.')
      expect(reply.context).toMatchObject({ memories: [], messages: [] })
      expect(prepared.mock.calls.some(([sql]) => /\bMATCH\b/.test(sql))).toBe(false)
    } finally {
      prepared.mockRestore()
    }
  })
})
