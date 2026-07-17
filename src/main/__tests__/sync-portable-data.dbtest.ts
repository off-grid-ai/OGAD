import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_SCHEMA_VERSION } from '@offgrid/sync/portable'
import type { WorkspaceSnapshot } from '@offgrid/sync/portable'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-portable-db-'))

vi.mock('electron', () => ({
  app: { getPath: () => userData, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { getDB } from '../database'
import { desktopVectorStore, listProjects } from '../rag/store'
import { DesktopWorkspaceDataPort } from '../sync-portable/data'
import { ImportJournalStore } from '../sync-portable/import-journal'

afterAll(() => fs.rmSync(userData, { recursive: true, force: true }))

function snapshot(projectId: string, documentId: string): WorkspaceSnapshot {
  const timestamp = '2026-07-17T00:00:00.000Z'
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    selection: { kind: 'all' },
    workspaces: [],
    projects: [
      {
        id: projectId,
        name: 'Private research',
        description: '',
        systemPrompt: '',
        createdAt: timestamp,
        updatedAt: timestamp
      }
    ],
    conversations: [],
    messages: [],
    documents: [
      {
        id: documentId,
        projectId,
        name: 'knowledge.txt',
        kind: 'text',
        size: 22,
        createdAt: timestamp,
        enabled: true,
        archiveKey: `files/documents/${documentId}`,
        textContent: 'searchable private fact'
      }
    ],
    attachments: []
  }
}

describe('DesktopWorkspaceDataPort (real SQLite and filesystem)', () => {
  it('commits searchable chunks and compensates files when SQLite rejects an import', async () => {
    listProjects() // initializes the owning desktop RAG schema
    const db = getDB()
    const adapter = new DesktopWorkspaceDataPort(
      db,
      async () => ({
        chunks: [{ content: 'searchable private fact', position: 0 }],
        embeddings: [[1, 0, 0]]
      }),
      new ImportJournalStore(userData, db)
    )
    const staged = path.join(userData, 'sync-portable', 'stages', 'stage-success', 'document')
    const destination = path.join(userData, 'sync-files', 'knowledge.txt')
    fs.mkdirSync(path.dirname(staged), { recursive: true })
    fs.writeFileSync(staged, 'searchable private fact')
    const digest = createHash('sha256').update('searchable private fact').digest('hex')

    const result = await adapter.applyAtomically(
      snapshot('project-portable', 'document-portable'),
      {
        collisionPolicy: 'reject',
        files: [
          {
            key: 'files/documents/document-portable',
            size: 22,
            sha256: digest,
            stagedPath: staged,
            destinationPath: destination
          }
        ]
      }
    )

    expect(result.documentsAdded).toBe(1)
    expect(fs.readFileSync(destination, 'utf8')).toBe('searchable private fact')
    expect(await desktopVectorStore.getChunkCandidates('project-portable')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: 'searchable private fact', embedding: [1, 0, 0] })
      ])
    )

    const textOnly = snapshot('project-text-only', 'document-text-only')
    delete textOnly.documents[0]!.archiveKey
    textOnly.documents[0]!.textContent = 'searchable text-only mobile knowledge'
    const textOnlyResult = await adapter.applyAtomically(textOnly, {
      collisionPolicy: 'reject',
      files: []
    })
    const textOnlyRow = db
      .prepare('SELECT path FROM rag_documents WHERE portable_id = ?')
      .get('document-text-only') as { path: string }
    expect(textOnlyResult.documentsAdded).toBe(1)
    expect(textOnlyRow.path).toContain(path.join('sync-files', 'documents'))
    expect(fs.readFileSync(textOnlyRow.path, 'utf8')).toBe('searchable text-only mobile knowledge')
    expect(await desktopVectorStore.getChunkCandidates('project-text-only')).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'searchable private fact' })])
    )

    const emptyDocument = snapshot('project-empty-document', 'document-empty')
    delete emptyDocument.documents[0]!.archiveKey
    delete emptyDocument.documents[0]!.textContent
    await expect(
      adapter.applyAtomically(emptyDocument, { collisionPolicy: 'reject', files: [] })
    ).rejects.toThrow('must contain a file or non-empty extracted text')
    expect(
      db.prepare('SELECT id FROM projects WHERE id = ?').get('project-empty-document')
    ).toBeUndefined()

    db.exec(`CREATE TRIGGER reject_portable_document BEFORE INSERT ON rag_documents
      WHEN NEW.portable_id = 'document-rejected' BEGIN SELECT RAISE(ABORT, 'test rejection'); END`)
    const rejectedStage = path.join(
      userData,
      'sync-portable',
      'stages',
      'stage-rejected',
      'document'
    )
    const rejectedDestination = path.join(userData, 'sync-files', 'rejected.txt')
    fs.mkdirSync(path.dirname(rejectedStage), { recursive: true })
    fs.writeFileSync(rejectedStage, 'searchable private fact')

    await expect(
      adapter.applyAtomically(snapshot('project-rejected', 'document-rejected'), {
        collisionPolicy: 'reject',
        files: [
          {
            key: 'files/documents/document-rejected',
            size: 22,
            sha256: digest,
            stagedPath: rejectedStage,
            destinationPath: rejectedDestination
          }
        ]
      })
    ).rejects.toThrow('test rejection')
    expect(fs.existsSync(rejectedDestination)).toBe(false)
    expect(fs.existsSync(rejectedStage)).toBe(false)
    expect(
      db.prepare('SELECT id FROM projects WHERE id = ?').get('project-rejected')
    ).toBeUndefined()

    db.prepare('INSERT INTO rag_conversations (id, title) VALUES (?, ?)').run(
      'corrupt-context-conversation',
      'Corrupt context'
    )
    db.prepare(
      'INSERT INTO rag_messages (portable_id, conversation_id, role, content, context) VALUES (?, ?, ?, ?, ?)'
    ).run('corrupt-context-message', 'corrupt-context-conversation', 'user', 'hello', '{not json')
    await expect(
      adapter.collect({ kind: 'conversation', id: 'corrupt-context-conversation' })
    ).rejects.toThrow('invalid JSON')
    db.prepare('UPDATE rag_messages SET context = ?, role = ? WHERE portable_id = ?').run(
      '{}',
      'alien',
      'corrupt-context-message'
    )
    await expect(
      adapter.collect({ kind: 'conversation', id: 'corrupt-context-conversation' })
    ).rejects.toThrow('unsupported role')
  })
})
