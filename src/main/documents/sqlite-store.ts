// DocumentIndexStore and KeywordSearchPort over the app's encrypted SQLite database (memories.db,
// SQLCipher). Documents attached to chat live here, never as plain files, so their text is
// protected like the rest of the user's data. Keyword search is SQLite FTS5 (GPT4All LocalDocs'
// approach); vectors are Float32 BLOBs beside each passage. Passages in scripts written without
// spaces (Chinese, Japanese, Thai…) are also kept in a trigram index, attached_document_fts_tri.

import {
  clearRebuildCursor,
  enableFtsSecureDelete,
  ftsIndexIsCurrent,
  getDB,
  markFtsIndexCurrent,
  queueIndexRebuild,
  rebuildCursor,
  setRebuildCursor,
  tableExists
} from '../database'
import {
  FTS_TOKENIZE,
  FTS_TRIGRAM_TOKENIZE,
  ftsQuery,
  ftsTrigramQuery,
  fuseLists,
  needsTrigram,
  normaliseForIndex
} from '@offgrid/rag/records'
import {
  indexedText,
  type DocumentChunk,
  type DocumentIndexStore,
  type DocumentPage,
  type KeywordHit,
  type KeywordSearchPort,
  type StoredDocument
} from '@offgrid/rag/documents'

let schemaFor: object | undefined

function db(): ReturnType<typeof getDB> {
  const database = getDB()
  if (schemaFor === database) return database
  ensureAttachedDocumentSchema(database)
  schemaFor = database
  return database
}

/** Create the attached-document tables on a connection (restore uses its own handle). */
export function ensureAttachedDocumentSchema(database: ReturnType<typeof getDB>): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS attached_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedded_count INTEGER NOT NULL DEFAULT 0,
      unreadable_pages INTEGER NOT NULL DEFAULT 0,
      embedder TEXT NOT NULL DEFAULT 'none',
      schema_version INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      map TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attached_document_pages (
      document_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      label TEXT,
      text TEXT NOT NULL,
      needs_ocr INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (document_id, page)
    );
    CREATE TABLE IF NOT EXISTS attached_document_chunks (
      document_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      page INTEGER NOT NULL,
      label TEXT,
      heading TEXT,
      text TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      vector BLOB,
      PRIMARY KEY (document_id, position)
    );
    CREATE TABLE IF NOT EXISTS conversation_document_exclusions (
      conversation_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, document_id)
    );
  `)
  prepareDocumentIndex(database)
  prepareDocumentTrigramIndex(database)
}

const INDEX = 'attached_document_fts'
const NEXT = 'attached_document_fts_next'
/** The trigram twin: only passages whose text has a script written without spaces. */
const TRIGRAM = 'attached_document_fts_tri'

function createDocumentIndex(database: ReturnType<typeof getDB>, name: string): void {
  database.exec(`
    CREATE VIRTUAL TABLE ${name} USING fts5(
      body, document_id UNINDEXED, position UNINDEXED,
      tokenize = "${FTS_TOKENIZE}"
    );
  `)
  enableFtsSecureDelete(database, name)
}

/**
 * The passage index on the shared tokenizer (it keeps Hindi vowel signs inside words), without
 * reading any passage here: a missing index is created (current when there are no passages yet);
 * one built by an older schema keeps answering while it is rebuilt in the background after
 * start-up (rebuildDocumentIndexSlice), so documents attached before a tokenizer change still match.
 */
function prepareDocumentIndex(database: ReturnType<typeof getDB>): void {
  if (ftsIndexIsCurrent(database, INDEX)) return
  if (!tableExists(database, INDEX)) {
    createDocumentIndex(database, INDEX)
    if (!database.prepare('SELECT 1 FROM attached_document_chunks LIMIT 1').get()) {
      markFtsIndexCurrent(database, INDEX)
      return
    }
  }
  queueIndexRebuild(INDEX, rebuildDocumentIndexSlice())
}

type ChunkRow = {
  rowid: number
  document_id: string
  position: number
  page: number
  label: string | null
  heading: string | null
  text: string
  tokens: number
  name: string
}

/** Passages after `cursor` in rowid order, with their document's name (`limit` -1: all). */
function readChunkRows(
  database: ReturnType<typeof getDB>,
  cursor: number,
  limit: number
): ChunkRow[] {
  return database
    .prepare(
      `SELECT c.rowid, c.document_id, c.position, c.page, c.label, c.heading, c.text, c.tokens,
              COALESCE(d.name, '') AS name
         FROM attached_document_chunks c
         LEFT JOIN attached_documents d ON d.id = c.document_id
        WHERE c.rowid > ? ORDER BY c.rowid LIMIT ?`
    )
    .all(cursor, limit) as ChunkRow[]
}

/** A passage's text exactly as both indexes hold it. */
function chunkBody(row: ChunkRow): string {
  const chunk: DocumentChunk = {
    documentId: row.document_id,
    position: row.position,
    page: row.page,
    ...(row.label ? { label: row.label } : {}),
    ...(row.heading ? { heading: row.heading } : {}),
    text: row.text,
    tokens: row.tokens
  }
  return normaliseForIndex(indexedText(row.name, chunk))
}

/**
 * One slice of the background rebuild: passages are copied into attached_document_fts_next in
 * rowid order (fts_rebuild holds how far). Passages written later have higher rowids and are
 * copied by a later slice; deletes reach both indexes (clearChunks, deleteDocument). The last
 * slice replaces the old index in one transaction. Returns whether more remain.
 */
function rebuildDocumentIndexSlice(): () => boolean {
  let batch = 200
  return () => {
    const database = db()
    if (ftsIndexIsCurrent(database, INDEX)) return false
    let cursor = rebuildCursor(database, INDEX)
    if (cursor === null || !tableExists(database, NEXT)) {
      database.transaction(() => {
        database.exec(`DROP TABLE IF EXISTS ${NEXT}`)
        createDocumentIndex(database, NEXT)
        setRebuildCursor(database, INDEX, 0)
      })()
      cursor = 0
    }
    const started = Date.now()
    const insert = database.prepare(
      `INSERT INTO ${NEXT} (body, document_id, position) VALUES (?, ?, ?)`
    )
    const copy = (rows: ChunkRow[]): void => {
      for (const row of rows) insert.run(chunkBody(row), row.document_id, row.position)
    }
    const rows = readChunkRows(database, cursor, batch)
    if (!rows.length) {
      database.transaction(() => {
        copy(readChunkRows(database, cursor, -1))
        database.exec(`DROP TABLE IF EXISTS ${INDEX}; ALTER TABLE ${NEXT} RENAME TO ${INDEX};`)
        markFtsIndexCurrent(database, INDEX)
        clearRebuildCursor(database, INDEX)
      })()
      return false
    }
    database.transaction(() => {
      copy(rows)
      setRebuildCursor(database, INDEX, rows[rows.length - 1]!.rowid)
    })()
    const elapsed = Date.now() - started
    if (elapsed > 20) batch = Math.max(10, Math.floor(batch / 2))
    else if (elapsed < 10) batch = Math.min(2_000, batch * 2)
    return true
  }
}

function createTrigramIndex(database: ReturnType<typeof getDB>): void {
  database.exec(`
    CREATE VIRTUAL TABLE ${TRIGRAM} USING fts5(
      body, document_id UNINDEXED, position UNINDEXED,
      tokenize = "${FTS_TRIGRAM_TOKENIZE}"
    );
  `)
  enableFtsSecureDelete(database, TRIGRAM)
}

/**
 * The trigram twin, without reading any passage here: a missing or outdated one is created empty
 * (current when there are no passages) and filled in the background after start-up
 * (fillTrigramIndexSlice); a fill under way resumes.
 */
function prepareDocumentTrigramIndex(database: ReturnType<typeof getDB>): void {
  if (ftsIndexIsCurrent(database, TRIGRAM)) return
  if (rebuildCursor(database, TRIGRAM) === null || !tableExists(database, TRIGRAM)) {
    database.transaction(() => {
      database.exec(`DROP TABLE IF EXISTS ${TRIGRAM}`)
      createTrigramIndex(database)
      if (database.prepare('SELECT 1 FROM attached_document_chunks LIMIT 1').get()) {
        setRebuildCursor(database, TRIGRAM, 0)
      } else {
        clearRebuildCursor(database, TRIGRAM)
        markFtsIndexCurrent(database, TRIGRAM)
      }
    })()
    if (ftsIndexIsCurrent(database, TRIGRAM)) return
  }
  queueIndexRebuild(TRIGRAM, fillTrigramIndexSlice())
}

/** Whether new passages go straight into the trigram twin. While it is being filled they are left
 *  to the fill: they have higher rowids than any passage it has read. */
function trigramIndexIsLive(database: ReturnType<typeof getDB>): boolean {
  return tableExists(database, TRIGRAM) && rebuildCursor(database, TRIGRAM) === null
}

/** One slice of filling the trigram twin with the passages that need it, in rowid order. The last
 *  slice ends the fill in the same transaction. Returns whether more remain. */
function fillTrigramIndexSlice(): () => boolean {
  let batch = 200
  return () => {
    const database = db()
    if (!tableExists(database, TRIGRAM)) return false
    const cursor = rebuildCursor(database, TRIGRAM)
    if (cursor === null) return false
    const started = Date.now()
    const rows = readChunkRows(database, cursor, batch)
    if (!rows.length) {
      database.transaction(() => {
        clearRebuildCursor(database, TRIGRAM)
        markFtsIndexCurrent(database, TRIGRAM)
      })()
      return false
    }
    const insert = database.prepare(
      `INSERT INTO ${TRIGRAM} (body, document_id, position) VALUES (?, ?, ?)`
    )
    database.transaction(() => {
      for (const row of rows) {
        const body = chunkBody(row)
        if (needsTrigram(body)) insert.run(body, row.document_id, row.position)
      }
      setRebuildCursor(database, TRIGRAM, rows[rows.length - 1]!.rowid)
    })()
    const elapsed = Date.now() - started
    if (elapsed > 20) batch = Math.max(10, Math.floor(batch / 2))
    else if (elapsed < 10) batch = Math.min(2_000, batch * 2)
    return true
  }
}

/** Delete passages from the index, from its rebuild while one is under way, and from the trigram
 *  twin. */
function unindexDocument(database: ReturnType<typeof getDB>, id: string): void {
  database.prepare(`DELETE FROM ${INDEX} WHERE document_id = ?`).run(id)
  if (tableExists(database, NEXT))
    database.prepare(`DELETE FROM ${NEXT} WHERE document_id = ?`).run(id)
  if (tableExists(database, TRIGRAM))
    database.prepare(`DELETE FROM ${TRIGRAM} WHERE document_id = ?`).run(id)
}

/** Every table that holds document data, and which owner keeps which document (for "Delete all
 *  my data"). */
export const ATTACHED_DOCUMENT_TABLES = [
  'kept_documents',
  'attached_document_fts',
  'attached_document_fts_next',
  'attached_document_fts_tri',
  'attached_document_chunks',
  'attached_document_pages',
  'conversation_document_exclusions',
  'attached_documents'
]

type DocumentRow = {
  id: string
  name: string
  kind: string
  state: StoredDocument['state']
  page_count: number
  chunk_count: number
  embedded_count: number
  unreadable_pages: number
  embedder: string
  schema_version: number
  error: string | null
  created_at: number
  last_used_at: number
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    state: row.state,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    embeddedCount: row.embedded_count,
    unreadablePages: row.unreadable_pages,
    embedder: row.embedder,
    schemaVersion: row.schema_version,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }
}

const COLUMNS: Record<keyof Omit<StoredDocument, 'id'>, string> = {
  name: 'name',
  kind: 'kind',
  state: 'state',
  pageCount: 'page_count',
  chunkCount: 'chunk_count',
  embeddedCount: 'embedded_count',
  unreadablePages: 'unreadable_pages',
  embedder: 'embedder',
  schemaVersion: 'schema_version',
  error: 'error',
  createdAt: 'created_at',
  lastUsedAt: 'last_used_at'
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

function fromBlob(blob: Buffer): Float32Array {
  // Copy: a Buffer may share a pooled ArrayBuffer at an offset that is not 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

export const documentStore: DocumentIndexStore = {
  async getDocument(id) {
    const row = db().prepare('SELECT * FROM attached_documents WHERE id = ?').get(id) as
      DocumentRow | undefined
    return row ? toDocument(row) : null
  },

  async putDocument(document) {
    db()
      .prepare(
        `INSERT INTO attached_documents (id, name, kind, state, page_count, chunk_count, embedded_count,
           unreadable_pages, embedder, schema_version, error, created_at, last_used_at)
         VALUES (@id, @name, @kind, @state, @pageCount, @chunkCount, @embeddedCount, @unreadablePages,
           @embedder, @schemaVersion, @error, @createdAt, @lastUsedAt)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, state = excluded.state,
           page_count = excluded.page_count, chunk_count = excluded.chunk_count,
           embedded_count = excluded.embedded_count, unreadable_pages = excluded.unreadable_pages,
           embedder = excluded.embedder, schema_version = excluded.schema_version, error = excluded.error,
           last_used_at = excluded.last_used_at`
      )
      .run({ ...document, error: document.error ?? null })
  },

  async updateDocument(id, patch) {
    // Only the fields the patch names are updated (strict optional types keep undefined out).
    const entries = Object.entries(patch).filter(([key]) => key !== 'id' && key in COLUMNS)
    if (!entries.length) return
    const sets = entries
      .map(([key]) => `${COLUMNS[key as keyof typeof COLUMNS]} = @${key}`)
      .join(', ')
    db()
      .prepare(`UPDATE attached_documents SET ${sets} WHERE id = @id`)
      .run({ ...Object.fromEntries(entries), id })
  },

  async putPages(id, pages) {
    const database = db()
    const insert = database.prepare(
      `INSERT INTO attached_document_pages (document_id, page, label, text, needs_ocr) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(document_id, page) DO UPDATE SET label = excluded.label, text = excluded.text,
         needs_ocr = excluded.needs_ocr`
    )
    database.transaction((rows: DocumentPage[]) => {
      for (const page of rows)
        insert.run(id, page.page, page.label ?? null, page.text, page.needsOcr ? 1 : 0)
    })(pages)
  },

  async readPages(id) {
    return (
      db()
        .prepare(
          'SELECT page, label, text, needs_ocr FROM attached_document_pages WHERE document_id = ? ORDER BY page'
        )
        .all(id) as { page: number; label: string | null; text: string; needs_ocr: number }[]
    ).map((row) => ({
      page: row.page,
      text: row.text,
      ...(row.label ? { label: row.label } : {}),
      ...(row.needs_ocr ? { needsOcr: true } : {})
    }))
  },

  async clearChunks(id) {
    const database = db()
    database.transaction(() => {
      database.prepare('DELETE FROM attached_document_chunks WHERE document_id = ?').run(id)
      unindexDocument(database, id)
      database.prepare('UPDATE attached_documents SET map = NULL WHERE id = ?').run(id)
    })()
  },

  async appendChunks(id, chunks) {
    const database = db()
    const name =
      (
        database.prepare('SELECT name FROM attached_documents WHERE id = ?').get(id) as
          { name: string } | undefined
      )?.name ?? ''
    const insert = database.prepare(
      `INSERT OR REPLACE INTO attached_document_chunks (document_id, position, page, label, heading, text, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const index = database.prepare(
      'INSERT INTO attached_document_fts (body, document_id, position) VALUES (?, ?, ?)'
    )
    const trigram = trigramIndexIsLive(database)
      ? database.prepare(`INSERT INTO ${TRIGRAM} (body, document_id, position) VALUES (?, ?, ?)`)
      : null
    database.transaction((rows: DocumentChunk[]) => {
      for (const chunk of rows) {
        insert.run(
          id,
          chunk.position,
          chunk.page,
          chunk.label ?? null,
          chunk.heading ?? null,
          chunk.text,
          chunk.tokens
        )
        const body = normaliseForIndex(indexedText(name, chunk))
        index.run(body, id, chunk.position)
        if (trigram && needsTrigram(body)) trigram.run(body, id, chunk.position)
      }
    })(chunks)
  },

  async readChunks(id) {
    return (
      db()
        .prepare(
          'SELECT position, page, label, heading, text, tokens FROM attached_document_chunks WHERE document_id = ? ORDER BY position'
        )
        .all(id) as {
        position: number
        page: number
        label: string | null
        heading: string | null
        text: string
        tokens: number
      }[]
    ).map((row) => ({
      documentId: id,
      position: row.position,
      page: row.page,
      ...(row.label ? { label: row.label } : {}),
      ...(row.heading ? { heading: row.heading } : {}),
      text: row.text,
      tokens: row.tokens
    }))
  },

  async putVectors(id, from, vectors) {
    const database = db()
    const update = database.prepare(
      'UPDATE attached_document_chunks SET vector = ? WHERE document_id = ? AND position = ?'
    )
    database.transaction(() => {
      vectors.forEach((vector, i) => update.run(toBlob(vector), id, from + i))
    })()
  },

  async readVectors(id) {
    const rows = db()
      .prepare(
        'SELECT position, vector FROM attached_document_chunks WHERE document_id = ? AND vector IS NOT NULL'
      )
      .all(id) as { position: number; vector: Buffer }[]
    return new Map(rows.map((row) => [row.position, fromBlob(row.vector)]))
  },

  async putMap(id, positions) {
    db()
      .prepare('UPDATE attached_documents SET map = ? WHERE id = ?')
      .run(JSON.stringify(positions), id)
  },

  async readMap(id) {
    const row = db().prepare('SELECT map FROM attached_documents WHERE id = ?').get(id) as
      { map: string | null } | undefined
    if (!row?.map) return null
    try {
      const positions = JSON.parse(row.map)
      return Array.isArray(positions)
        ? positions.filter((p): p is number => typeof p === 'number')
        : null
    } catch {
      return null
    }
  },

  async deleteDocument(id) {
    const database = db()
    database.transaction(() => {
      unindexDocument(database, id)
      database.prepare('DELETE FROM attached_document_chunks WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM attached_document_pages WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM conversation_document_exclusions WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM attached_documents WHERE id = ?').run(id)
    })()
  },

  async listDocuments() {
    return (
      db().prepare('SELECT id, last_used_at FROM attached_documents').all() as {
        id: string
        last_used_at: number
      }[]
    ).map((row) => ({ id: row.id, lastUsedAt: row.last_used_at }))
  }
}

type PassageRow = { documentId: string; position: number; rank: number }

const toKeywordHit = (row: PassageRow): KeywordHit => ({
  documentId: row.documentId,
  position: Number(row.position),
  score: -row.rank
})

/**
 * Keyword passages: bm25 over the passage index, and for a question in a script written without
 * spaces also the trigram twin (runs of three characters or more by MATCH, shorter ones by
 * substring among the twin's passages of these documents), fused by rank.
 */
export const documentKeywordSearch: KeywordSearchPort = {
  async search(documentIds, query, limit) {
    if (!documentIds.length) return []
    const database = db()
    const placeholders = documentIds.map(() => '?').join(', ')
    const lists: KeywordHit[][] = []
    const match = ftsQuery(query)
    if (match) {
      lists.push(
        (
          database
            .prepare(
              `SELECT document_id AS documentId, position, bm25(${INDEX}) AS rank
               FROM ${INDEX}
               WHERE ${INDEX} MATCH ? AND document_id IN (${placeholders})
               ORDER BY rank LIMIT ?`
            )
            .all(match, ...documentIds, limit) as PassageRow[]
        ).map(toKeywordHit)
      )
    }
    const trigram = needsTrigram(query) ? ftsTrigramQuery(query) : null
    if (trigram && tableExists(database, TRIGRAM)) {
      if (trigram.match)
        lists.push(
          (
            database
              .prepare(
                `SELECT document_id AS documentId, position, bm25(${TRIGRAM}) AS rank
                 FROM ${TRIGRAM}
                 WHERE ${TRIGRAM} MATCH ? AND document_id IN (${placeholders})
                 ORDER BY rank LIMIT ?`
              )
              .all(trigram.match, ...documentIds, limit) as PassageRow[]
          ).map(toKeywordHit)
        )
      if (trigram.short.length)
        lists.push(
          (
            database
              .prepare(
                `SELECT document_id AS documentId, position, 0 AS rank
                 FROM ${TRIGRAM}
                 WHERE document_id IN (${placeholders})
                   AND (${trigram.short.map(() => 'instr(body, ?) > 0').join(' OR ')})
                 LIMIT ?`
              )
              .all(...documentIds, ...trigram.short, limit) as PassageRow[]
          ).map(toKeywordHit)
        )
    }
    if (lists.length <= 1) return lists[0] ?? []
    return fuseLists(
      lists.map((items) => ({ items })),
      (hit) => `${hit.documentId}:${hit.position}`
    )
      .slice(0, limit)
      .map(({ item, score }) => ({ ...item, score }))
  }
}

export function excludedDocuments(conversationId: string): Set<string> {
  return new Set(
    (
      db()
        .prepare(
          'SELECT document_id FROM conversation_document_exclusions WHERE conversation_id = ?'
        )
        .all(conversationId) as { document_id: string }[]
    ).map((row) => row.document_id)
  )
}

export function setDocumentExcluded(
  conversationId: string,
  documentId: string,
  excluded: boolean
): void {
  if (excluded) {
    db()
      .prepare(
        'INSERT OR IGNORE INTO conversation_document_exclusions (conversation_id, document_id) VALUES (?, ?)'
      )
      .run(conversationId, documentId)
  } else {
    db()
      .prepare(
        'DELETE FROM conversation_document_exclusions WHERE conversation_id = ? AND document_id = ?'
      )
      .run(conversationId, documentId)
  }
}

export function forgetConversationExclusions(conversationId: string): void {
  db()
    .prepare('DELETE FROM conversation_document_exclusions WHERE conversation_id = ?')
    .run(conversationId)
}
