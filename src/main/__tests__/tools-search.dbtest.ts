// Integration test for the search_memory citation side-channel — REAL toolChat + REAL
// LLMService (fake llama socket) + REAL universalSearch over the REAL, FULL app schema
// (core database.ts + pro's migrateCrm, which creates observations/observation_fts and
// the entities.hidden column universalSearch filters on) + real keyword FTS. The ONLY
// things faked are true external boundaries: the native engine (fake socket), Electron's
// dir, and the two native/heavy libs behind semantic search — @xenova/transformers (the
// embedding model, which would download) and @lancedb/lancedb (native vector store).
// universalSearch already catches a failed semantic pass and falls back to keyword, so
// the search is deterministic on real FTS with zero mocks of OUR code.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest'
import type { OffGridApplication } from '@offgrid/application'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  installFakeActiveTextModel,
  startFakeLlamaServer,
  type FakeLlamaServer
} from './harness/fake-llama-server'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-search-it-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = TMP_DIR
vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))
// The embedding model — faked to throw so the semantic pass is skipped (universalSearch
// catches it) and search runs on the real keyword FTS. THE external boundary.
vi.mock('@xenova/transformers', () => ({
  pipeline: async () => {
    throw new Error('no embedding model in test')
  },
  env: {}
}))
// Native vector store — minimal fake so search.ts's module import resolves without loading
// the native lib; never actually queried (the semantic pass short-circuits at embeddings).
vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({ openTable: async () => ({}), tableNames: async () => [] })
}))

import { toolChat } from '../tools'
import { llm } from '../llm'
import { getDB } from '../database'

let fake: FakeLlamaServer
let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  installFakeActiveTextModel(TMP_DIR)
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }, applicationAccess] =
    await Promise.all([
      import('@offgrid/application'),
      import('../model-services'),
      import('../composition/application-access')
    ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  releaseApplication = applicationAccess.registerDesktopApplication(application)
  await application.start()
  fake = await startFakeLlamaServer()
  const svc = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  svc.port = fake.port
  svc.initialized = true
  svc.paused = false
  // Core database.ts creates the core FTS tables (summary_fts, entity_fts, …) on getDB().
  // universalSearch ALSO queries the pro capture tables (observations/observation_fts) and
  // filters entities on `hidden`; in the app those come from pro's migrateCrm (crm/schema.ts).
  // Mirror that minimal DDL here so the REAL universalSearch runs all its keyword branches
  // instead of throwing on a missing table. (A core .dbtest can't import pro across the
  // tsconfig/alias boundary; the columns universalSearch reads are stable.)
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, surface TEXT, url TEXT,
      category TEXT NOT NULL DEFAULT 'work', ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observation_fts USING fts5(summary, content='observations', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observation_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
    -- Empty capture tables the post-search thumbnail/boost lookups touch (thumbFor joins
    -- observation_frames→frames for a screen hit); empty is fine → null thumbnail.
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
    CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, transcript TEXT, started_at INTEGER);
    CREATE TABLE IF NOT EXISTS rag_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, project_id TEXT, created_at DATETIME);
    CREATE TABLE IF NOT EXISTS rag_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER, content TEXT);
    CREATE TABLE IF NOT EXISTS vec_indexed (key TEXT PRIMARY KEY);
  `)
  try {
    db.exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* already present */
  }
})
beforeEach(() => {
  fake.reset()
  getDB().exec('DELETE FROM observations; DELETE FROM rag_messages; DELETE FROM rag_conversations')
})
afterAll(async () => {
  await fake.close()
  await application.stop()
  releaseApplication()
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
})

// Seed a real observation; its AFTER INSERT trigger populates observation_fts, so
// universalSearch's real keyword branch finds it. Returns the `obs:<id>` key it surfaces.
function seedObservation(summary: string, surface: string): string {
  const id = Number(
    getDB()
      .prepare('INSERT INTO observations (summary, surface, category) VALUES (?, ?, ?)')
      .run(summary, surface, 'work').lastInsertRowid
  )
  return `obs:${id}`
}

function seedObservationAt(summary: string, surface: string, timestamp: number): string {
  const id = Number(
    getDB()
      .prepare('INSERT INTO observations (summary, surface, category, ts) VALUES (?, ?, ?, ?)')
      .run(summary, surface, 'work', new Date(timestamp).toISOString()).lastInsertRowid
  )
  return `obs:${id}`
}

function seedChat(id: string, title: string, content: string): string {
  const db = getDB()
  db.prepare('INSERT INTO rag_conversations (id, title) VALUES (?, ?)').run(id, title)
  db.prepare('INSERT INTO rag_messages (conversation_id, role, content) VALUES (?, ?, ?)').run(
    id,
    'user',
    content
  )
  return `chat:${id}`
}

describe('search_memory citations — real universalSearch over the real full schema', () => {
  it('surfaces a real keyword hit as a structured citation in r.unified', async () => {
    const key = seedObservation('shipped the Q3 launch on time', 'Note')
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'Q3 launch' } }] },
      { content: 'You shipped the Q3 launch.' }
    )
    const r = await toolChat('what about Q3', [], {
      conversationId: 'chat-current',
      allMemory: true
    })

    const firstRequest = fake.requests[0] as { tools: { function: { name: string } }[] }
    expect(firstRequest.tools.map((tool) => tool.function.name)).toContain('search_memory')

    // Terminal artifact: the citation the renderer builds from the REAL hit.
    const cite = r.unified.find((s) => s.key === key)
    expect(
      cite,
      `expected a citation for ${key} in ${JSON.stringify(r.unified.map((s) => s.key))}`
    ).toBeTruthy()
    expect(cite!.snippet).toContain('Q3 launch')
    expect(cite!.surface).toBe('Note')
    expect(r.answer).toBe('You shipped the Q3 launch.')
  })

  it('dedups citations across multiple search rounds by key', async () => {
    const k1 = seedObservation('the alpha project kickoff', 'Note')
    const k2 = seedObservation('the beta project review', 'Note')
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'alpha' } }] }, // round 1 -> alpha only
      { toolCalls: [{ name: 'search_memory', args: { query: 'project' } }] }, // round 2 -> both
      { content: 'done' }
    )
    const r = await toolChat('dig deeper', [], { allMemory: true })
    const keys = r.unified.map((s) => s.key)
    expect(keys.filter((k) => k === k1)).toHaveLength(1) // alpha once despite two rounds returning it
    expect(keys).toContain(k2) // beta added
  })

  it('yields the empty-memory text and no citations when nothing matches', async () => {
    seedObservation('unrelated content about weather', 'Note')
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'zzzznomatch' } }] },
      { content: 'I could not find anything.' }
    )
    const r = await toolChat('anything?', [], { allMemory: true })
    expect(r.unified).toEqual([])
    expect(r.toolCalls[0]!.result).toMatch(/nothing found in memory/i)
  })

  it('finds a past chat through the shared Search service and keeps its navigation target', async () => {
    const key = seedChat(
      'conversation-release',
      'Release decision',
      'We chose the starling rollout for Friday.'
    )
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'starling rollout' } }] },
      { content: 'The rollout is planned for Friday.' }
    )

    const result = await toolChat('When is the starling rollout?', [], {
      conversationId: 'conversation-current',
      allMemory: true
    })

    const source = result.unified.find((item) => item.key === key)
    expect(source?.kind).toBe('chat')
    expect(source?.url).toBe('conversation-release')
    expect(source?.snippet).toContain('starling rollout')
    expect(result.answer).toBe('The rollout is planned for Friday.')
  })

  it('applies the user-requested local day even when the model shortens its tool query', async () => {
    const today = seedObservationAt('reviewed atlas planning', 'Meeting', Date.now())
    const older = seedObservationAt(
      'reviewed atlas planning',
      'Meeting',
      Date.now() - 3 * 24 * 60 * 60 * 1000
    )
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'atlas planning' } }] },
      { content: 'You reviewed Atlas planning today.' }
    )

    const result = await toolChat('What did I work on today?', [], { allMemory: true })
    const keys = result.unified.map((source) => source.key)

    expect(keys).toContain(today)
    expect(keys).not.toContain(older)
  })
})
