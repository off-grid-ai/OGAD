// Integration tests for the desktop RAG VectorStore + projects/threads CRUD
// (src/main/rag/store.ts) against a REAL temp SQLite DB. store.ts calls getDB()
// from database.ts, which imports `electron`; we mock ONLY that boundary (app +
// safeStorage) pointed at a fresh mkdtemp dir. The store's own migrate() creates
// the projects/documents/chunks/threads tables in that real file, so every
// assertion exercises real SQL, real transactions, and real embedding JSON
// round-trips - no mocks of our logic.

import { describe, it, expect, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ragstore-it-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import * as store from '../rag/store'
import { getDB } from '../database'
import { desktopExtraction } from '../rag/extractors'
import { RagService, type EmbeddingProvider } from '@offgrid/rag'

function keywordEmbeddings(...keywords: string[]): EmbeddingProvider {
  return {
    dimension: keywords.length,
    async embed(text) {
      const normalized = text.toLowerCase()
      return keywords.map((keyword) => Number(normalized.includes(keyword)))
    }
  }
}

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('rag/store.ts - projects CRUD', () => {
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

  it('deleteProject removes the project and its documents/chunks', async () => {
    store.createProject({ id: 'p-del', name: 'Doomed' })
    const docId = await store.desktopVectorStore.addDocument({
      projectId: 'p-del',
      name: 'doc.txt',
      path: '/tmp/doc.txt',
      size: 10,
      kind: 'text'
    })
    await store.desktopVectorStore.addChunks(docId, [{ content: 'c', position: 0 }], [[0.1, 0.2]])

    store.deleteProject('p-del')
    expect(store.listProjects().find((x) => x.id === 'p-del')).toBeUndefined()
    expect(await store.desktopVectorStore.listDocuments('p-del')).toHaveLength(0)
    // chunks for the deleted doc are gone.
    const chunks = getDB()
      .prepare('SELECT COUNT(*) AS c FROM rag_chunks WHERE doc_id = ?')
      .get(docId) as { c: number }
    expect(chunks.c).toBe(0)
  })
})

describe('rag/store.ts - VectorStore documents + chunks', () => {
  it('extracts, chunks, persists, and retrieves an attached knowledge document', async () => {
    const projectId = 'p-attach-document'
    const filePath = path.join(TMP_DIR, 'field-notes.md')
    const quartzFact = 'Project Quartz launches in October after the final accessibility review.'
    const harborFact = 'Project Harbor remains in research while the battery study is repeated.'
    fs.writeFileSync(filePath, `${quartzFact}\n\n${harborFact}`)
    store.createProject({ id: projectId, name: 'Attach document' })
    store.updateProject(projectId, { includeMemory: false })

    // MiniLM is an uncontrollable local-model boundary in this suite. This faithful
    // deterministic provider preserves semantic separation while all Off Grid AI
    // extraction, chunking, storage, and retrieval code stays real.
    const service = new RagService({
      store: store.desktopVectorStore,
      embeddings: keywordEmbeddings('quartz', 'harbor'),
      extraction: desktopExtraction,
      chunkOptions: { chunkSize: 80, overlap: 0, minChunkLength: 20 }
    })
    const stages: string[] = []

    const indexed = await service.indexDocument(
      {
        projectId,
        path: filePath,
        fileName: 'field-notes.md',
        size: fs.statSync(filePath).size
      },
      (stage) => stages.push(stage)
    )

    expect(indexed).toMatchObject({ kind: 'text', chunkCount: 2 })
    expect(stages).toEqual(['extracting', 'chunking', 'embedding', 'indexing', 'done'])

    const documents = await service.listDocuments(projectId)
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({
      id: indexed.docId,
      name: 'field-notes.md',
      path: filePath,
      size: fs.statSync(filePath).size,
      kind: 'text',
      enabled: true
    })

    const candidates = await store.desktopVectorStore.getChunkCandidates(projectId)
    expect(candidates).toHaveLength(2)
    expect(candidates.map((candidate) => candidate.content)).toEqual([quartzFact, harborFact])

    const search = await service.searchProject(projectId, 'When does Quartz launch?', { topK: 1 })
    expect(search.chunks).toHaveLength(1)
    expect(search.chunks[0]).toMatchObject({
      docId: indexed.docId,
      name: 'field-notes.md',
      content: quartzFact,
      position: 0
    })
    expect(service.formatForPrompt(search)).toContain(
      `[Source: field-notes.md (part 1)]\n${quartzFact}`
    )

    const rows = getDB()
      .prepare(
        `SELECT COUNT(DISTINCT d.id) AS documents, COUNT(c.id) AS chunks
         FROM rag_documents d
         JOIN rag_chunks c ON c.doc_id = d.id
         WHERE d.project_id = ?`
      )
      .get(projectId) as { documents: number; chunks: number }
    expect(rows).toEqual({ documents: 1, chunks: 2 })
  })

  it('grounds retrieval in only the selected project and its enabled documents', async () => {
    const selectedProject = 'p-grounded-selected'
    const otherProject = 'p-grounded-other'
    store.createProject({ id: selectedProject, name: 'Selected project' })
    store.createProject({ id: otherProject, name: 'Other project' })
    store.updateProject(selectedProject, { includeMemory: false })
    store.updateProject(otherProject, { includeMemory: false })

    const files = [
      {
        projectId: selectedProject,
        name: 'current-plan.md',
        content: 'Project Quartz launches on October 14 after accessibility sign-off.'
      },
      {
        projectId: selectedProject,
        name: 'obsolete-plan.md',
        content: 'An obsolete Project Quartz draft says the launch moved to December.'
      },
      {
        projectId: otherProject,
        name: 'private-plan.md',
        content: 'The other project records a confidential Quartz launch in January.'
      }
    ] as const
    const service = new RagService({
      store: store.desktopVectorStore,
      embeddings: keywordEmbeddings('quartz'),
      extraction: desktopExtraction
    })

    const indexed = new Map<string, number>()
    for (const file of files) {
      const filePath = path.join(TMP_DIR, file.name)
      fs.writeFileSync(filePath, file.content)
      const result = await service.indexDocument({
        projectId: file.projectId,
        path: filePath,
        fileName: file.name,
        size: fs.statSync(filePath).size
      })
      indexed.set(file.name, result.docId)
    }
    await service.toggleDocument(indexed.get('obsolete-plan.md')!, false)

    // Precondition: all three chunks really exist. The missing results below must
    // come from production project/enabled filtering, not an incomplete fixture.
    const persisted = getDB()
      .prepare(
        `SELECT d.project_id, d.name, d.enabled, COUNT(c.id) AS chunks
         FROM rag_documents d
         JOIN rag_chunks c ON c.doc_id = d.id
         WHERE d.project_id IN (?, ?)
         GROUP BY d.id
         ORDER BY d.name`
      )
      .all(selectedProject, otherProject) as {
      project_id: string
      name: string
      enabled: number
      chunks: number
    }[]
    expect(persisted).toHaveLength(3)
    expect(persisted.every((row) => row.chunks === 1)).toBe(true)
    expect(persisted.find((row) => row.name === 'obsolete-plan.md')?.enabled).toBe(0)

    const selected = await service.searchProject(selectedProject, 'When does Quartz launch?')
    expect(selected.chunks).toEqual([
      expect.objectContaining({
        docId: indexed.get('current-plan.md'),
        name: 'current-plan.md',
        content: files[0].content
      })
    ])
    const selectedPrompt = service.formatForPrompt(selected)
    expect(selectedPrompt).toContain(`[Source: current-plan.md (part 1)]\n${files[0].content}`)
    expect(selectedPrompt).not.toContain('obsolete-plan.md')
    expect(selectedPrompt).not.toContain('private-plan.md')
    expect(selectedPrompt).not.toContain('December')
    expect(selectedPrompt).not.toContain('January')

    const other = await service.searchProject(otherProject, 'When does Quartz launch?')
    expect(other.chunks).toEqual([
      expect.objectContaining({
        docId: indexed.get('private-plan.md'),
        name: 'private-plan.md',
        content: files[2].content
      })
    ])
  })

  it('rejects a damaged PDF during extraction without leaving a half-indexed document', async () => {
    const projectId = 'p-damaged-pdf'
    const filePath = path.join(TMP_DIR, 'damaged.pdf')
    fs.writeFileSync(filePath, 'this is not a PDF')
    store.createProject({ id: projectId, name: 'Damaged PDF' })

    // Embeddings are an uncontrollable model-runtime boundary and must never be
    // reached for an extraction failure. Throwing here makes that invariant visible.
    const embeddings: EmbeddingProvider = {
      dimension: 1,
      async embed() {
        throw new Error('embedding runtime must not run for a damaged document')
      }
    }
    const service = new RagService({
      store: store.desktopVectorStore,
      embeddings,
      extraction: desktopExtraction
    })
    const stages: string[] = []

    await expect(
      service.indexDocument(
        {
          projectId,
          path: filePath,
          fileName: 'damaged.pdf',
          size: fs.statSync(filePath).size
        },
        (stage) => stages.push(stage)
      )
    ).rejects.toThrow('Invalid PDF structure')

    expect(stages).toEqual(['extracting'])
    expect(await store.desktopVectorStore.listDocuments(projectId)).toHaveLength(0)
    const chunks = getDB()
      .prepare(
        `SELECT COUNT(*) AS c
         FROM rag_chunks c
         JOIN rag_documents d ON d.id = c.doc_id
         WHERE d.project_id = ?`
      )
      .get(projectId) as { c: number }
    expect(chunks.c).toBe(0)
  })

  it('addDocument returns a rowid and listDocuments maps rows back to RagDocument', async () => {
    store.createProject({ id: 'p-docs', name: 'Docs' })
    const id = await store.desktopVectorStore.addDocument({
      projectId: 'p-docs',
      name: 'notes.md',
      path: '/tmp/notes.md',
      size: 42,
      kind: 'text'
    })
    expect(id).toBeGreaterThan(0)
    const docs = await store.desktopVectorStore.listDocuments('p-docs')
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      id,
      projectId: 'p-docs',
      name: 'notes.md',
      path: '/tmp/notes.md',
      size: 42,
      kind: 'text',
      enabled: true
    })
    expect(typeof docs[0]!.createdAt).toBe('string')
  })

  it('setDocumentEnabled toggles the enabled flag (0/1 -> boolean)', async () => {
    store.createProject({ id: 'p-toggle', name: 'Toggle' })
    const id = await store.desktopVectorStore.addDocument({
      projectId: 'p-toggle',
      name: 'x',
      path: '/x',
      size: 1,
      kind: 'text'
    })
    await store.desktopVectorStore.setDocumentEnabled(id, false)
    expect((await store.desktopVectorStore.listDocuments('p-toggle'))[0]!.enabled).toBe(false)
    await store.desktopVectorStore.setDocumentEnabled(id, true)
    expect((await store.desktopVectorStore.listDocuments('p-toggle'))[0]!.enabled).toBe(true)
  })

  it('getChunkCandidates returns enabled-doc chunks with parsed embeddings', async () => {
    store.createProject({ id: 'p-cand', name: 'Cand' })
    // opt OUT of captured memories so we assert only on the uploaded-doc chunks.
    store.updateProject('p-cand', { includeMemory: false })
    const id = await store.desktopVectorStore.addDocument({
      projectId: 'p-cand',
      name: 'doc',
      path: '/d',
      size: 1,
      kind: 'text'
    })
    await store.desktopVectorStore.addChunks(
      id,
      [
        { content: 'chunk zero', position: 0 },
        { content: 'chunk one', position: 1 }
      ],
      [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6]
      ]
    )
    const cands = await store.desktopVectorStore.getChunkCandidates('p-cand')
    expect(cands).toHaveLength(2)
    const zero = cands.find((c) => c.content === 'chunk zero')
    expect(zero?.embedding).toEqual([0.1, 0.2, 0.3])
    expect(zero?.docId).toBe(id)
  })

  it('getChunkCandidates excludes chunks from disabled documents', async () => {
    store.createProject({ id: 'p-disabled', name: 'Disabled' })
    store.updateProject('p-disabled', { includeMemory: false })
    const id = await store.desktopVectorStore.addDocument({
      projectId: 'p-disabled',
      name: 'doc',
      path: '/d',
      size: 1,
      kind: 'text'
    })
    await store.desktopVectorStore.addChunks(id, [{ content: 'hidden', position: 0 }], [[1, 0]])
    await store.desktopVectorStore.setDocumentEnabled(id, false)
    expect(await store.desktopVectorStore.getChunkCandidates('p-disabled')).toHaveLength(0)
  })

  it('getChunkCandidates folds captured memories in when includeMemory is on', async () => {
    store.createProject({ id: 'p-withmem', name: 'WithMem' }) // includeMemory defaults on
    // seed a captured memory with an embedding directly in the shared memories table.
    getDB()
      .prepare(
        'INSERT INTO memories (content, source_app, session_id, embedding) VALUES (?, ?, ?, ?)'
      )
      .run('a captured thought', 'App', 'sess', JSON.stringify([0.9, 0.8]))
    const cands = await store.desktopVectorStore.getChunkCandidates('p-withmem')
    const mem = cands.find((c) => c.name === 'Captured memory')
    expect(mem).toBeTruthy()
    expect(mem?.embedding).toEqual([0.9, 0.8])
    // captured memories are stored with a negative synthetic docId.
    expect(mem?.docId).toBeLessThan(0)
  })

  it('deleteDocument removes the document and its chunks in one transaction', async () => {
    store.createProject({ id: 'p-deldoc', name: 'DelDoc' })
    const id = await store.desktopVectorStore.addDocument({
      projectId: 'p-deldoc',
      name: 'doc',
      path: '/d',
      size: 1,
      kind: 'text'
    })
    await store.desktopVectorStore.addChunks(id, [{ content: 'c', position: 0 }], [[0.1]])
    await store.desktopVectorStore.deleteDocument(id)
    expect(await store.desktopVectorStore.listDocuments('p-deldoc')).toHaveLength(0)
    const chunks = getDB()
      .prepare('SELECT COUNT(*) AS c FROM rag_chunks WHERE doc_id = ?')
      .get(id) as { c: number }
    expect(chunks.c).toBe(0)
  })
})

// The project_threads/project_messages backend was removed as dead code (D22);
// its CRUD tests went with it. Project chat runs through rag_conversations.
