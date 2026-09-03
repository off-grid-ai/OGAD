/**
 * High-leverage integration coverage for the complete project-memory lifecycle.
 *
 * This drives the same IPC handlers as the renderer through real file extraction,
 * chunking, SQLite persistence, scoped retrieval, prompt assembly, deletion, and
 * profile reopen. Only process boundaries are controlled: Electron registration,
 * the MiniLM/LanceDB runtimes, and llama-server tokens over a real loopback socket.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startFakeLlamaServer, type FakeLlamaServer,
  installFakeActiveTextModel
} from './harness/fake-llama-server'

interface IpcEvent {
  sender: { send: (channel: string, payload: unknown) => void }
}

type IpcHandler = (event: IpcEvent, ...args: unknown[]) => unknown

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-memory-rag-lifecycle-'))
// Pin the data dir before any main module loads: runtime-env resolves it from this variable, so an
// unpinned test would read and WRITE the developer's real profile (<cwd>/.offgrid).
process.env.OFFGRID_DATA_DIR = PROFILE_DIR
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
  BrowserWindow: { fromWebContents: () => undefined },
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

vi.mock('@xenova/transformers', () => ({
  env: {},
  pipeline: async () => async () => ({ data: new Float32Array(384).fill(0.01) })
}))

vi.mock('@lancedb/lancedb', () => ({
  connect: async () => ({
    tableNames: async () => [],
    openTable: async () => {
      throw new Error('no external vector table in this profile')
    }
  })
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
    import('../llm'),
    // The real app registers Shared LLM, generation, residency, and embedding
    // services at its composition root before it accepts IPC work.
    import('../model-services')
  ])
  const service = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  service.port = fake.port
  service.initialized = true
  service.paused = false
  setupIPC()
  setupRagIPC()
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return (await handler(channel)(event, ...args)) as T
}

function lastModelPrompt(): string {
  return JSON.stringify(fake.requests.at(-1)?.messages ?? [])
}

beforeAll(async () => {
  // The chat route is the one durable selection the real shared inventory reads; the socket stays
  // the only inference fake.
  installFakeActiveTextModel(PROFILE_DIR)
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

    const memory = await invoke<{ id: number }>('db:add-memory', capturedMemory, 'integration-test')
    expect(Number(memory.id)).toBeGreaterThan(0)

    const currentConversation = 'cedar-current'
    const siblingConversation = 'cedar-sibling'
    const otherConversation = 'cedar-other-project'
    await invoke('rag:create-conversation', currentConversation, 'Current', selectedProjectId)
    await invoke('rag:create-conversation', siblingConversation, 'Sibling', selectedProjectId)
    await invoke('rag:create-conversation', otherConversation, 'Other', otherProjectId)
    await invoke('rag:add-message', currentConversation, 'user', currentStoredContext)
    await invoke('rag:add-message', siblingConversation, 'user', siblingContext)
    await invoke('rag:add-message', otherConversation, 'user', otherChatContext)

    fake.enqueue({ content: 'Cedar context is grounded.' })
    const initial = await invoke<{
      answer: string
      context: { sources: Array<{ name: string }>; projectChats: number }
    }>(
      'rag:chat',
      'What is the Cedar release status?',
      'All',
      [],
      selectedProjectId,
      currentConversation,
      false,
      'cedar-initial',
      false,
      []
    )

    expect(initial.answer).toBe('Cedar context is grounded.')
    expect(initial.context.sources.map((source) => source.name)).toEqual(
      expect.arrayContaining(['selected-plan.md', 'Captured memory'])
    )
    expect(initial.context.projectChats).toBe(1)
    expect(lastModelPrompt()).toContain(oldDocumentFact)
    expect(lastModelPrompt()).toContain(capturedMemory)
    expect(lastModelPrompt()).toContain(siblingContext)
    expect(lastModelPrompt()).not.toContain(currentStoredContext)
    expect(lastModelPrompt()).not.toContain(otherDocumentFact)
    expect(lastModelPrompt()).not.toContain(otherChatContext)

    await invoke('projects:update', selectedProjectId, { includeMemory: false })
    fake.enqueue({ content: 'Captured memory is disabled for this project.' })
    const withoutMemory = await invoke<{
      context: { sources: Array<{ name: string }>; projectChats: number }
    }>(
      'rag:chat',
      'What is the Cedar release status?',
      'All',
      [],
      selectedProjectId,
      currentConversation,
      false,
      'cedar-memory-disabled',
      false,
      []
    )
    expect(withoutMemory.context.sources.map((source) => source.name)).toContain('selected-plan.md')
    expect(withoutMemory.context.sources.map((source) => source.name)).not.toContain(
      'Captured memory'
    )
    expect(lastModelPrompt()).toContain(oldDocumentFact)
    expect(lastModelPrompt()).not.toContain(capturedMemory)
    expect(lastModelPrompt()).toContain(siblingContext)

    expect(await invoke('db:delete-memory', Number(memory.id))).toBe(true)
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

    fake.enqueue({ content: 'The reindexed Cedar plan is active.' })
    await invoke(
      'rag:chat',
      'What is the Cedar release status now?',
      'All',
      [],
      selectedProjectId,
      currentConversation,
      false,
      'cedar-reindexed',
      false,
      []
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
      reopenedDb.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(memory.id)
    ).toEqual({ count: 0 })
    expect(
      reopenedDb
        .prepare('SELECT COUNT(*) AS count FROM rag_chunks WHERE content = ?')
        .get(oldDocumentFact)
    ).toEqual({ count: 0 })

    fake.enqueue({ content: 'The reopened Cedar project is still grounded.' })
    const reopened = await invoke<{
      answer: string
      context: { sources: Array<{ name: string }>; projectChats: number }
    }>(
      'rag:chat',
      'Confirm the Cedar status after restart.',
      'All',
      [],
      selectedProjectId,
      currentConversation,
      false,
      'cedar-reopened',
      false,
      []
    )
    expect(reopened.answer).toBe('The reopened Cedar project is still grounded.')
    expect(reopened.context.sources.map((source) => source.name)).toEqual(['selected-plan.md'])
    expect(reopened.context.projectChats).toBe(1)
    expect(lastModelPrompt()).toContain(newDocumentFact)
    expect(lastModelPrompt()).toContain(siblingContext)
    expect(lastModelPrompt()).not.toContain(oldDocumentFact)
    expect(lastModelPrompt()).not.toContain(capturedMemory)
    expect(lastModelPrompt()).not.toContain(currentStoredContext)
    expect(lastModelPrompt()).not.toContain(otherDocumentFact)
    expect(lastModelPrompt()).not.toContain(otherChatContext)
  })
})
