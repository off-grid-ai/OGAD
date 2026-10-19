// Fresh-profile integration coverage for RELEASE_TEST_CHECKLIST #34 and #35.
//
// This invokes the REAL `rag:chat` handler registered by setupIPC and the REAL chat tools loop
// (toolChat → search_memory → the retrieval engine), over the REAL SQLite schema, prompt assembly,
// modality queue, and LLM transport. Only true process boundaries are faked: Electron
// registration, the embedding model, and llama-server (a real loopback HTTP socket).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startFakeLlamaServer, type FakeLlamaServer } from './harness/fake-llama-server'

type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown
interface IpcEvent {
  sender: { send: (channel: string, payload: unknown) => void }
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-empty-memory-it-'))
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
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.01) })
}))

import { getDB, saveSetting } from '../database'
import { setupIPC } from '../ipc'
import { llm } from '../llm'
import { listProjects } from '../rag/store'
import { toolChat } from '../tools'

let fake: FakeLlamaServer

beforeAll(async () => {
  fake = await startFakeLlamaServer()
  const service = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  service.port = fake.port
  service.initialized = true
  service.paused = false

  setupIPC()
  listProjects() // Run the real core projects / RAG-document migration.

  // The remaining tables are supplied by Pro activation in the running app. Keep them
  // empty here so universalSearch runs its complete production query set against
  // a genuinely empty corpus instead of short-circuiting on missing optional DDL.
  getDB().exec(`
    -- As Pro's crm/schema.ts creates it.
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      summary TEXT NOT NULL,
      surface TEXT,
      surface_app TEXT,
      url TEXT,
      source_session_id TEXT,
      source_key TEXT,
      memory_id INTEGER,
      category TEXT NOT NULL DEFAULT 'work',
      engagement REAL NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0,
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
      ts DATETIME,
      source TEXT
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

afterAll(async () => {
  await fake.close()
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('rag:chat on an empty memory corpus', () => {
  it('returns the configured transcription language through the registered IPC path', async () => {
    saveSetting('sttLanguage', 'hi')

    const handler = handlers.get('transcription:active-info')
    expect(handler).toBeTypeOf('function')
    const activeInfo = (await handler!({ sender: { send: () => undefined } })) as {
      engine: string
      language: string
      options: Array<{ active: boolean }>
    }
    expect(activeInfo).toMatchObject({ engine: 'whisper', language: 'hi' })
    expect(activeInfo.options.some(({ active }) => active)).toBe(true)

    const { getActiveTranscription } = await import('../transcription/select')
    expect(getActiveTranscription().isAvailable()).toBeTypeOf('boolean')
  })

  it('answers a plain turn on an empty profile and releases the chat seam for the next', async () => {
    const handler = handlers.get('rag:chat')
    expect(handler).toBeTypeOf('function')
    expect(
      getDB()
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM memories) +
             (SELECT COUNT(*) FROM messages) +
             (SELECT COUNT(*) FROM chat_summaries) +
             (SELECT COUNT(*) FROM entities) +
             (SELECT COUNT(*) FROM entity_facts) AS count`
        )
        .get()
    ).toEqual({ count: 0 })

    const event: IpcEvent = { sender: { send: () => undefined } }
    fake.enqueue(
      { content: 'I do not have any saved memory yet, but I can still help.' },
      { content: 'This second response is ready.' }
    )

    // rag:chat is the direct model call (no retrieval); memory is the chat tools loop's.
    const first = (await handler!(
      event,
      'What do you remember about me?',
      'All',
      [],
      null,
      'fresh-chat',
      false,
      'empty-memory-turn-1',
      false,
      []
    )) as { answer: string; context?: unknown }
    expect(first.answer).toBe('I do not have any saved memory yet, but I can still help.')
    expect(first.answer).not.toMatch(/something went wrong/i)
    expect(first.context).toBeUndefined()

    const second = (await handler!(
      event,
      'Can I ask another question?',
      'All',
      [
        { role: 'user', content: 'What do you remember about me?' },
        { role: 'assistant', content: first.answer }
      ],
      null,
      'fresh-chat',
      false,
      'empty-memory-turn-2',
      false,
      []
    )) as { answer: string }
    expect(second.answer).toBe('This second response is ready.')
    expect(fake.requests).toHaveLength(2)
    expect(JSON.stringify(fake.requests[1])).toContain('What do you remember about me?')
  })

  it('retrieves seeded local memory and returns its citation in All memory mode (#34)', async () => {
    fake.requests.length = 0
    const db = getDB()
    const inserted = db
      .prepare(
        `INSERT INTO observations (summary, surface, url, ts)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(
        'Project Aurora uses the release code obsidian.',
        'Synthetic release notes',
        'offgrid://synthetic/aurora'
      )
    db.prepare('INSERT INTO observation_fts(rowid, summary) VALUES (?, ?)').run(
      inserted.lastInsertRowid,
      'Project Aurora uses the release code obsidian.'
    )
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'Aurora release code' } }] },
      { content: 'The Aurora release code is obsidian [S1].' }
    )

    const result = await toolChat('Aurora release code obsidian', [], {
      conversationId: 'seeded-memory-chat',
      allMemory: true
    })

    expect(result.answer).toBe('The Aurora release code is obsidian [S1].')
    expect(result.unified).toEqual([
      expect.objectContaining({
        key: `obs:${Number(inserted.lastInsertRowid)}`,
        refId: Number(inserted.lastInsertRowid),
        surface: 'Synthetic release notes'
      })
    ])
    expect(result.unified[0]!.snippet).toContain('Project Aurora uses the release code obsidian.')
    // The answer's model call saw the cited source with its tag.
    const answerPrompt = JSON.stringify(fake.requests.at(-1)?.messages ?? [])
    expect(answerPrompt).toContain('[S1]')
    expect(answerPrompt).toContain('Project Aurora uses the release code obsidian.')
  })
})
