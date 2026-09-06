import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CORE_SYNC_ENTITIES,
  createOffGridApplication,
  type ModelsPlatformPorts,
  type OffGridApplication,
  type SyncMutation
} from '@offgrid/application'
import type { RemoteServerConfiguration } from '@offgrid/models'
import { afterAll, describe, expect, it, vi } from 'vitest'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-knowledge-sync-owner-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { getDB } from '../database'
import {
  createProject,
  deleteProject,
  desktopVectorStore,
  listProjects,
  projectExists
} from '../rag'
import { desktopExtraction } from '../rag/extractors'

const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const REMOTE_SYNC_ID = '33333333-3333-4333-8333-333333333333'

function modelBoundary(): ModelsPlatformPorts {
  const selections = new Map<string, string | null>()
  let remoteConfiguration: RemoteServerConfiguration = {
    version: 1,
    activeServerId: null,
    servers: []
  }
  return {
    selection: {
      read: (modality) => selections.get(modality) ?? null,
      write: (modality, routeId) => {
        selections.set(modality, routeId)
      }
    },
    memory: {
      current: () => ({ totalMB: 16_000, availableMB: 8_000, platform: 'desktop' })
    },
    remote: {
      configuration: {
        read: () => remoteConfiguration,
        write: (value) => {
          remoteConfiguration = value
        }
      },
      credentials: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined
      },
      providers: {
        register: async () => undefined,
        unregister: async () => undefined
      },
      activateManaged: async () => ({})
    }
  }
}

const recorded: SyncMutation[] = []
const application: OffGridApplication = createOffGridApplication({
  models: modelBoundary(),
  rag: {
    store: desktopVectorStore,
    embeddings: { dimension: 1, embed: async () => [1] },
    extraction: desktopExtraction,
    projectExists: async (projectId) => projectExists(projectId)
  },
  pro: {
    sync: {
      state: {
        record: (mutation) => {
          recorded.push(mutation)
        },
        sendKnowledgeDocument: async () => undefined
      }
    }
  }
})

afterAll(async () => {
  await application.stop()
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('desktop knowledge-document application owner', () => {
  it('keeps stable identity and does not echo synced imports', async () => {
    const db = getDB()
    db.exec(`
      CREATE TABLE rag_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'text',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO rag_documents (project_id, name, path, size, kind)
      VALUES ('legacy-project', 'legacy.txt', '/legacy.txt', 12, 'text');
    `)

    const legacyDocuments = await application.rag.listDocuments('legacy-project')
    expect(legacyDocuments.ok).toBe(true)
    if (!legacyDocuments.ok) return
    expect(legacyDocuments.value[0]?.syncId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )

    createProject({ id: PROJECT_ID, name: 'Shared research' })
    expect(listProjects()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PROJECT_ID })])
    )

    const localPath = path.join(TMP_DIR, 'local-notes.txt')
    fs.writeFileSync(localPath, 'Local field notes contain enough text to produce one RAG chunk.')
    const indexed = await application.rag.addDocument({
      projectId: PROJECT_ID,
      path: localPath,
      fileName: 'local-notes.txt',
      size: fs.statSync(localPath).size
    })
    expect(indexed.ok).toBe(true)
    if (!indexed.ok) return

    const localDocuments = await application.rag.listDocuments(PROJECT_ID)
    expect(localDocuments.ok).toBe(true)
    if (!localDocuments.ok) return
    const local = localDocuments.value.find((document) => document.id === indexed.value.docId)
    expect(local?.syncId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(recorded.at(-1)).toMatchObject({
      entity: CORE_SYNC_ENTITIES.knowledgeDocument,
      entityId: local?.syncId,
      kind: 'put',
      fields: { project_id: PROJECT_ID, name: 'local-notes.txt', enabled: 1 }
    })

    const shortPath = path.join(TMP_DIR, 'op.txt')
    fs.writeFileSync(shortPath, 'op\n')
    const short = await application.rag.addDocument({
      projectId: PROJECT_ID,
      path: shortPath,
      fileName: 'op.txt',
      size: fs.statSync(shortPath).size
    })
    expect(short).toMatchObject({ ok: true, value: { chunkCount: 1 } })
    if (!short.ok) return
    expect(
      db.prepare('SELECT content, position FROM rag_chunks WHERE doc_id = ?').all(short.value.docId)
    ).toEqual([{ content: 'op', position: 0 }])
    await expect(application.rag.search(PROJECT_ID, 'op')).resolves.toMatchObject({
      ok: true,
      value: { chunks: expect.arrayContaining([expect.objectContaining({ content: 'op' })]) }
    })

    await application.rag.setDocumentEnabled(indexed.value.docId, false)
    expect(recorded.at(-1)).toMatchObject({
      entityId: local?.syncId,
      kind: 'put',
      fields: { enabled: 0 }
    })

    const remotePath = path.join(TMP_DIR, 'remote-notes.txt')
    fs.writeFileSync(remotePath, 'Remote field notes also contain enough text for local indexing.')
    const mutationCount = recorded.length
    const remote = await application.rag.sync.index({
      syncId: REMOTE_SYNC_ID,
      projectId: PROJECT_ID,
      name: 'remote-notes.txt',
      filePath: remotePath,
      fileSize: fs.statSync(remotePath).size,
      createdAt: '2026-07-28T08:00:00.000Z',
      enabled: true
    })
    expect(remote.ok).toBe(true)
    await application.rag.sync.setEnabled(REMOTE_SYNC_ID, false)
    expect(recorded).toHaveLength(mutationCount)
    await expect(application.rag.documentBySyncId(REMOTE_SYNC_ID)).resolves.toMatchObject({
      ok: true,
      value: { syncId: REMOTE_SYNC_ID, enabled: false }
    })

    await application.rag.sync.remove(REMOTE_SYNC_ID)
    await expect(application.rag.documentBySyncId(REMOTE_SYNC_ID)).resolves.toEqual({
      ok: true,
      value: undefined
    })
    expect(recorded).toHaveLength(mutationCount)

    await application.rag.removeDocument(indexed.value.docId)
    expect(recorded.at(-1)).toEqual({
      entity: CORE_SYNC_ENTITIES.knowledgeDocument,
      entityId: local?.syncId,
      kind: 'delete'
    })

    const projectDocumentPath = path.join(TMP_DIR, 'project-owned.txt')
    fs.writeFileSync(
      projectDocumentPath,
      'Deleting the project should publish this document tombstone after commit.'
    )
    const projectDocument = await application.rag.addDocument({
      projectId: PROJECT_ID,
      path: projectDocumentPath,
      fileName: 'project-owned.txt',
      size: fs.statSync(projectDocumentPath).size
    })
    expect(projectDocument.ok).toBe(true)
    if (!projectDocument.ok) return
    const projectDocumentRecord = await application.rag.document(projectDocument.value.docId)
    expect(projectDocumentRecord.ok).toBe(true)
    if (!projectDocumentRecord.ok) return

    await expect(application.workflows.deleteProject(PROJECT_ID)).resolves.toEqual({
      ok: true,
      value: undefined
    })
    deleteProject(PROJECT_ID)

    await expect(application.rag.document(projectDocument.value.docId)).resolves.toEqual({
      ok: true,
      value: undefined
    })
    expect(recorded).toEqual(
      expect.arrayContaining([
        {
          entity: CORE_SYNC_ENTITIES.knowledgeDocument,
          entityId: projectDocumentRecord.value?.syncId,
          kind: 'delete'
        },
        { entity: CORE_SYNC_ENTITIES.project, entityId: PROJECT_ID, kind: 'delete' }
      ])
    )
  })
})
