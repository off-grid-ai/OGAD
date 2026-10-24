/**
 * High-leverage integration coverage for the complete project-memory lifecycle.
 *
 * This drives the same IPC handlers as the renderer through real file reading, the
 * document engine, SQLite persistence, the project search tool, prompt assembly,
 * deletion, and profile reopen. Only process boundaries are controlled: Electron
 * registration, the embedding model, and llama-server tokens over a real loopback socket.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startFakeLlamaServer, type FakeLlamaServer } from './harness/fake-llama-server'

interface IpcEvent {
  sender: { send: (channel: string, payload: unknown) => void }
}

type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-memory-rag-lifecycle-'))
const handlers = new Map<string, IpcHandler>()
const boundary = vi.hoisted(() => ({ selectedPaths: [] as string[] }))

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.40',
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
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
  clipboard: { readText: () => '', writeText: () => undefined },
  systemPreferences: {
    isTrustedAccessibilityClient: () => true,
    getMediaAccessStatus: () => 'granted'
  },
  shell: { openExternal: async () => undefined, openPath: async () => '' },
  desktopCapturer: { getSources: async () => [] },
  dialog: {
    showOpenDialog: async () => ({
      canceled: boundary.selectedPaths.length === 0,
      filePaths: [...boundary.selectedPaths]
    })
  }
}))

// The feature-extraction pipeline's contract: one text gives a [1, 384] tensor, a batch gives
// [n, 384]; `data` is the flat buffer and `tolist()` the rows.
vi.mock('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => async (input: string | string[]) => {
    const rows = (Array.isArray(input) ? input : [input]).map(() => new Array(384).fill(0.01))
    return { data: Float32Array.from(rows.flat()), dims: [rows.length, 384], tolist: () => rows }
  }
}))

const event: IpcEvent = { sender: { send: () => undefined } }
let fake: FakeLlamaServer

function handler(channel: string): IpcHandler {
  const registered = handlers.get(channel)
  expect(registered, `${channel} must be registered`).toBeTypeOf('function')
  return registered!
}

async function bootApplicationModules(): Promise<void> {
  handlers.clear()
  const [{ setupIPC }, { setupRagIPC }, { llm }] = await Promise.all([
    import('../ipc'),
    import('../rag-ipc'),
    import('../llm')
  ])
  const service = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  service.port = fake.port
  service.initialized = true
  service.paused = false
  setupIPC()
  setupRagIPC()
  await createCaptureTables()
}

/**
 * Captured-memory search (universalSearch) also reads the screen-capture tables, which Pro creates
 * in the running app. They are created empty here, as rag-empty-memory does, so the search runs
 * every one of its production queries.
 */
async function createCaptureTablesNow(): Promise<void> {
  const { getDB } = await import('../database')
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT NOT NULL, surface TEXT, surface_app TEXT,
      url TEXT, source_session_id TEXT, source_key TEXT, memory_id INTEGER,
      category TEXT NOT NULL DEFAULT 'work', engagement REAL NOT NULL DEFAULT 0,
      salience REAL NOT NULL DEFAULT 0, ts DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS observation_fts USING fts5(summary, content='observations', content_rowid='id');
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, text TEXT, surface TEXT, url TEXT, ts DATETIME, source TEXT);
    CREATE TABLE IF NOT EXISTS observation_frames (observation_id INTEGER, frame_id INTEGER);
    CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, transcript TEXT, started_at INTEGER);
  `)
  try {
    getDB().exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* already present */
  }
}
const createCaptureTables = createCaptureTablesNow

/** A captured screen moment, as Pro's capture pipeline stores it. */
async function captureMoment(summary: string): Promise<number> {
  const { getDB } = await import('../database')
  const id = Number(
    getDB().prepare("INSERT INTO observations (summary, surface) VALUES (?, 'Notes')").run(summary)
      .lastInsertRowid
  )
  getDB().prepare('INSERT INTO observation_fts(rowid, summary) VALUES (?, ?)').run(id, summary)
  return id
}

/** The user deletes a captured moment (Pro's capture deletion removes the row and its text). */
async function deleteMoment(id: number, summary: string): Promise<void> {
  const { getDB } = await import('../database')
  getDB()
    .prepare("INSERT INTO observation_fts(observation_fts, rowid, summary) VALUES ('delete', ?, ?)")
    .run(id, summary)
  getDB().prepare('DELETE FROM observations WHERE id = ?').run(id)
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await handler(channel)(event, ...args)) as T
}

function lastModelPrompt(): string {
  return JSON.stringify(fake.requests.at(-1)?.messages ?? [])
}

interface ProjectAnswer {
  answer: string
  unified: Array<{ kind: string; surface: string; snippet: string }>
}

/**
 * A project chat turn through the handler the renderer uses. The model looks the project up with
 * search_knowledge_base (its documents, its other chats and, when the project includes it, captured
 * memory), then answers.
 */
async function askProject(
  projectId: string,
  conversationId: string,
  question: string,
  reply: string
): Promise<ProjectAnswer> {
  fake.enqueue(
    { toolCalls: [{ name: 'search_knowledge_base', args: { query: 'Cedar' } }] },
    { content: reply }
  )
  return invoke<ProjectAnswer>('tools:chat', question, [], { projectId, conversationId })
}

const projectFiles = (answer: ProjectAnswer): string[] => [
  ...new Set(
    answer.unified.filter(({ kind }) => kind === 'attachment').map(({ surface }) => surface)
  )
]
/** Whether the answer drew on captured memory (a screen moment). */
const usedMemory = (answer: ProjectAnswer): boolean =>
  answer.unified.some(({ kind }) => kind === 'screen')

/** The knowledge-base list once every file has been read and indexed. */
async function settled(
  projectId: string
): Promise<Array<{ id: number; name: string; enabled: boolean }>> {
  let rows: Array<{ id: number; name: string; enabled: boolean; state?: string }> = []
  await vi.waitFor(
    async () => {
      rows = await invoke('projects:list-documents', projectId)
      expect(rows.every(({ state }) => state === 'ready')).toBe(true)
    },
    { timeout: 10_000, interval: 50 }
  )
  return rows
}

beforeAll(async () => {
  fake = await startFakeLlamaServer()
  await bootApplicationModules()
})

afterAll(async () => {
  const { getDB } = await import('../database')
  if (getDB().open) getDB().close()
  await fake.close()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('memory -> RAG -> scoped chat lifecycle', () => {
  it('keeps project grounding isolated through policy changes, delete/reindex, and reopen', async () => {
    const selectedDocument = path.join(PROFILE_DIR, 'selected-plan.md')
    const otherDocument = path.join(PROFILE_DIR, 'other-plan.md')
    const oldDocumentFact = 'LIFECYCLE_OLD_DOC: Project Cedar ships on Tuesday after QA approval.'
    const newDocumentFact =
      'LIFECYCLE_NEW_DOC: Project Cedar ships on Friday after security approval.'
    const otherDocumentFact =
      'LIFECYCLE_OTHER_DOC: Project Cedar is cancelled in the private project.'
    const capturedMemory = 'LIFECYCLE_CAPTURED_MEMORY: The Cedar owner is Priya.'
    const siblingContext = 'LIFECYCLE_SIBLING_CHAT: Legal approved the Cedar release language.'
    const currentStoredContext = 'LIFECYCLE_CURRENT_CHAT_DB_ONLY: Do not inject this as a sibling.'
    const otherChatContext = 'LIFECYCLE_OTHER_CHAT: Finance rejected the Cedar release.'

    fs.writeFileSync(selectedDocument, oldDocumentFact)
    fs.writeFileSync(otherDocument, otherDocumentFact)

    const selectedProjectId = await invoke<string>('projects:create', {
      name: 'Cedar release',
      systemPrompt: 'Answer only from this project context.'
    })
    const otherProjectId = await invoke<string>('projects:create', { name: 'Private project' })

    boundary.selectedPaths = [selectedDocument]
    expect(await invoke('projects:add-documents', selectedProjectId)).toEqual({ added: 1 })
    boundary.selectedPaths = [otherDocument]
    expect(await invoke('projects:add-documents', otherProjectId)).toEqual({ added: 1 })

    const memoryId = await captureMoment(capturedMemory)
    expect(memoryId).toBeGreaterThan(0)

    const currentConversation = 'cedar-current'
    const siblingConversation = 'cedar-sibling'
    const otherConversation = 'cedar-other-project'
    await invoke('rag:create-conversation', currentConversation, 'Current', selectedProjectId)
    await invoke('rag:create-conversation', siblingConversation, 'Sibling', selectedProjectId)
    await invoke('rag:create-conversation', otherConversation, 'Other', otherProjectId)
    await invoke('rag:add-message', currentConversation, 'user', currentStoredContext)
    await invoke('rag:add-message', siblingConversation, 'user', siblingContext)
    await invoke('rag:add-message', otherConversation, 'user', otherChatContext)

    await settled(selectedProjectId)
    await settled(otherProjectId)

    const initial = await askProject(
      selectedProjectId,
      currentConversation,
      'What is the Cedar release status?',
      'Cedar context is grounded.'
    )

    expect(initial.answer).toBe('Cedar context is grounded.')
    expect(projectFiles(initial)).toEqual(['selected-plan.md'])
    expect(usedMemory(initial)).toBe(true)
    expect(lastModelPrompt()).toContain(oldDocumentFact)
    expect(lastModelPrompt()).toContain(capturedMemory)
    expect(lastModelPrompt()).toContain(siblingContext)
    expect(lastModelPrompt()).not.toContain(currentStoredContext)
    expect(lastModelPrompt()).not.toContain(otherDocumentFact)
    expect(lastModelPrompt()).not.toContain(otherChatContext)

    await invoke('projects:update', selectedProjectId, { includeMemory: false })
    const withoutMemory = await askProject(
      selectedProjectId,
      currentConversation,
      'What is the Cedar release status?',
      'Captured memory is disabled for this project.'
    )
    expect(projectFiles(withoutMemory)).toContain('selected-plan.md')
    expect(usedMemory(withoutMemory)).toBe(false)
    expect(lastModelPrompt()).toContain(oldDocumentFact)
    expect(lastModelPrompt()).not.toContain(capturedMemory)
    expect(lastModelPrompt()).toContain(siblingContext)

    await deleteMoment(memoryId, capturedMemory)
    const [oldDocument] = await invoke<Array<{ id: number; name: string }>>(
      'projects:list-documents',
      selectedProjectId
    )
    expect(oldDocument?.name).toBe('selected-plan.md')
    await invoke('projects:delete-document', oldDocument!.id)
    fs.writeFileSync(selectedDocument, newDocumentFact)
    boundary.selectedPaths = [selectedDocument]
    expect(await invoke('projects:add-documents', selectedProjectId)).toEqual({ added: 1 })
    await invoke('projects:update', selectedProjectId, { includeMemory: true })
    await settled(selectedProjectId)

    await askProject(
      selectedProjectId,
      currentConversation,
      'What is the Cedar release status now?',
      'The reindexed Cedar plan is active.'
    )
    expect(lastModelPrompt()).toContain(newDocumentFact)
    expect(lastModelPrompt()).not.toContain(oldDocumentFact)
    expect(lastModelPrompt()).not.toContain(capturedMemory)

    const { getDB } = await import('../database')
    getDB().close()
    vi.resetModules()
    await bootApplicationModules()

    const projects = await invoke<Array<{ id: string; includeMemory: boolean }>>('projects:list')
    expect(projects).toContainEqual(
      expect.objectContaining({ id: selectedProjectId, includeMemory: true })
    )
    expect(await invoke('projects:list-documents', selectedProjectId)).toEqual([
      expect.objectContaining({ name: 'selected-plan.md', enabled: true })
    ])
    expect(await invoke('rag:get-messages', siblingConversation)).toEqual([
      expect.objectContaining({ role: 'user', content: siblingContext })
    ])

    const reopenedDb = (await import('../database')).getDB()
    expect(
      reopenedDb.prepare('SELECT COUNT(*) AS count FROM observations WHERE id = ?').get(memoryId)
    ).toEqual({ count: 0 })
    // The replaced file's text left the document index: nothing holds it any more.
    expect(
      reopenedDb
        .prepare('SELECT COUNT(*) AS count FROM attached_document_pages WHERE text = ?')
        .get(oldDocumentFact)
    ).toEqual({ count: 0 })

    const reopened = await askProject(
      selectedProjectId,
      currentConversation,
      'Confirm the Cedar status after restart.',
      'The reopened Cedar project is still grounded.'
    )
    expect(reopened.answer).toBe('The reopened Cedar project is still grounded.')
    expect(projectFiles(reopened)).toEqual(['selected-plan.md'])
    expect(lastModelPrompt()).toContain(newDocumentFact)
    expect(lastModelPrompt()).toContain(siblingContext)
    expect(lastModelPrompt()).not.toContain(oldDocumentFact)
    expect(lastModelPrompt()).not.toContain(capturedMemory)
    expect(lastModelPrompt()).not.toContain(currentStoredContext)
    expect(lastModelPrompt()).not.toContain(otherDocumentFact)
    expect(lastModelPrompt()).not.toContain(otherChatContext)
  })

  it('includes captured memory in an All-memory answer through the public chat handler', async () => {
    const fact = 'The Aurora release owner is Priya and the release code is obsidian.'
    const id = await captureMoment(fact)
    fake.enqueue(
      { toolCalls: [{ name: 'search_memory', args: { query: 'Aurora release owner' } }] },
      { content: 'Priya owns the Aurora release, code obsidian.' }
    )
    const reply = await invoke<ProjectAnswer>('tools:chat', 'Who owns the Aurora release?', [], {
      conversationId: 'aurora-memory-chat',
      allMemory: true
    })
    expect(reply.answer).toBe('Priya owns the Aurora release, code obsidian.')
    expect(reply.unified).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'screen', snippet: expect.stringContaining(fact) })
      ])
    )
    expect(lastModelPrompt()).toContain(fact)
    await deleteMoment(id, fact)
  })
})
