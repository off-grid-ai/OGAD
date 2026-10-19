// Integration tests for projects and their knowledge bases (src/main/rag/*) against a REAL temp
// SQLite DB. store.ts calls getDB() from database.ts, which imports `electron`; we fake ONLY that
// boundary (app paths, safeStorage, and a window list with no windows) pointed at a fresh mkdtemp
// dir. Knowledge-base files go through the real files.ts reader into the real document engine
// (documents/*), so every assertion exercises real SQL, real extraction, real indexing and real
// search. The embedding model is the one uncontrolled runtime: the profile's model folder is
// pinned to a missing one, so the product's own "folder unavailable" path skips vectors and
// search runs on the real keyword index, never on whatever model this machine has downloaded.

import { describe, it, expect, afterAll, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { textLayerPdf } from './fixtures/synthetic-pdf'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ragstore-it-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import * as store from '../rag/store'
import { knowledgeBase } from '../rag'
import { addRagMessage, createRagConversation, getDB, searchProjectConversations } from '../database'
import { documentStore, documentTurns } from '../documents'
import { DesktopBackupDataPort } from '../backup/data-port'
import { configureRuntime } from '../runtime-env'

configureRuntime({ dataDir: TMP_DIR, modelsDir: path.join(TMP_DIR, 'model-folder-not-connected') })

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function writeFile(name: string, content: string | Buffer): string {
  const filePath = path.join(TMP_DIR, 'picked', name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  return filePath
}

async function addFile(
  projectId: string,
  name: string,
  content: string | Buffer
): Promise<import('@offgrid/rag').RagDocument> {
  const filePath = writeFile(name, content)
  return knowledgeBase.addFile({
    projectId,
    path: filePath,
    fileName: name,
    size: fs.statSync(filePath).size
  })
}

/** The document engine's state for a file, once it has finished reading and indexing it. */
async function finishedIndexing(
  documentId: string
): Promise<import('@offgrid/rag/documents').StoredDocument> {
  await vi.waitFor(
    async () => {
      const state = (await documentStore.getDocument(documentId))?.state
      expect(state === 'ready' || state === 'failed').toBe(true)
    },
    { timeout: 10_000, interval: 50 }
  )
  return (await documentStore.getDocument(documentId))!
}

async function projectSearch(
  projectId: string,
  query: string
): Promise<import('@offgrid/rag/documents').FoundPassage[]> {
  return documentTurns.searchPassages({ projectId }, query)
}

describe('rag/store.ts - projects CRUD', () => {
  it('searches sibling conversations only inside the selected project', async () => {
    store.createProject({ id: 'p-chat-search', name: 'Chat search' })
    store.createProject({ id: 'p-chat-private', name: 'Other project' })
    createRagConversation('chat-current', 'Current', 'p-chat-search')
    createRagConversation('chat-sibling', 'Sibling', 'p-chat-search')
    createRagConversation('chat-other', 'Other', 'p-chat-private')
    addRagMessage('chat-current', 'user', 'Quartz budget is 200')
    addRagMessage('chat-sibling', 'user', 'Quartz budget is 300')
    addRagMessage('chat-other', 'user', 'Quartz budget is 400')

    expect(searchProjectConversations('p-chat-search', 'Quartz budget', 'chat-current')).toEqual([
      { role: 'user', content: 'Quartz budget is 300', title: 'Sibling' }
    ])
    const { runTool } = await import('../tools')
    const result = await runTool(
      'search_knowledge_base',
      { query: 'Quartz budget' },
      { projectId: 'p-chat-search', conversationId: 'chat-current' },
      []
    )
    expect(result.text).toContain('Quartz budget is 300')
    expect(result.text).not.toContain('Quartz budget is 200')
    expect(result.text).not.toContain('Quartz budget is 400')
  })

  it('createProject + listProjects round-trips fields and includeMemory default (on)', () => {
    store.createProject({ id: 'p1', name: 'Alpha', description: 'first', systemPrompt: 'be terse' })
    const projects = store.listProjects()
    const p = projects.find((x) => x.id === 'p1')
    expect(p).toBeTruthy()
    expect(p?.name).toBe('Alpha')
    expect(p?.description).toBe('first')
    expect(p?.systemPrompt).toBe('be terse')
    // include_memory defaults to 1 -> includeMemory true.
    expect(p?.includeMemory).toBe(true)
  })

  it('createProject applies empty defaults for optional fields', () => {
    store.createProject({ id: 'p-min', name: 'Minimal' })
    const p = store.listProjects().find((x) => x.id === 'p-min')
    expect(p?.description).toBe('')
    expect(p?.systemPrompt).toBe('')
    expect(p?.icon).toBeUndefined()
  })

  it('updateProject patches only the provided fields', () => {
    store.createProject({ id: 'p2', name: 'Beta', description: 'orig' })
    store.updateProject('p2', { description: 'patched', includeMemory: false })
    const p = store.listProjects().find((x) => x.id === 'p2')
    expect(p?.name).toBe('Beta') // untouched
    expect(p?.description).toBe('patched')
    expect(p?.includeMemory).toBe(false)
  })

  it('updateProject with an empty patch is a no-op (does not throw)', () => {
    store.createProject({ id: 'p-noop', name: 'NoOp' })
    expect(() => store.updateProject('p-noop', {})).not.toThrow()
    expect(store.listProjects().find((x) => x.id === 'p-noop')?.name).toBe('NoOp')
  })

  it('projectIncludesMemory reflects the persisted flag and defaults true for unknown projects', () => {
    store.createProject({ id: 'p-mem', name: 'Mem' })
    expect(store.projectIncludesMemory('p-mem')).toBe(true)
    store.updateProject('p-mem', { includeMemory: false })
    expect(store.projectIncludesMemory('p-mem')).toBe(false)
    // Unknown project defaults to true.
    expect(store.projectIncludesMemory('no-such-project')).toBe(true)
  })

  it('deleteProject removes the project and its knowledge-base files', async () => {
    store.createProject({ id: 'p-del', name: 'Doomed' })
    await addFile('p-del', 'doomed-notes.txt', 'Doomed project notes about the Basalt migration plan.')

    store.deleteProject('p-del')
    expect(store.listProjects().find((x) => x.id === 'p-del')).toBeUndefined()
    expect(knowledgeBase.listDocuments('p-del')).toHaveLength(0)
    expect(await projectSearch('p-del', 'Basalt migration')).toEqual([])
  })
})

describe('knowledge base over the document engine', () => {
  it('adds a file: listed at once, kept by content, then searchable in its project', async () => {
    const projectId = 'p-attach-document'
    const quartzFact = 'Project Quartz launches in October after the final accessibility review.'
    const harborFact = 'Project Harbor remains in research while the battery study is repeated.'
    const content = `${quartzFact}\n\n${harborFact}`
    store.createProject({ id: projectId, name: 'Attach document' })

    const added = await addFile(projectId, 'field-notes.md', content)

    const documentId = crypto.createHash('sha256').update(content).digest('hex')
    expect(knowledgeBase.listDocuments(projectId)).toEqual([
      expect.objectContaining({
        id: added.id,
        projectId,
        name: 'field-notes.md',
        size: Buffer.byteLength(content),
        kind: 'text',
        enabled: true,
        documentId
      })
    ])
    // The file is kept by content inside the profile, so the picked original can move or go.
    expect(added.path.startsWith(TMP_DIR)).toBe(true)
    expect(fs.readFileSync(added.path, 'utf8')).toBe(content)

    const indexed = await finishedIndexing(documentId)
    expect(indexed).toMatchObject({ state: 'ready', name: 'field-notes.md', pageCount: 1 })
    expect(indexed.chunkCount).toBeGreaterThan(0)

    const found = await projectSearch(projectId, 'When does Quartz launch?')
    expect(found[0]).toMatchObject({ documentId, name: 'field-notes.md', page: 1 })
    expect(found[0]!.text).toContain(quartzFact)
  })

  it('grounds a project search in only that project and its enabled files', async () => {
    const selectedProject = 'p-grounded-selected'
    const otherProject = 'p-grounded-other'
    store.createProject({ id: selectedProject, name: 'Selected project' })
    store.createProject({ id: otherProject, name: 'Other project' })

    const current = await addFile(
      selectedProject,
      'current-plan.md',
      'Project Quartz launches on October 14 after accessibility sign-off.'
    )
    const obsolete = await addFile(
      selectedProject,
      'obsolete-plan.md',
      'An obsolete Project Quartz draft says the launch moved to December.'
    )
    const other = await addFile(
      otherProject,
      'private-plan.md',
      'The other project records a confidential Quartz launch in January.'
    )
    for (const document of [current, obsolete, other])
      expect((await finishedIndexing(document.documentId!)).state).toBe('ready')

    await knowledgeBase.toggleDocument(obsolete.id, false)
    expect(knowledgeBase.listDocuments(selectedProject)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'obsolete-plan.md', enabled: false }),
        expect.objectContaining({ name: 'current-plan.md', enabled: true })
      ])
    )

    const selected = await projectSearch(selectedProject, 'When does Quartz launch?')
    expect(selected.map(({ name }) => name)).toEqual(['current-plan.md'])
    expect(selected.map(({ text }) => text).join('\n')).not.toMatch(/December|January/)

    const elsewhere = await projectSearch(otherProject, 'When does Quartz launch?')
    expect(elsewhere.map(({ name }) => name)).toEqual(['private-plan.md'])

    // Turned back on, the file is used again.
    await knowledgeBase.toggleDocument(obsolete.id, true)
    const again = await projectSearch(selectedProject, 'Quartz launch December')
    expect(again.map(({ name }) => name)).toContain('obsolete-plan.md')
  })

  it('uses a note shorter than a line of a page', async () => {
    store.createProject({ id: 'p-short', name: 'Short notes' })
    const note = await addFile('p-short', 'wifi.txt', 'Wi-Fi code: 4417\n')

    const indexed = await finishedIndexing(note.documentId!)
    expect(indexed).toMatchObject({ state: 'ready', unreadablePages: 0 })
    const found = await projectSearch('p-short', 'Wi-Fi code')
    expect(found.map(({ text }) => text)).toEqual(['Wi-Fi code: 4417'])
  })

  it('keeps a damaged PDF in the list as unreadable, and never answers from it', async () => {
    store.createProject({ id: 'p-damaged-pdf', name: 'Damaged PDF' })
    const damaged = await addFile('p-damaged-pdf', 'damaged.pdf', 'this is not a PDF')

    expect(knowledgeBase.listDocuments('p-damaged-pdf')).toEqual([
      expect.objectContaining({ name: 'damaged.pdf', kind: 'pdf' })
    ])
    const indexed = await finishedIndexing(damaged.documentId!)
    expect(indexed.state).toBe('failed')
    expect(indexed.error).toBeTruthy()
    expect(await projectSearch('p-damaged-pdf', 'not a PDF')).toEqual([])
  })

  it('reads a real PDF page by page', async () => {
    store.createProject({ id: 'p-pdf', name: 'PDF' })
    const pdf = await addFile(
      'p-pdf',
      'decision.pdf',
      textLayerPdf('Decision record: the launch moves to the second week of March after the audit.')
    )

    const indexed = await finishedIndexing(pdf.documentId!)
    expect(indexed.state).toBe('ready')
    expect(indexed.chunkCount).toBeGreaterThan(0)
    const [page] = await documentStore.readPages(pdf.documentId!)
    const found = await projectSearch('p-pdf', page!.text.split(/\s+/).slice(0, 4).join(' '))
    expect(found[0]).toMatchObject({ name: 'decision.pdf', page: 1 })
  })

  it('deleting a file removes it, and its index once no other project holds it', async () => {
    store.createProject({ id: 'p-deldoc', name: 'DelDoc' })
    store.createProject({ id: 'p-keepdoc', name: 'KeepDoc' })
    const shared = 'Shared glossary: a Mistral is a cold northern wind.'
    const first = await addFile('p-deldoc', 'glossary.txt', shared)
    const second = await addFile('p-keepdoc', 'glossary.txt', shared)
    expect(second.documentId).toBe(first.documentId)
    await finishedIndexing(first.documentId!)

    await knowledgeBase.deleteDocument(first.id)
    expect(knowledgeBase.listDocuments('p-deldoc')).toHaveLength(0)
    expect(await projectSearch('p-deldoc', 'Mistral wind')).toEqual([])
    // The other project still holds the same content, so its index stays.
    expect(await documentStore.getDocument(first.documentId!)).not.toBeNull()
    expect((await projectSearch('p-keepdoc', 'Mistral wind')).map(({ name }) => name)).toEqual([
      'glossary.txt'
    ])

    await knowledgeBase.deleteDocument(second.id)
    expect(await documentStore.getDocument(first.documentId!)).toBeNull()
  })

  it('indexes a file added before files had document ids when its project is next used', async () => {
    store.createProject({ id: 'p-legacy-row', name: 'Legacy row' })
    const filePath = writeFile('legacy-brief.txt', 'Legacy brief: the Granite audit closes in March.')
    const docId = store.insertRagDocument({
      projectId: 'p-legacy-row',
      name: 'legacy-brief.txt',
      path: filePath,
      size: fs.statSync(filePath).size,
      kind: 'text'
    })
    expect(store.getRagDocument(docId)?.documentId).toBeUndefined()

    const found = await projectSearch('p-legacy-row', 'Granite audit')
    expect(found.map(({ name }) => name)).toEqual(['legacy-brief.txt'])
    expect(store.getRagDocument(docId)?.documentId).toMatch(/^[0-9a-f]{64}$/)
  })

  it('restores a knowledge-base file from an old backup that carried chunks, ready to answer', async () => {
    const port = new DesktopBackupDataPort(getDB())
    const summary = await port.apply({
      surface: 'offgrid-desktop',
      projects: [
        {
          id: 'p-restored',
          name: 'Restored',
          description: '',
          systemPrompt: '',
          includeMemory: false,
          createdAt: '2026-01-01T09:00:00.000Z',
          updatedAt: '2026-01-01T09:00:00.000Z',
          documents: [
            {
              name: 'Contract.pdf',
              path: '/an/old/mac/Contract.pdf',
              size: 42,
              kind: 'pdf',
              enabled: true,
              createdAt: '2026-01-01T09:00:00.000Z',
              chunks: [
                { content: 'The tenant pays rent by the fifth of each month.', position: 1 },
                { content: 'This lease runs for two years from signing.', position: 0 }
              ]
            }
          ]
        }
      ],
      conversations: []
    })
    expect(summary.documentsAdded).toBe(1)

    const [restored] = knowledgeBase.listDocuments('p-restored')
    expect(restored).toMatchObject({ name: 'Contract.pdf', enabled: true })
    expect(restored!.documentId).toBe(
      crypto
        .createHash('sha256')
        .update(
          'This lease runs for two years from signing.\n\nThe tenant pays rent by the fifth of each month.'
        )
        .digest('hex')
    )

    const found = await projectSearch('p-restored', 'When is rent due?')
    expect(found[0]).toMatchObject({ name: 'Contract.pdf', documentId: restored!.documentId })
    expect(found[0]!.text).toContain('The tenant pays rent by the fifth of each month.')
    expect((await documentStore.getDocument(restored!.documentId!))?.state).toBe('ready')
  })
})

// The project_threads/project_messages backend was removed as dead code (D22);
// its CRUD tests went with it. Project chat runs through rag_conversations.
