import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

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
import { HOOKS, registerHook } from '../bootstrap/hookRegistry'
import {
  createDesktopRagService,
  deleteProject,
  ensureRagStoreSchema,
  listProjects,
  createProject
} from '../rag'
import type {
  KnowledgeDocumentMutation,
  KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'

const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const REMOTE_SYNC_ID = '33333333-3333-4333-8333-333333333333'

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('desktop knowledge-document sync owner', () => {
  it('migrates stable identity and suppresses lifecycle echo for synced imports', async () => {
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

    ensureRagStoreSchema()
    const legacy = db
      .prepare('SELECT sync_id FROM rag_documents WHERE name = ?')
      .get('legacy.txt') as { sync_id: string }
    expect(legacy.sync_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )

    createProject({ id: PROJECT_ID, name: 'Shared research' })
    expect(listProjects()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PROJECT_ID })])
    )

    const mutations: KnowledgeDocumentMutation[] = []
    registerHook(HOOKS.syncKnowledgeDocumentMutation, (mutation: KnowledgeDocumentMutation) => {
      mutations.push(mutation)
    })
    const service = createDesktopRagService({
      embeddings: {
        dimension: 1,
        async embed() {
          return [1]
        }
      }
    })

    const localPath = path.join(TMP_DIR, 'local-notes.txt')
    fs.writeFileSync(localPath, 'Local field notes contain enough text to produce one RAG chunk.')
    const indexed = await service.indexDocument({
      projectId: PROJECT_ID,
      path: localPath,
      fileName: 'local-notes.txt',
      size: fs.statSync(localPath).size
    })
    const local = (await service.listDocuments(PROJECT_ID)).find(
      (document) => document.id === indexed.docId
    )
    expect(local?.syncId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(mutations).toEqual([
      {
        kind: 'indexed',
        document: expect.objectContaining({
          syncId: local?.syncId,
          projectId: PROJECT_ID,
          filePath: localPath,
          enabled: true
        })
      }
    ])

    const shortPath = path.join(TMP_DIR, 'op.txt')
    fs.writeFileSync(shortPath, 'op\n')
    const short = await service.indexDocument({
      projectId: PROJECT_ID,
      path: shortPath,
      fileName: 'op.txt',
      size: fs.statSync(shortPath).size
    })
    expect(short.chunkCount).toBe(1)
    expect(
      db
        .prepare('SELECT content, position FROM rag_chunks WHERE doc_id = ?')
        .all(short.docId)
    ).toEqual([{ content: 'op', position: 0 }])
    expect(await service.searchProject(PROJECT_ID, 'op')).toEqual(
      expect.objectContaining({
        chunks: expect.arrayContaining([expect.objectContaining({ content: 'op' })])
      })
    )

    await service.toggleDocument(indexed.docId, false)
    expect(mutations.at(-1)).toEqual({
      kind: 'enabled',
      syncId: local?.syncId,
      enabled: false
    })

    const remotePath = path.join(TMP_DIR, 'remote-notes.txt')
    fs.writeFileSync(remotePath, 'Remote field notes also contain enough text for local indexing.')
    const remote: KnowledgeDocumentSnapshot = {
      syncId: REMOTE_SYNC_ID,
      projectId: PROJECT_ID,
      name: 'remote-notes.txt',
      filePath: remotePath,
      fileSize: fs.statSync(remotePath).size,
      createdAt: '2026-07-28T08:00:00.000Z',
      enabled: true
    }
    const mutationCount = mutations.length
    const remoteId = await service.indexSyncedDocument(remote)
    await service.setSyncedDocumentEnabled(REMOTE_SYNC_ID, false)
    expect(mutations).toHaveLength(mutationCount)
    expect(await service.getDocumentBySyncId(REMOTE_SYNC_ID)).toMatchObject({
      id: remoteId,
      syncId: REMOTE_SYNC_ID,
      enabled: false
    })

    await service.deleteSyncedDocument(REMOTE_SYNC_ID)
    expect(await service.getDocumentBySyncId(REMOTE_SYNC_ID)).toBeUndefined()
    expect(mutations).toHaveLength(mutationCount)

    await service.deleteDocument(indexed.docId)
    expect(mutations.at(-1)).toEqual({ kind: 'deleted', syncId: local?.syncId })

    const projectDocumentPath = path.join(TMP_DIR, 'project-owned.txt')
    fs.writeFileSync(
      projectDocumentPath,
      'Deleting the project should publish this document tombstone after commit.'
    )
    const projectDocument = await service.indexDocument({
      projectId: PROJECT_ID,
      path: projectDocumentPath,
      fileName: 'project-owned.txt',
      size: fs.statSync(projectDocumentPath).size
    })
    const projectDocumentSyncId = (await service.listDocuments(PROJECT_ID)).find(
      (document) => document.id === projectDocument.docId
    )?.syncId

    deleteProject(PROJECT_ID)

    expect(await service.getDocumentBySyncId(projectDocumentSyncId!)).toBeUndefined()
    expect(mutations.at(-1)).toEqual({
      kind: 'deleted',
      syncId: projectDocumentSyncId
    })
  })
})
