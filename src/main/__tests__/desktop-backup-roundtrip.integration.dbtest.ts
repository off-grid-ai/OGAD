import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { BackupEngine, type BackupSink } from '@offgrid/sync/portable'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopBackupArchive } from '../backup/archive'
import { DesktopBackupDataPort } from '../backup/data-port'
import { DesktopBackupFileMapper } from '../backup/file-mapper'
import { documentStore } from '../documents/sqlite-store'
import { configureRuntime } from '../runtime-env'
import { addRagMessage, createRagConversation, getDB } from '../database'
import { createProject, ensureRagStoreSchema, insertRagDocument, updateProject } from '../rag/store'
import { registerDesktopBackupIPC, type BackupIpcBoundary } from '../backup/ipc'
import type { DesktopBackupDelivery, DesktopBackupEngine } from '../backup'
import { BACKUP_EXPORT_ALL_CHANNEL, BACKUP_IMPORT_CHANNEL } from '../../shared/backup-contracts'

const roots: string[] = []
const databases: Database.Database[] = []

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `offgrid-backup-${label}-`))
  roots.push(root)
  return root
}

class PathSink implements BackupSink<DesktopBackupDelivery> {
  picked: string | null = null

  async deliverFile(absPath: string): Promise<DesktopBackupDelivery> {
    this.picked = absPath
    return { canceled: false, path: absPath }
  }

  async pickFile(): Promise<string | null> {
    return this.picked
  }
}

class BackupIpcHarness implements BackupIpcBoundary {
  private readonly handlers = new Map<string, (event: unknown) => Promise<unknown>>()

  handle(channel: string, handler: (event: unknown) => Promise<unknown>): void {
    this.handlers.set(channel, handler)
  }

  invoke<T>(channel: string): Promise<T> {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`No handler registered for ${channel}`)
    return handler({}) as Promise<T>
  }
}

function engine(db: Database.Database, root: string, sink: PathSink): DesktopBackupEngine {
  return new BackupEngine(
    new DesktopBackupDataPort(db),
    new DesktopBackupFileMapper(),
    new DesktopBackupArchive({ tempDir: root, userDataDir: root }),
    sink,
    () => '2026-07-27T12:00:00.000Z'
  )
}

/** The knowledge-base file's id in the document index, and the text the index read from it. */
const DOCUMENT_ID = 'a'.repeat(64)
const DOCUMENT_TEXT = 'The launch stays local.'

/** The app's own database in a fresh profile at `root`, with the tables its stores create. */
function appDatabase(root: string): Database.Database {
  if (databases.length) getDB().close()
  configureRuntime({ dataDir: root })
  ensureRagStoreSchema()
  const db = getDB()
  databases.push(db)
  return db
}

/** A project with a knowledge file and a chat, made the way the app makes them. */
async function seedSource(root: string): Promise<void> {
  const upload = path.join(root, 'uploads', 'launch-notes.txt')
  fs.mkdirSync(path.dirname(upload), { recursive: true })
  fs.writeFileSync(upload, 'OFFGRID_BACKUP_FILE_EVIDENCE')

  createProject({
    id: 'project-aurora',
    name: 'Aurora',
    description: 'Desktop backup project',
    systemPrompt: 'Answer from the imported notes.',
    icon: 'folder'
  })
  updateProject('project-aurora', { includeMemory: false })
  insertRagDocument({
    projectId: 'project-aurora',
    name: 'Launch notes',
    path: upload,
    size: fs.statSync(upload).size,
    kind: 'text',
    documentId: DOCUMENT_ID,
    syncId: 'sync-launch-notes'
  })
  // What the document engine keeps for the file: its pages, read once.
  await documentStore.putDocument({
    id: DOCUMENT_ID,
    name: 'Launch notes',
    kind: 'text',
    state: 'ready',
    pageCount: 1,
    chunkCount: 1,
    embeddedCount: 1,
    unreadablePages: 0,
    embedder: 'Xenova/all-MiniLM-L6-v2',
    schemaVersion: 1,
    createdAt: 0,
    lastUsedAt: 0
  })
  await documentStore.putPages(DOCUMENT_ID, [{ page: 1, label: 'part 1', text: DOCUMENT_TEXT }])
  createRagConversation('chat-aurora', 'Launch plan', 'project-aurora')
  addRagMessage('chat-aurora', 'user', 'Keep this conversation.', { scope: 'project-aurora' })
}

afterEach(() => {
  if (databases.length) getDB().close()
  databases.length = 0
  configureRuntime({ dataDir: undefined })
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('desktop portable Backup & Restore', () => {
  it('exports and additively restores chats, projects, knowledge files and their text', async () => {
    const sourceRoot = tempRoot('source')
    const targetRoot = tempRoot('target')
    const sourceDb = appDatabase(sourceRoot)
    await seedSource(sourceRoot)

    const sink = new PathSink()
    const delivery = await engine(sourceDb, sourceRoot, sink).exportAll()
    expect(delivery?.path).toMatch(/offgrid-backup-2026-07-27T12-00-00-000Z\.zip$/)

    // Another Mac: an empty profile.
    const targetDb = appDatabase(targetRoot)

    const first = await engine(targetDb, targetRoot, sink).import()
    expect(first).toEqual({
      projectsAdded: 1,
      conversationsAdded: 1,
      messagesAdded: 1,
      documentsAdded: 1
    })

    const restoredDocument = targetDb
      .prepare('SELECT path, enabled, document_id FROM rag_documents WHERE project_id = ?')
      .get('project-aurora') as { path: string; enabled: number; document_id: string }
    expect(restoredDocument.path).toContain(path.join('restored-backups', 'files', 'documents'))
    expect(fs.readFileSync(restoredDocument.path, 'utf8')).toBe('OFFGRID_BACKUP_FILE_EVIDENCE')
    expect(restoredDocument.enabled).toBe(1)
    // The file's text travels as pages under the same document id, so the next project chat indexes
    // and answers from it without the original file being read again.
    expect(restoredDocument.document_id).toBe(DOCUMENT_ID)
    expect(
      targetDb
        .prepare('SELECT page, label, text FROM attached_document_pages WHERE document_id = ?')
        .all(DOCUMENT_ID)
    ).toEqual([{ page: 1, label: 'part 1', text: DOCUMENT_TEXT }])
    expect(
      targetDb.prepare('SELECT name, kind FROM attached_documents WHERE id = ?').get(DOCUMENT_ID)
    ).toEqual({ name: 'Launch notes', kind: 'text' })
    const restored = targetDb.prepare('SELECT content, context FROM rag_messages').get() as {
      content: string
      context: string
    }
    expect(restored.content).toBe('Keep this conversation.')
    expect(JSON.parse(restored.context)).toMatchObject({ scope: 'project-aurora' })

    const second = await engine(targetDb, targetRoot, sink).import()
    expect(second).toEqual({
      projectsAdded: 0,
      conversationsAdded: 0,
      messagesAdded: 0,
      documentsAdded: 0
    })
    expect(targetDb.prepare('SELECT COUNT(*) AS count FROM rag_messages').get()).toEqual({
      count: 1
    })
    expect(targetDb.prepare('SELECT COUNT(*) AS count FROM rag_documents').get()).toEqual({
      count: 1
    })
  })

  it('exports and restores through the desktop IPC boundary', async () => {
    const root = tempRoot('ipc')
    const db = appDatabase(root)
    await seedSource(root)
    const sink = new PathSink()
    const backup = engine(db, root, sink)
    const ipc = new BackupIpcHarness()
    registerDesktopBackupIPC(ipc, backup)

    const delivery = await ipc.invoke<DesktopBackupDelivery>(BACKUP_EXPORT_ALL_CHANNEL)
    expect(delivery.path).toMatch(/offgrid-backup-2026-07-27T12-00-00-000Z\.zip$/)

    db.exec(`
      DELETE FROM attached_document_pages;
      DELETE FROM attached_documents;
      DELETE FROM rag_documents;
      DELETE FROM rag_messages;
      DELETE FROM rag_conversations;
      DELETE FROM projects;
    `)

    await expect(ipc.invoke(BACKUP_IMPORT_CHANNEL)).resolves.toEqual({
      projectsAdded: 1,
      conversationsAdded: 1,
      messagesAdded: 1,
      documentsAdded: 1
    })
    expect(db.prepare('SELECT name FROM projects').get()).toEqual({ name: 'Aurora' })
    expect(db.prepare('SELECT title FROM rag_conversations').get()).toEqual({
      title: 'Launch plan'
    })
    expect(db.prepare('SELECT text FROM attached_document_pages').get()).toEqual({
      text: DOCUMENT_TEXT
    })
  })
})
