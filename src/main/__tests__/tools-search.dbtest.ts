// Integration test for the search_memory citation side-channel — REAL toolChat + REAL
// LLMService (fake llama socket) + REAL universalSearch over the REAL, FULL app schema
// (core database.ts + pro's migrateCrm, which creates observations/observation_fts and
// the entities.hidden column universalSearch filters on) + real keyword FTS. The ONLY
// things faked are true external boundaries: the native engine (fake socket), Electron's
// dir, and the two native/heavy libs behind semantic search — @huggingface/transformers (the
// embedding model, which would download) and @lancedb/lancedb (native vector store).
// universalSearch already catches a failed semantic pass and falls back to keyword, so
// the search is deterministic on real FTS with zero mocks of OUR code.
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { startFakeLlamaServer, type FakeLlamaServer } from './harness/fake-llama-server'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-search-it-'))
vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  // Document progress is broadcast to every window; a test has none.
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))
// The embedding model — faked to throw so the semantic pass is skipped (universalSearch
// catches it) and search runs on the real keyword FTS. THE external boundary.
vi.mock('@huggingface/transformers', () => ({
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

import { toolChat, type ToolActivity } from '../tools'
import { llm } from '../llm'
import { deleteSetting, getDB, saveSetting } from '../database'
import { createProject, ensureRagStoreSchema } from '../rag/store'
import { knowledgeBase } from '../rag'
import { documentStore } from '../documents'
import { parseSearchBlock } from '@offgrid/rag/documents'

let fake: FakeLlamaServer

beforeAll(async () => {
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
      category TEXT NOT NULL DEFAULT 'work', ts DATETIME DEFAULT CURRENT_TIMESTAMP, source_key TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observation_fts USING fts5(summary, content='observations', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observation_fts(rowid, summary) VALUES (new.id, new.summary);
    END;
    -- Empty capture tables the post-search thumbnail/boost lookups touch (thumbFor joins
    -- observation_frames→frames for a screen hit); empty is fine → null thumbnail.
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME, source TEXT);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
    CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, transcript TEXT, started_at INTEGER);
    CREATE TABLE IF NOT EXISTS vec_indexed (key TEXT PRIMARY KEY);
  `)
  try {
    db.exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* already present */
  }
  // Projects and their knowledge-base files, as the app migrates them.
  ensureRagStoreSchema()
})
beforeEach(() => {
  fake.reset()
  getDB().exec('DELETE FROM observations; DELETE FROM rag_messages; DELETE FROM rag_conversations')
})
afterAll(async () => {
  await fake.close()
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
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

  it('opens on the newest of everything when nothing is typed, within the chosen sources', async () => {
    const { universalSearch } = await import('../search')
    const db = getDB()
    const at = (summary: string, surface: string, ts: string): string =>
      `obs:${Number(
        db
          .prepare('INSERT INTO observations (summary, surface, category, ts) VALUES (?, ?, ?, ?)')
          .run(summary, surface, 'work', ts).lastInsertRowid
      )}`
    const older = at('Reviewed the quarterly plan', 'Figma', '2026-10-01 09:00:00')
    const newer = at('Answered the release thread', 'Slack', '2026-10-14 09:00:00')

    const recent = await universalSearch('', { limit: 50 })
    const keys = recent.map((hit) => hit.key)
    // Search never opens on an empty page: the feed is newest first.
    expect(keys).toContain(newer)
    expect(keys.indexOf(newer)).toBeLessThan(keys.indexOf(older))

    const figmaOnly = await universalSearch('   ', { limit: 50, sources: ['Figma'] })
    expect(figmaOnly.map((hit) => hit.key)).toContain(older)
    expect(figmaOnly.every((hit) => hit.surface === 'Figma')).toBe(true)
  })
})

/** Add a knowledge-base file through the app's own path and wait until it is indexed. */
async function addKnowledgeFile(
  projectId: string,
  name: string,
  content: string
): Promise<import('@offgrid/rag').RagDocument> {
  const filePath = path.join(TMP_DIR, 'picked', name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  const added = await knowledgeBase.addFile({
    projectId,
    path: filePath,
    fileName: name,
    size: fs.statSync(filePath).size
  })
  await vi.waitFor(
    async () => expect((await documentStore.getDocument(added.documentId!))?.state).toBe('ready'),
    { timeout: 10_000, interval: 50 }
  )
  return added
}

/** A long handbook: too big to give whole, so a turn gives the passages that match. */
function handbook(fact: string): string {
  const filler = (n: number): string =>
    `Section ${n}. Staff read the notice board each morning and log visitors at the front desk. `.repeat(6)
  const sections = Array.from({ length: 60 }, (_, i) => filler(i + 1))
  sections.splice(31, 0, fact)
  return sections.join('\n\n')
}

describe('project chats answer from the knowledge base', () => {
  // These turns read the project's files for every question (Settings → Text → Project knowledge →
  // Every answer); the default, When needed, leaves them to the search tool.
  beforeEach(() => saveSetting('knowledgeBaseRetrieval', 'every-answer'))
  afterAll(() => deleteSetting('knowledgeBaseRetrieval'))
  it('gives a project turn its files as cited passages, never another project-s', async () => {
    createProject({ id: 'p-borealis', name: 'Borealis' })
    createProject({ id: 'p-elsewhere', name: 'Elsewhere' })
    await addKnowledgeFile(
      'p-borealis',
      'kiosk-hours.md',
      'KB_TURN: The Borealis kiosk opens at nine and closes at five.'
    )
    await addKnowledgeFile(
      'p-elsewhere',
      'private-hours.md',
      'KB_PRIVATE: The Borealis kiosk in the other project opens at noon.'
    )
    fake.enqueue({ content: 'It opens at nine [S1].' })
    const activity: string[] = []

    const r = await toolChat('When does the Borealis kiosk open?', [], {
      projectId: 'p-borealis',
      conversationId: 'kb-turn-chat',
      onActivity: (step: ToolActivity) => {
        if (step.kind === 'documents') activity.push(step.label)
      }
    })

    const prompt = JSON.stringify(fake.requests[0]?.messages ?? [])
    expect(prompt).toContain('KB_TURN: The Borealis kiosk opens at nine and closes at five.')
    expect(prompt).not.toContain('KB_PRIVATE')
    expect(r.answer).toBe('It opens at nine [S1].')
    expect(r.unified[0]).toMatchObject({ kind: 'attachment', surface: 'kiosk-hours.md' })
    expect(r.unified.map(({ surface }) => surface)).not.toContain('private-hours.md')
    // The work timeline says what the turn is doing with the files.
    expect(activity).toEqual(expect.arrayContaining(['Opening 1 document…', 'Searching 1 document…']))
  })

  it('numbers search_knowledge_base passages after the turn-s own, reusing a number the turn already gave', async () => {
    createProject({ id: 'p-handbook', name: 'Handbook' })
    const fact = 'KIOSK_FACT: The Borealis kiosk opens at nine on weekdays and at ten on Saturdays.'
    await addKnowledgeFile('p-handbook', 'staff-handbook.md', handbook(fact))
    fake.enqueue(
      { toolCalls: [{ name: 'search_knowledge_base', args: { query: 'Borealis kiosk opens' } }] },
      { content: 'Weekdays at nine [S1, S99].' }
    )

    const r = await toolChat('When does the Borealis kiosk open?', [], {
      projectId: 'p-handbook',
      conversationId: 'kb-tool-chat'
    })

    // Every source is listed once, and each tag in the tool result points at that very passage.
    const keys = r.unified.map(({ key }) => key)
    expect(new Set(keys).size).toBe(keys.length)
    const toolPassages = parseSearchBlock(r.toolCalls[0]!.result)
    expect(toolPassages.length).toBeGreaterThan(0)
    for (const passage of toolPassages) {
      const source = r.unified[Number(passage.id.slice(1)) - 1]
      expect(source).toMatchObject({ kind: 'attachment', surface: 'staff-handbook.md' })
      expect(passage.text.startsWith(source!.snippet)).toBe(true)
    }
    // The fact was already among the turn's own passages, so the tool cites it by the same number;
    // the turn's passages are the first sources, before anything the tool adds.
    const firstPrompt = JSON.stringify(fake.requests[0]?.messages ?? [])
    const turnSources = new Set(firstPrompt.match(/<source id=\\"S\d+\\"/g) ?? []).size
    expect(turnSources).toBeGreaterThan(0)
    const kiosk = toolPassages.find(({ text }) => text.includes('KIOSK_FACT'))!
    expect(Number(kiosk.id.slice(1))).toBeLessThanOrEqual(turnSources)
    expect(firstPrompt).toContain('KIOSK_FACT')
    // A grouped tag is split, and a tag that points at no source is dropped.
    expect(r.answer).toBe('Weekdays at nine [S1].')
    // The project's search stays inside the project: other projects' files are never searched.
    expect(r.toolCalls[0]!.result).not.toMatch(/KB_TURN|KB_PRIVATE/)
    expect(r.unified.map(({ title }) => title).join('\n')).not.toMatch(/kiosk-hours|private-hours/)
  })
})
