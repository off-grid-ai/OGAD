// Projects and their knowledge-base files in `memories.db`. A file row records which project holds
// it, whether it is used in answers and how it syncs; its text is read, indexed and searched by the
// document engine (documents/*) under `document_id`, the SHA-256 of its content.

import { getDB } from '../database'
import { deleteArtifactsForProject } from '../artifacts'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import { emitKnowledgeDocumentMutation } from '../sync-knowledge-document'
import { randomUUID } from 'crypto'
import type { MediaKind, Project, RagDocument } from '@offgrid/rag'

// The connection the tables were last ensured on. A reopened or switched profile is a new
// connection and gets its tables too (a process-wide flag skipped them there).
let migratedFor: object | undefined

/** Ensure the core-owned RAG tables exist before any owner reads or materializes them. */
export function ensureRagStoreSchema(): void {
  const db = getDB()
  if (migratedFor === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      icon TEXT,
      include_memory INTEGER NOT NULL DEFAULT 1,
      origin_device_id TEXT,
      origin_device_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rag_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id TEXT,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'text',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rag_documents_project ON rag_documents(project_id);
    -- Knowledge-base text now lives in the document index; the old chunk and vector table goes.
    DROP TABLE IF EXISTS rag_chunks;
  `)
  const projectColumns = db.prepare("SELECT name FROM pragma_table_info('projects')").all() as {
    name: string
  }[]
  for (const column of ['origin_device_id', 'origin_device_name']) {
    if (!projectColumns.some(({ name }) => name === column)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${column} TEXT`)
    }
  }
  const columns = getDB().prepare("SELECT name FROM pragma_table_info('rag_documents')").all() as {
    name: string
  }[]
  if (!columns.some(({ name }) => name === 'sync_id')) {
    getDB().exec('ALTER TABLE rag_documents ADD COLUMN sync_id TEXT')
  }
  if (!columns.some(({ name }) => name === 'document_id')) {
    getDB().exec('ALTER TABLE rag_documents ADD COLUMN document_id TEXT')
  }
  // Knowledge-base search joins the document index on this; cache cleanup lists it.
  getDB().exec(
    'CREATE INDEX IF NOT EXISTS idx_rag_documents_document ON rag_documents(document_id)'
  )
  const legacy = getDB()
    .prepare("SELECT id FROM rag_documents WHERE sync_id IS NULL OR sync_id = ''")
    .all() as Array<{ id: number }>
  const assignSyncId = getDB().prepare('UPDATE rag_documents SET sync_id = ? WHERE id = ?')
  getDB().transaction(() => {
    for (const { id } of legacy) assignSyncId.run(randomUUID(), id)
  })()
  getDB().exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_documents_sync_id ON rag_documents(sync_id)'
  )
  migratedFor = db
}

/** Whether a project folds captured memories into its KB (default on). */
export function projectIncludesMemory(projectId: string): boolean {
  ensureRagStoreSchema()
  const row = getDB().prepare('SELECT include_memory FROM projects WHERE id = ?').get(projectId) as
    { include_memory: number } | undefined
  return row ? row.include_memory === 1 : true
}

/** A new knowledge-base file row. Its text is indexed separately, by the document engine. */
export function insertRagDocument(doc: {
  projectId: string
  name: string
  path: string
  size: number
  kind: MediaKind
  documentId?: string
  syncId?: string
  createdAt?: string
  enabled?: boolean
}): number {
  ensureRagStoreSchema()
  const info = getDB()
    .prepare(
      `INSERT INTO rag_documents
         (sync_id, project_id, name, path, size, kind, enabled, document_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    )
    .run(
      doc.syncId ?? randomUUID(),
      doc.projectId,
      doc.name,
      doc.path,
      doc.size,
      doc.kind,
      doc.enabled === false ? 0 : 1,
      doc.documentId ?? null,
      doc.createdAt ?? null
    )
  return Number(info.lastInsertRowid)
}

/** A file's text is in the document index: record its id, what it turned out to be, and the kept copy. */
export function setRagDocumentIndexed(
  docId: number,
  indexed: { documentId: string; kind: MediaKind; path: string }
): void {
  ensureRagStoreSchema()
  getDB()
    .prepare('UPDATE rag_documents SET document_id = ?, kind = ?, path = ? WHERE id = ?')
    .run(indexed.documentId, indexed.kind, indexed.path, docId)
}

export function setRagDocumentEnabled(docId: number, enabled: boolean): void {
  ensureRagStoreSchema()
  getDB()
    .prepare('UPDATE rag_documents SET enabled = ? WHERE id = ?')
    .run(enabled ? 1 : 0, docId)
}

export function deleteRagDocument(docId: number): void {
  ensureRagStoreSchema()
  getDB().prepare('DELETE FROM rag_documents WHERE id = ?').run(docId)
}

export function listRagDocuments(projectId: string): RagDocument[] {
  ensureRagStoreSchema()
  return (
    getDB()
      .prepare(`${DOCUMENT_SELECT} WHERE project_id = ? ORDER BY created_at DESC`)
      .all(projectId) as RagDocumentRow[]
  ).map(mapDocument)
}

/** The project a conversation is filed in, if any. */
export function projectOfConversation(conversationId: string): string | null {
  ensureRagStoreSchema()
  const row = getDB()
    .prepare('SELECT project_id FROM rag_conversations WHERE id = ?')
    .get(conversationId) as { project_id: string | null } | undefined
  return row?.project_id ?? null
}

type RagDocumentRow = {
  id: number
  sync_id: string
  project_id: string
  name: string
  path: string
  size: number
  kind: string
  enabled: number
  created_at: string
  document_id: string | null
}

function mapDocument(row: RagDocumentRow): RagDocument {
  return {
    id: row.id,
    syncId: row.sync_id,
    projectId: row.project_id,
    name: row.name,
    path: row.path,
    size: row.size,
    kind: row.kind as MediaKind,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    ...(row.document_id ? { documentId: row.document_id } : {})
  }
}

const DOCUMENT_SELECT =
  'SELECT id, sync_id, project_id, name, path, size, kind, enabled, created_at, document_id FROM rag_documents'

export function getRagDocument(docId: number): RagDocument | undefined {
  ensureRagStoreSchema()
  const row = getDB().prepare(`${DOCUMENT_SELECT} WHERE id = ?`).get(docId) as
    RagDocumentRow | undefined
  return row ? mapDocument(row) : undefined
}

export function getRagDocumentBySyncId(syncId: string): RagDocument | undefined {
  ensureRagStoreSchema()
  const row = getDB().prepare(`${DOCUMENT_SELECT} WHERE sync_id = ?`).get(syncId) as
    RagDocumentRow | undefined
  return row ? mapDocument(row) : undefined
}

export function listAllRagDocuments(): RagDocument[] {
  ensureRagStoreSchema()
  return (
    getDB().prepare(`${DOCUMENT_SELECT} ORDER BY created_at ASC`).all() as RagDocumentRow[]
  ).map(mapDocument)
}

export function projectExists(projectId: string): boolean {
  ensureRagStoreSchema()
  return getDB().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) !== undefined
}

// --- Projects + threads CRUD (not part of the engine's VectorStore) ---------

export function listProjects(): (Project & { includeMemory: boolean })[] {
  ensureRagStoreSchema()
  const rows = getDB().prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as {
    id: string
    name: string
    description: string
    system_prompt: string
    icon: string | null
    include_memory: number
    created_at: string
    updated_at: string
  }[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    systemPrompt: r.system_prompt,
    icon: r.icon ?? undefined,
    includeMemory: r.include_memory === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export function createProject(p: {
  id: string
  name: string
  description?: string
  systemPrompt?: string
  icon?: string
}): void {
  ensureRagStoreSchema()
  getDB()
    .prepare(
      'INSERT INTO projects (id, name, description, system_prompt, icon) VALUES (?, ?, ?, ?, ?)'
    )
    .run(p.id, p.name, p.description ?? '', p.systemPrompt ?? '', p.icon ?? null)
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.project, entityId: p.id, kind: 'put' })
}

export function updateProject(
  id: string,
  patch: {
    name?: string
    description?: string
    systemPrompt?: string
    icon?: string
    includeMemory?: boolean
  }
): void {
  ensureRagStoreSchema()
  const db = getDB()
  const sets: string[] = []
  const args: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    args.push(patch.name)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    args.push(patch.description)
  }
  if (patch.systemPrompt !== undefined) {
    sets.push('system_prompt = ?')
    args.push(patch.systemPrompt)
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?')
    args.push(patch.icon)
  }
  if (patch.includeMemory !== undefined) {
    sets.push('include_memory = ?')
    args.push(patch.includeMemory ? 1 : 0)
  }
  if (!sets.length) return
  sets.push("updated_at = datetime('now')")
  args.push(id)
  const result = db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  if (result.changes === 1) {
    emitSyncMutation({ entity: CORE_SYNC_ENTITIES.project, entityId: id, kind: 'put' })
  }
}

export function deleteProject(id: string): void {
  ensureRagStoreSchema()
  const db = getDB()
  const projectExists =
    db.prepare('SELECT 1 AS present FROM projects WHERE id = ?').get(id) !== undefined
  const conversations = db
    .prepare('SELECT id FROM rag_conversations WHERE project_id = ?')
    .all(id) as Array<{ id: string }>
  const documents = db
    .prepare('SELECT sync_id FROM rag_documents WHERE project_id = ?')
    .all(id) as Array<{ sync_id: string }>
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM rag_documents WHERE project_id = ?').run(id)
    // A project is a folder and knowledge scope, not the owner of chat history. Removing it moves
    // its conversations back to unfiled Chat while preserving every message.
    db.prepare(
      `UPDATE rag_conversations
       SET project_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = ?`
    ).run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })
  tx()
  // Artifacts (generated images/docs) are files, not DB rows — clean them outside
  // the transaction so a deleted project's artifacts don't linger in the library.
  deleteArtifactsForProject(id)
  if (!projectExists) return
  for (const conversation of conversations) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.conversation,
      entityId: conversation.id,
      kind: 'put'
    })
  }
  for (const document of documents) {
    emitKnowledgeDocumentMutation({ kind: 'deleted', syncId: document.sync_id })
  }
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.project, entityId: id, kind: 'delete' })
}
