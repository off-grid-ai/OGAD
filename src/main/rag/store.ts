// Desktop VectorStore for @offgrid/rag, backed by the existing better-sqlite3
// `memories.db`. Adds project/document/chunk/embedding/thread tables and a
// getChunkCandidates that UNIONS a project's uploaded-document chunks with the
// app's captured memories — so a project's knowledge base spans both uploaded
// files and what Off Grid AI has seen (the KB-sources decision).

import { getDB } from '../database'
import { randomUUID } from 'crypto'
import {
  MEMORY_CANDIDATE_LIMIT,
  memoryChunkCandidate,
  parseStoredEmbedding,
  projectIncludesMemory as projectIncludesMemoryRule,
  type ChunkCandidate,
  type MediaKind,
  type RagDocument,
  type VectorStore
} from '@offgrid/rag'

let migrated = false

/** Ensure the core-owned RAG tables exist before any owner reads or materializes them. */
export function ensureRagStoreSchema(): void {
  if (migrated) return
  const db = getDB()
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      position INTEGER NOT NULL,
      embedding TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_rag_documents_project ON rag_documents(project_id);
  `)
  const columns = getDB().prepare("SELECT name FROM pragma_table_info('rag_documents')").all() as {
    name: string
  }[]
  if (!columns.some(({ name }) => name === 'sync_id')) {
    getDB().exec('ALTER TABLE rag_documents ADD COLUMN sync_id TEXT')
  }
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
  migrated = true
}

/** Whether a project folds captured memories into its KB: its stored flag, else the shared default. */
export function projectIncludesMemory(projectId: string): boolean {
  ensureRagStoreSchema()
  const row = getDB()
    .prepare('SELECT include_memory FROM workspace_content_projects WHERE id = ?')
    .get(projectId) as { include_memory: number } | undefined
  return projectIncludesMemoryRule(row ? row.include_memory === 1 : undefined)
}

export const desktopVectorStore: VectorStore = {
  async ensureReady() {
    ensureRagStoreSchema()
  },

  async addDocument(doc) {
    ensureRagStoreSchema()
    const info = getDB()
      .prepare(
        `INSERT INTO rag_documents
           (sync_id, project_id, name, path, size, kind, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
      )
      .run(
        doc.syncId ?? randomUUID(),
        doc.projectId,
        doc.name,
        doc.path,
        doc.size,
        doc.kind,
        doc.enabled === false ? 0 : 1,
        doc.createdAt ?? null
      )
    return Number(info.lastInsertRowid)
  },

  async addChunks(docId, chunks, embeddings) {
    ensureRagStoreSchema()
    const db = getDB()
    const insert = db.prepare(
      'INSERT INTO rag_chunks (doc_id, content, position, embedding) VALUES (?, ?, ?, ?)'
    )
    const tx = db.transaction(() => {
      chunks.forEach((c, i) => {
        const emb = embeddings[i] ? JSON.stringify(embeddings[i]) : null
        insert.run(docId, c.content, c.position, emb)
      })
    })
    tx()
  },

  async getChunkCandidates(projectId) {
    ensureRagStoreSchema()
    const db = getDB()
    const out: ChunkCandidate[] = []

    // 1) Uploaded-document chunks for enabled docs in this project.
    const rows = db
      .prepare(
        `SELECT c.doc_id AS docId, d.name AS name, c.content AS content, c.position AS position, c.embedding AS embedding
         FROM rag_chunks c
         JOIN rag_documents d ON d.id = c.doc_id
         WHERE d.project_id = ? AND d.enabled = 1 AND c.embedding IS NOT NULL`
      )
      .all(projectId) as {
      docId: number
      name: string
      content: string
      position: number
      embedding: string
    }[]
    for (const r of rows) {
      const embedding = parseStoredEmbedding(r.embedding)
      if (embedding.length)
        out.push({
          docId: r.docId,
          name: r.name,
          content: r.content,
          position: r.position,
          embedding
        })
    }

    // 2) Captured memories as an additional KB source (opt-out per project).
    if (projectIncludesMemory(projectId)) {
      const mems = db
        .prepare(
          `SELECT id, content, embedding FROM memories
           WHERE embedding IS NOT NULL AND embedding != '[]' LIMIT ?`
        )
        .all(MEMORY_CANDIDATE_LIMIT) as { id: number; content: string; embedding: string }[]
      for (const m of mems) {
        const embedding = parseStoredEmbedding(m.embedding)
        if (embedding.length)
          out.push(memoryChunkCandidate({ id: m.id, content: m.content, embedding }))
      }
    }

    return out
  },

  async listDocuments(projectId) {
    ensureRagStoreSchema()
    const rows = getDB()
      .prepare(
        `SELECT id, sync_id, project_id, name, path, size, kind, enabled, created_at
         FROM rag_documents WHERE project_id = ? ORDER BY created_at DESC`
      )
      .all(projectId) as {
      id: number
      sync_id: string
      project_id: string
      name: string
      path: string
      size: number
      kind: string
      enabled: number
      created_at: string
    }[]
    return rows.map((r): RagDocument => ({
      id: r.id,
      syncId: r.sync_id,
      projectId: r.project_id,
      name: r.name,
      path: r.path,
      size: r.size,
      kind: r.kind as MediaKind,
      enabled: r.enabled === 1,
      createdAt: r.created_at
    }))
  },

  async listDocumentPage(afterId, limit) {
    ensureRagStoreSchema()
    const rows = getDB()
      .prepare(`${DOCUMENT_SELECT} WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId ?? 0, limit + 1) as RagDocumentRow[]
    const page = rows.slice(0, limit)
    return {
      documents: page.map(mapDocument),
      nextAfterId: rows.length > limit ? (page.at(-1)?.id ?? null) : null
    }
  },

  async getDocument(docId) {
    return getRagDocument(docId)
  },

  async getDocumentBySyncId(syncId) {
    return getRagDocumentBySyncId(syncId)
  },

  async setDocumentEnabled(docId, enabled) {
    ensureRagStoreSchema()
    getDB()
      .prepare('UPDATE rag_documents SET enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, docId)
  },

  async deleteDocument(docId) {
    ensureRagStoreSchema()
    const db = getDB()
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM rag_chunks WHERE doc_id = ?').run(docId)
      db.prepare('DELETE FROM rag_documents WHERE id = ?').run(docId)
    })
    tx()
  },

  async deleteDocumentsByProject(projectId, commitFence) {
    ensureRagStoreSchema()
    const db = getDB()
    const committed = db.transaction(() => {
      if (commitFence && !commitFence()) {
        return false
      }
      deleteRagDocumentRowsByProject(db, projectId)
      return true
    })()
    return committed ? undefined : 'fenced'
  }
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
    createdAt: row.created_at
  }
}

const DOCUMENT_SELECT =
  'SELECT id, sync_id, project_id, name, path, size, kind, enabled, created_at FROM rag_documents'

function deleteRagDocumentRowsByProject(db: ReturnType<typeof getDB>, projectId: string): void {
  db.prepare(
    `DELETE FROM rag_chunks
     WHERE doc_id IN (SELECT id FROM rag_documents WHERE project_id = ?)`
  ).run(projectId)
  db.prepare('DELETE FROM rag_documents WHERE project_id = ?').run(projectId)
}

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

export function projectExists(projectId: string): boolean {
  ensureRagStoreSchema()
  return (
    getDB().prepare('SELECT 1 FROM workspace_content_projects WHERE id = ?').get(projectId) !==
    undefined
  )
}
