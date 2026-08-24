// Fresh-profile integration coverage for RELEASE_TEST_CHECKLIST #35.
//
// This invokes the REAL `rag:chat` handler registered by setupIPC, over the REAL
// SQLite schema, retrieval queries, prompt assembly, modality queue, and LLM
// transport. Only true process boundaries are faked: Electron registration,
// MiniLM embeddings, LanceDB, and llama-server (a real loopback HTTP socket).
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

vi.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.01) })
}))

vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({
    tableNames: async () => [],
    openTable: async () => {
      throw new Error('no vector table in a fresh profile')
    }
  })
}))

import { getDB, saveSetting } from '../database'
import { setupIPC } from '../ipc'
import { llm } from '../llm'
import { listProjects } from '../rag/store'

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

  it('answers without context and releases the chat seam for the next turn', async () => {
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

    const streamed: Array<{ channel: string; payload: unknown }> = []
    const event: IpcEvent = {
      sender: {
        send: (channel, payload) => streamed.push({ channel, payload })
      }
    }

    fake.enqueue(
      { content: '{"intent":"chat","urls":[]}' },
      { content: 'I do not have any saved memory yet, but I can still help.' },
      { content: '{"intent":"chat","urls":[]}' },
      { content: 'This second response is ready.' }
    )

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
    )) as {
      answer: string
      context: Record<string, unknown[]>
    }

    expect(first.answer).toBe('I do not have any saved memory yet, but I can still help.')
    expect(first.answer).not.toMatch(/something went wrong/i)
    expect(first.context).toMatchObject({
      memories: [],
      messages: [],
      summaries: [],
      entities: [],
      entityFacts: [],
      unified: []
    })
    const modelPrompt = JSON.stringify(fake.requests[1]?.messages ?? [])
    expect(modelPrompt).toContain('RELEVANT MEMORIES:\\n(none)')
    expect(modelPrompt).toContain('RELEVANT MESSAGES:\\n(none)')
    expect(modelPrompt).toContain('RELEVANT SUMMARIES:\\n(none)')
    expect(modelPrompt).toContain('RELEVANT ENTITIES:\\n(none)')
    expect(modelPrompt).toContain('RELEVANT ENTITY FACTS:\\n(none)')
    expect(streamed).toContainEqual({
      channel: 'rag:stream',
      payload: {
        streamId: 'empty-memory-turn-1',
        type: 'step',
        step: {
          kind: 'memory',
          counts: { memories: 0, messages: 0, summaries: 0, entities: 0, facts: 0, unified: 0 }
        }
      }
    })

    const second = (await handler!(
      event,
      'Can I ask another question?',
      'All',
      [],
      null,
      'fresh-chat',
      false,
      'empty-memory-turn-2',
      false,
      []
    )) as { answer: string }

    expect(second.answer).toBe('This second response is ready.')
    expect(fake.requests).toHaveLength(4)
  })

  it('retrieves seeded local memory and returns its citation in All memory mode (#34)', async () => {
    const handler = handlers.get('rag:chat')
    expect(handler).toBeTypeOf('function')
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

    const streamed: Array<{ channel: string; payload: unknown }> = []
    const event: IpcEvent = {
      sender: {
        send: (channel, payload) => streamed.push({ channel, payload })
      }
    }
    fake.enqueue(
      { content: '{"intent":"chat","urls":[]}' },
      { content: 'The Aurora release code is obsidian [S1].' }
    )

    const result = (await handler!(
      event,
      'Aurora release code obsidian',
      'All',
      [],
      null,
      'seeded-memory-chat',
      false,
      'seeded-memory-turn',
      false,
      []
    )) as {
      answer: string
      context: { unified: Array<{ refId: number; snippet: string; surface: string }> }
    }

    expect(result.answer).toBe('The Aurora release code is obsidian [S1].')
    expect(result.context.unified).toEqual([
      expect.objectContaining({
        refId: Number(inserted.lastInsertRowid),
        snippet: 'Project Aurora uses the release code obsidian.',
        surface: 'Synthetic release notes'
      })
    ])
    const answerPrompt = JSON.stringify(fake.requests.at(-1)?.messages ?? [])
    expect(answerPrompt).toContain('[S1]')
    expect(answerPrompt).toContain('Project Aurora uses the release code obsidian.')
    expect(streamed).toContainEqual({
      channel: 'rag:stream',
      payload: {
        streamId: 'seeded-memory-turn',
        type: 'step',
        step: {
          kind: 'memory',
          counts: expect.objectContaining({ unified: 1 })
        }
      }
    })
  })
})
