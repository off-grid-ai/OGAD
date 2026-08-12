import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'
import { BackupEngine, type BackupSink } from '@offgrid/sync/portable'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopBackupArchive } from '../backup/archive'
import { DesktopBackupDataPort } from '../backup/data-port'
import { DesktopBackupFileMapper } from '../backup/file-mapper'
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

function database(root: string): Database.Database {
  const db = new Database(path.join(root, 'memories.db'))
  databases.push(db)
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      icon TEXT,
      include_memory INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE rag_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'text',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      position INTEGER NOT NULL,
      embedding TEXT
    );
    CREATE TABLE rag_conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE rag_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL
    );
  `)
  return db
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

/**
 * A fixed vector for restored chunks, so this journey does not depend on whether MiniLM happens to be loadable
 * on the machine running it. With the real embedder this asserted `embedding: null` locally (no model, so the
 * restore's documented fallback kept the null) and a 384-float vector in CI (model present) - the same test
 * describing two different outcomes. What the journey is about is that the vector REACHES the row.
 */
const FIXED_EMBEDDING = [0.11, 0.22, 0.33]

function engine(db: Database.Database, root: string, sink: PathSink): DesktopBackupEngine {
  return new BackupEngine(
    new DesktopBackupDataPort(db, async () => FIXED_EMBEDDING),
    new DesktopBackupFileMapper(),
    new DesktopBackupArchive({ tempDir: root, userDataDir: root }),
    sink,
    () => '2026-07-27T12:00:00.000Z'
  )
}

function seedSource(db: Database.Database, root: string): void {
  const upload = path.join(root, 'uploads', 'launch-notes.txt')
  fs.mkdirSync(path.dirname(upload), { recursive: true })
  fs.writeFileSync(upload, 'OFFGRID_BACKUP_FILE_EVIDENCE')

  db.prepare(
    `INSERT INTO projects
      (id, name, description, system_prompt, icon, include_memory, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'project-aurora',
    'Aurora',
    'Desktop backup project',
    'Answer from the imported notes.',
    'folder',
    0,
    '2026-07-20T10:00:00.000Z',
    '2026-07-21T10:00:00.000Z'
  )
  const document = db
    .prepare(
      `INSERT INTO rag_documents
        (project_id, name, path, size, kind, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'project-aurora',
      'Launch notes',
      upload,
      fs.statSync(upload).size,
      'text',
      1,
      '2026-07-20T11:00:00.000Z'
    )
  db.prepare(
    'INSERT INTO rag_chunks (doc_id, content, position, embedding) VALUES (?, ?, ?, ?)'
  ).run(Number(document.lastInsertRowid), 'The launch stays local.', 0, '[0.1,0.2]')
  db.prepare(
    `INSERT INTO rag_conversations (id, title, project_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    'chat-aurora',
    'Launch plan',
    'project-aurora',
    '2026-07-20T12:00:00.000Z',
    '2026-07-20T12:05:00.000Z'
  )
  db.prepare(
    `INSERT INTO rag_messages
      (uuid, conversation_id, role, content, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'source-message-id',
    'chat-aurora',
    'user',
    'Keep this conversation.',
    JSON.stringify({ scope: 'project-aurora' }),
    '2026-07-20T12:01:00.000Z'
  )
}

afterEach(() => {
  while (databases.length) databases.pop()!.close()
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('desktop portable Backup & Restore', () => {
  it('exports and additively restores chats, projects, knowledge files and chunks', async () => {
    const sourceRoot = tempRoot('source')
    const targetRoot = tempRoot('target')
    const sourceDb = database(sourceRoot)
    const targetDb = database(targetRoot)
    seedSource(sourceDb, sourceRoot)

    const sink = new PathSink()
    const delivery = await engine(sourceDb, sourceRoot, sink).exportAll()
    expect(delivery?.path).toMatch(/offgrid-backup-2026-07-27T12-00-00-000Z\.zip$/)

    const first = await engine(targetDb, targetRoot, sink).import()
    expect(first).toEqual({
      projectsAdded: 1,
      conversationsAdded: 1,
      messagesAdded: 1,
      documentsAdded: 1
    })

    const restoredDocument = targetDb
      .prepare('SELECT path, enabled FROM rag_documents WHERE project_id = ?')
      .get('project-aurora') as { path: string; enabled: number }
    expect(restoredDocument.path).toContain(path.join('restored-backups', 'files', 'documents'))
    expect(fs.readFileSync(restoredDocument.path, 'utf8')).toBe('OFFGRID_BACKUP_FILE_EVIDENCE')
    expect(restoredDocument.enabled).toBe(1)
    // This asserted `embedding: null`, and so encoded the bug: retrieval requires a non-null embedding
    // ("WHERE d.enabled = 1 AND c.embedding IS NOT NULL") and nothing ever re-embedded a restored chunk - so the
    // document this same test asserts is ENABLED, two lines up, could never inform an answer.
    //
    // The embedder is injected (FIXED_EMBEDDING) rather than real, because with the real one this journey
    // described two different outcomes: null on a machine where MiniLM cannot load, and a 384-float vector in
    // CI where it can. What the journey is about is that the vector REACHES the row.
    expect(targetDb.prepare('SELECT content, embedding FROM rag_chunks').get()).toEqual({
      content: 'The launch stays local.',
      embedding: JSON.stringify(FIXED_EMBEDDING)
    })
    expect(targetDb.prepare('SELECT content, context FROM rag_messages').get()).toEqual({
      content: 'Keep this conversation.',
      context: JSON.stringify({ scope: 'project-aurora' })
    })

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
    const db = database(root)
    seedSource(db, root)
    const sink = new PathSink()
    const backup = engine(db, root, sink)
    const ipc = new BackupIpcHarness()
    registerDesktopBackupIPC(ipc, backup)

    const delivery = await ipc.invoke<DesktopBackupDelivery>(BACKUP_EXPORT_ALL_CHANNEL)
    expect(delivery.path).toMatch(/offgrid-backup-2026-07-27T12-00-00-000Z\.zip$/)

    db.exec(`
      DELETE FROM rag_chunks;
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
  })
})
