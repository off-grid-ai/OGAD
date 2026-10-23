// Universal search — the single front door over everything Off Grid AI has seen.
// Hybrid: FTS5 keyword (exact words you saw) + LanceDB semantic (NLP recall),
// fused with reciprocal-rank fusion. Plus a background backfill that embeds the
// observation/frame/transcript backlog (using the in-app MiniLM model) so the
// semantic half actually covers your captured life. All local, all offline.
import { getDB } from './database'
import { frameTextIndexBackfilling } from './frame-text-index'
import { isEmbeddingIndexRebuilding } from './embedding-rebuild-state'
import { embeddings } from './embeddings'
import { ensureRagStoreSchema } from './rag/store'
import { ftsQuery } from './documents/sqlite-store'
import { addChunks, searchVectors, vectorCount, type VecChunk } from './vectors'
import {
  applyBoosts,
  ftsExpr,
  fuseHits,
  queryTerms,
  rankResults,
  likeMatch,
  LIKE_COLUMNS,
  epochMsSql,
  type RawHit,
  type SearchKind,
  type SearchResult,
  type SearchSort
} from './search-ranking'
import {
  INDEXABLE_COUNT_SQL,
  PENDING_COUNT_SQL,
  PENDING_SOURCE_SQL
} from './search-backfill-queries'

export type { SearchResult, SearchSort } from './search-ranking'

// ---------------------------------------------------------------------------
// Backfill: embed the backlog into LanceDB (keys tracked in SQLite to skip work)
// ---------------------------------------------------------------------------

interface PendingRow {
  key: string
  kind: SearchKind
  refId: number
  text: string
  surface: string
  url: string
  ts: number
}

function ensureIndexTable(): void {
  getDB().exec('CREATE TABLE IF NOT EXISTS vec_indexed (key TEXT PRIMARY KEY)')
}

// The full seven-source count scans every capture table, so the backfill loop does not run it
// after every batch. It keeps an estimate that each batch decrements by the keys it newly
// marked, and replaces the estimate with an exact count when it reaches zero (to confirm the
// backlog is really empty) or when it is older than PENDING_RECOUNT_MS (to notice new items).
// An empty pending scan across all seven sources is an exact zero on its own.
const PENDING_RECOUNT_MS = 30_000
let pendingEstimate: { count: number; countedAt: number } | undefined

function pendingCount(): number {
  ensureIndexTable()
  const row = getDB().prepare(PENDING_COUNT_SQL).get() as { c: number }
  pendingEstimate = { count: row.c, countedAt: Date.now() }
  return row.c
}

function remainingAfterBatch(marked: number): number {
  if (!pendingEstimate) return pendingCount()
  const count = Math.max(0, pendingEstimate.count - marked)
  if (count === 0 || Date.now() - pendingEstimate.countedAt >= PENDING_RECOUNT_MS) {
    return pendingCount()
  }
  pendingEstimate = { count, countedAt: pendingEstimate.countedAt }
  return count
}

function pendingRows(limit: number): PendingRow[] {
  const db = getDB()
  for (const sql of PENDING_SOURCE_SQL) {
    const rows = db.prepare(sql).all(limit) as PendingRow[]
    if (rows.length) return rows
  }
  return []
}

/** Count the source rows that a new embedding model must re-index. */
export function searchIndexableCount(): number {
  const row = getDB().prepare(INDEXABLE_COUNT_SQL).get() as { c: number }
  return row.c
}

/** Embed one batch of un-indexed items into LanceDB. Returns progress. */
async function indexBatch(limit = 48): Promise<{ indexed: number; remaining: number }> {
  ensureIndexTable()
  const db = getDB()
  const rows = pendingRows(limit)
  if (!rows.length) {
    pendingEstimate = { count: 0, countedAt: Date.now() }
    return { indexed: 0, remaining: 0 }
  }

  const chunks: VecChunk[] = []
  for (const r of rows) {
    const text = (r.text || '').trim().slice(0, 1000)
    // Keep the frame noise threshold without asking SQLite to read every large OCR value just to
    // calculate length(text). On a multi-gigabyte capture database that synchronous scan blocked
    // Electron's main thread for seconds. Rows skipped here are still marked below, once only.
    if (!text || (r.key.startsWith('frame:') && text.length <= 20)) continue
    const vector = await embeddings.generateEmbedding(text)
    chunks.push({
      key: r.key,
      kind: r.kind,
      refId: r.refId,
      vector,
      text: text.slice(0, 300),
      surface: r.surface,
      url: r.url,
      ts: r.ts || 0
    })
  }
  await addChunks(chunks)

  const mark = db.prepare('INSERT OR IGNORE INTO vec_indexed (key) VALUES (?)')
  // Only keys inserted here leave the backlog; a key another writer marked meanwhile is ignored.
  const marked = db.transaction(() => rows.reduce((sum, r) => sum + mark.run(r.key).changes, 0))()
  return { indexed: chunks.length, remaining: remainingAfterBatch(marked) }
}

let backfilling = false
/** Wait for an in-flight search batch before replacing the embedding index. */
export async function waitForSearchBackfill(): Promise<void> {
  while (backfilling) await new Promise((resolve) => setTimeout(resolve, 50))
}

/** Drain the backlog in the background, one throttled batch at a time. */
export async function runBackfill(
  onProgress?: (p: { done: number; remaining: number }) => void,
  shouldStop?: () => boolean
): Promise<void> {
  if (backfilling) return
  backfilling = true
  // Each run starts from an exact count, so items added since the last run are included.
  pendingEstimate = undefined
  try {
    let done = 0
    for (;;) {
      if (shouldStop?.()) throw new Error('Embedding index rebuild canceled.')
      if (!shouldStop && isEmbeddingIndexRebuilding()) break
      const { indexed, remaining } = await indexBatch()
      done += indexed
      onProgress?.({ done, remaining })
      if (shouldStop?.()) throw new Error('Embedding index rebuild canceled.')
      if (remaining === 0) break
      await new Promise((r) => setTimeout(r, 50)) // breathe — don't starve the LLM/UI
    }
  } finally {
    backfilling = false
  }
}

export async function searchStatus(): Promise<{ vectors: number; pending: number }> {
  return { vectors: await vectorCount(), pending: pendingCount() }
}

/** Data sources available to filter by (surfaces seen, busiest first, + meetings). */
/** Bulk mail synced from a connected account (newsletters, promotions): searchable, but never counted
 *  or featured, as the ambient rules have it. Screens of videos or feeds you watched stay. */
const SYNCED_BULK_MAIL = `(COALESCE(o.category, '') = 'consumption' AND o.source_key IS NOT NULL)`

/** Distinct moments, as the result list shows them: one per app and summary, not one per capture. */
const DISTINCT_MOMENTS = 'COUNT(DISTINCT lower(trim(o.summary)))'

/** Totals are a full pass over every observation; the rail asks for them on every visit. */
const SOURCE_TOTALS_TTL_MS = 60_000
let sourceTotals: { at: number; rows: { source: string; count: number }[] } | null = null

export function searchSources(): { source: string; count: number }[] {
  const now = Date.now()
  if (sourceTotals && now - sourceTotals.at < SOURCE_TOTALS_TTL_MS) return sourceTotals.rows
  const rows = countSources()
  sourceTotals = { at: now, rows }
  return rows
}

function countSources(): { source: string; count: number }[] {
  ensureRagStoreSchema()
  const db = getDB()
  const rows = db
    .prepare(
      `SELECT o.surface AS source, ${DISTINCT_MOMENTS} AS count FROM observations o
        WHERE o.surface IS NOT NULL AND o.surface != '' AND NOT ${SYNCED_BULK_MAIL}
        GROUP BY o.surface ORDER BY count DESC LIMIT 20`
    )
    .all() as { source: string; count: number }[]
  const mtg = db.prepare('SELECT COUNT(*) AS c FROM meetings').get() as { c: number }
  if (mtg.c) rows.push({ source: 'Meeting', count: mtg.c })
  // Your own data, not just captured surfaces: chats and project knowledge bases.
  const chat = db.prepare('SELECT COUNT(*) AS c FROM rag_conversations').get() as { c: number }
  if (chat.c) rows.push({ source: 'Chat', count: chat.c })
  const kb = db.prepare('SELECT COUNT(*) AS c FROM rag_documents').get() as { c: number }
  if (kb.c) rows.push({ source: 'Knowledge base', count: kb.c })
  return rows
}

/** Per-source MATCH counts for a query — drives the Sources rail facet counts so
 *  the numbers reflect the current search (Chat: 1, Knowledge base: 0, …). Empty
 *  query → total counts (searchSources). Only sources with ≥1 match are returned. */
export function searchFacets(query: string): { source: string; count: number }[] {
  ensureRagStoreSchema()
  const q = query.trim()
  if (!q) return searchSources()
  const db = getDB()
  const out: { source: string; count: number }[] = []
  const m = ftsExpr(q)
  if (m) {
    out.push(
      ...(db
        .prepare(
          `SELECT COALESCE(o.surface,'') AS source, ${DISTINCT_MOMENTS} AS count
             FROM observation_fts f JOIN observations o ON o.id = f.rowid
            WHERE observation_fts MATCH ? AND o.surface IS NOT NULL AND o.surface != ''
              AND NOT ${SYNCED_BULK_MAIL}
            GROUP BY o.surface ORDER BY count DESC`
        )
        .all(m) as { source: string; count: number }[])
    )
  }
  const terms = queryTerms(q, 6)
  if (terms.length) {
    const chatM = likeMatch(LIKE_COLUMNS.chat, terms)
    const chat = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (SELECT rc.id FROM rag_messages rm JOIN rag_conversations rc ON rc.id=rm.conversation_id WHERE ${chatM.where} GROUP BY rc.id)`
      )
      .get(...chatM.args) as { c: number }
    if (chat.c) out.push({ source: 'Chat', count: chat.c })
    const kb = knowledgeBaseHits(q, 1000).length
    if (kb) out.push({ source: 'Knowledge base', count: kb })
    const mtgM = likeMatch(LIKE_COLUMNS.meeting, terms)
    const mtg = db
      .prepare(`SELECT COUNT(*) AS c FROM meetings WHERE ${mtgM.where}`)
      .get(...mtgM.args) as { c: number }
    if (mtg.c) out.push({ source: 'Meeting', count: mtg.c })
  }
  return out
}

// ---------------------------------------------------------------------------
// Query: keyword (FTS5) + semantic (LanceDB), fused with RRF
// ---------------------------------------------------------------------------

// One FTS source → ranked raw hits (best first). `sql` must SELECT the RawHit columns.
function ftsHits(sql: string, match: string, limit: number): RawHit[] {
  if (!match) return []
  return getDB().prepare(sql).all(match, limit) as RawHit[]
}

function keywordHits(query: string, perSource: number): RawHit[][] {
  const m = ftsExpr(query)
  const epochMs = epochMsSql('o.ts')
  return [
    // Screen captures (distilled observation summaries)
    ftsHits(
      `SELECT 'obs:'||o.id AS key, 'screen' AS kind, o.id AS refId, COALESCE(o.surface,'Screen') AS title,
              o.summary AS snippet, COALESCE(o.surface,'') AS surface, o.url AS url, ${epochMs} AS ts
         FROM observation_fts f JOIN observations o ON o.id = f.rowid
        WHERE observation_fts MATCH ? ORDER BY bm25(observation_fts) LIMIT ?`,
      m,
      perSource
    ),
    // Meeting / session transcripts
    ftsHits(
      `SELECT 'sum:'||o.rowid AS key, 'meeting' AS kind, o.rowid AS refId, 'Meeting' AS title,
              o.summary AS snippet, 'Meeting' AS surface, NULL AS url, 0 AS ts
         FROM summary_fts f JOIN chat_summaries o ON o.rowid = f.rowid
        WHERE summary_fts MATCH ? ORDER BY bm25(summary_fts) LIMIT ?`,
      m,
      perSource
    ),
    // Entities
    ftsHits(
      `SELECT 'ent:'||o.id AS key, 'entity' AS kind, o.id AS refId, o.name AS title,
              COALESCE(o.summary,o.type) AS snippet, 'Entity' AS surface, NULL AS url, 0 AS ts
         FROM entity_fts f JOIN entities o ON o.id = f.rowid
        WHERE entity_fts MATCH ? AND o.hidden = 0 ORDER BY bm25(entity_fts) LIMIT ?`,
      m,
      perSource
    ),
    // Entity facts
    ftsHits(
      `SELECT 'fact:'||o.id AS key, 'fact' AS kind, o.entity_id AS refId,
              e.name AS title,
              o.fact AS snippet, 'Fact' AS surface, NULL AS url, 0 AS ts
         FROM entity_fact_fts f JOIN entity_facts o ON o.id = f.rowid
         JOIN entities e ON e.id = o.entity_id
        WHERE entity_fact_fts MATCH ? AND e.hidden = 0
        ORDER BY bm25(entity_fact_fts) LIMIT ?`,
      m,
      perSource
    ),
    // Memories
    ftsHits(
      `SELECT 'mem:'||o.id AS key, 'memory' AS kind, o.id AS refId, 'Memory' AS title,
              o.content AS snippet, COALESCE(o.source_app,'') AS surface, NULL AS url, 0 AS ts
         FROM memory_fts f JOIN memories o ON o.id = f.rowid
        WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`,
      m,
      perSource
    ),
    // Recorded meeting transcripts (no FTS table) — LIKE over title/summary/transcript.
    likeMeetingHits(query, perSource),
    // Every word on screen, from the frame text index (raw OCR the summaries dropped).
    frameHits(query, perSource),
    // Your own chat conversations (title + message content), one hit per chat.
    likeChatHits(query, perSource),
    // Project knowledge-base documents, from the document index.
    knowledgeBaseHits(query, perSource)
  ]
}

// Chat conversations have no FTS index — LIKE over message content OR the chat
// title, one hit per conversation (newest first). The conversation id (TEXT) is
// carried in `url` so the renderer can open that exact chat.
function likeChatHits(query: string, limit: number): RawHit[] {
  const terms = queryTerms(query, 6)
  if (!terms.length) return []
  const { where, args } = likeMatch(LIKE_COLUMNS.chat, terms)
  return getDB()
    .prepare(
      `SELECT 'chat:'||rc.id AS key, 'chat' AS kind, 0 AS refId, COALESCE(rc.title,'Chat') AS title,
              substr(rm.content,1,300) AS snippet, 'Chat' AS surface, rc.id AS url,
              ${epochMsSql('rc.updated_at')} AS ts
         FROM rag_messages rm JOIN rag_conversations rc ON rc.id = rm.conversation_id
        WHERE ${where} GROUP BY rc.id ORDER BY rc.updated_at DESC LIMIT ?`
    )
    .all(...args, limit) as RawHit[]
}

// Knowledge-base documents (per project): the document index's keyword search (bm25), best
// passage per file. The owning project_id is carried in `url` so the renderer can open it.
function knowledgeBaseHits(query: string, limit: number): RawHit[] {
  const match = ftsQuery(query)
  if (!match) return []
  let rows: RawHit[]
  try {
    rows = getDB()
      .prepare(
        `SELECT 'doc:'||d.id AS key, 'doc' AS kind, d.id AS refId, d.name AS title,
                substr(c.text,1,300) AS snippet, 'Knowledge base' AS surface, d.project_id AS url,
                ${epochMsSql('d.created_at')} AS ts
           FROM (SELECT document_id, position, bm25(attached_document_fts) AS rank
                   FROM attached_document_fts WHERE attached_document_fts MATCH ?
                   ORDER BY rank LIMIT ?) f
           JOIN rag_documents d ON d.document_id = f.document_id
           JOIN attached_document_chunks c ON c.document_id = f.document_id AND c.position = f.position
          ORDER BY f.rank`
      )
      .all(match, limit * 20) as RawHit[]
  } catch {
    return []
  }
  const seen = new Set<string>()
  return rows.filter((row) => !seen.has(row.key) && !!seen.add(row.key)).slice(0, limit)
}

function likeMeetingHits(query: string, limit: number): RawHit[] {
  const terms = queryTerms(query, 6)
  if (!terms.length) return []
  const { where, args } = likeMatch(LIKE_COLUMNS.meeting, terms)
  return getDB()
    .prepare(
      `SELECT 'mtg:'||id AS key, 'meeting' AS kind, id AS refId, COALESCE(title,'Meeting') AS title,
              substr(COALESCE(summary, transcript),1,300) AS snippet, 'Meeting' AS surface, NULL AS url,
              COALESCE(started_at,0) AS ts
         FROM meetings WHERE ${where} ORDER BY started_at DESC LIMIT ?`
    )
    .all(...args, limit) as RawHit[]
}

/** One moment, once. Capture records the same screen again and again while it stays put, each
 *  with the same summary; a result list showed dozens of identical cards. Keeps the first (best
 *  ranked or newest) of each app and summary. */
function collapseRepeats(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>()
  return results.filter((result) => {
    if (result.kind !== 'screen') return true
    const identity = `${result.surface.toLowerCase()}\u0000${result.snippet.trim().toLowerCase()}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

/** Observations made from a connected account (synced mail and chat) are messages, not screens:
 *  they have no screenshot, and calling them SCREEN with an empty picture misled. */
function markSyncedMessages(results: SearchResult[]): void {
  const ids = results.filter((r) => r.key.startsWith('obs:')).map((r) => r.refId)
  if (!ids.length) return
  const synced = new Set(
    (
      getDB()
        .prepare(
          `SELECT DISTINCT of.observation_id AS id FROM observation_frames of
             JOIN frames f ON f.id = of.frame_id
            WHERE f.source = 'connector' AND of.observation_id IN (${ids.map(() => '?').join(',')})`
        )
        .all(...ids) as { id: number }[]
    ).map((row) => row.id)
  )
  for (const result of results) {
    if (result.key.startsWith('obs:') && synced.has(result.refId)) {
      result.kind = 'message'
      result.imagePath = null
    }
  }
}

/** The newest things in the index, for an empty query: captured moments, recorded meetings and
 *  your chats, newest first, within the chosen sources. Search opens on this feed. */
function recentHits(limit: number, sources?: string[]): RawHit[] {
  const db = getDB()
  const wanted = sources?.length ? sources.map((source) => source.toLowerCase()) : null
  const want = (source: string): boolean => !wanted || wanted.includes(source.toLowerCase())
  const observations = db
    .prepare(
      `SELECT 'obs:'||o.id AS key, 'screen' AS kind, o.id AS refId, COALESCE(o.surface,'Screen') AS title,
              o.summary AS snippet, COALESCE(o.surface,'') AS surface, o.url AS url, ${epochMsSql('o.ts')} AS ts
         FROM observations o
        WHERE o.summary IS NOT NULL AND o.summary != ''
          AND NOT ${SYNCED_BULK_MAIL}
          ${wanted ? `AND lower(o.surface) IN (${wanted.map(() => '?').join(',')})` : ''}
        ORDER BY o.ts DESC LIMIT ?`
    )
    .all(...(wanted ?? []), limit) as RawHit[]
  const meetings = want('Meeting')
    ? (db
        .prepare(
          `SELECT 'mtg:'||id AS key, 'meeting' AS kind, id AS refId, COALESCE(title,'Meeting') AS title,
                  substr(COALESCE(summary, transcript, ''),1,300) AS snippet, 'Meeting' AS surface,
                  NULL AS url, COALESCE(started_at,0) AS ts
             FROM meetings ORDER BY started_at DESC LIMIT ?`
        )
        .all(limit) as RawHit[])
    : []
  const chats = want('Chat')
    ? (db
        .prepare(
          `SELECT 'chat:'||rc.id AS key, 'chat' AS kind, 0 AS refId, COALESCE(rc.title,'Chat') AS title,
                  COALESCE((SELECT substr(rm.content,1,300) FROM rag_messages rm
                             WHERE rm.conversation_id = rc.id ORDER BY rm.rowid DESC LIMIT 1),'') AS snippet,
                  'Chat' AS surface, rc.id AS url, ${epochMsSql('rc.updated_at')} AS ts
             FROM rag_conversations rc ORDER BY rc.updated_at DESC LIMIT ?`
        )
        .all(limit) as RawHit[])
    : []
  return [...observations, ...meetings, ...chats]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
}

/** Frames whose on-screen text matches, from the frame text index. While older frames are still
 *  being indexed (or before the index exists), recent frames are also matched word for word. */
function frameHits(query: string, limit: number): RawHit[] {
  const db = getDB()
  const indexed = !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'frame_fts'")
    .get()
  const match = ftsExpr(query)
  const hits: RawHit[] =
    indexed && match
      ? (db
          .prepare(
            `SELECT 'frame:'||f.id AS key, 'screen' AS kind, f.id AS refId, COALESCE(f.surface,'Screen') AS title,
                    substr(f.text,1,300) AS snippet, COALESCE(f.surface,'') AS surface, f.url AS url,
                    ${epochMsSql('f.ts')} AS ts
               FROM frame_fts x JOIN frames f ON f.id = x.rowid
              WHERE frame_fts MATCH ? ORDER BY bm25(frame_fts) LIMIT ?`
          )
          .all(match, limit) as RawHit[])
      : []
  if (indexed && !frameTextIndexBackfilling()) return hits
  const seen = new Set(hits.map((hit) => hit.key))
  return [...hits, ...likeFrameHits(query, limit).filter((hit) => !seen.has(hit.key))]
}

// Raw OCR text on all tokens (AND), newest first.
function likeFrameHits(query: string, limit: number): RawHit[] {
  const terms = queryTerms(query, 6)
  if (!terms.length) return []
  const { where, args } = likeMatch(LIKE_COLUMNS.frame, terms)
  // Only while the frame text index is incomplete. Scanning all raw OCR (hundreds of MB) took
  // seconds on the main thread, so this reads recent frames only, through the ts index.
  const since = new Date(Date.now() - RAW_FRAME_TEXT_DAYS * 86_400_000).toISOString().slice(0, 10)
  return getDB()
    .prepare(
      `SELECT 'frame:'||id AS key, 'screen' AS kind, id AS refId, COALESCE(surface,'Screen') AS title,
              substr(text,1,300) AS snippet, COALESCE(surface,'') AS surface, url AS url,
              ${epochMsSql('ts')} AS ts
         FROM frames
        WHERE ts >= ? AND text IS NOT NULL AND COALESCE(source, '') != 'connector' AND ${where}
        ORDER BY ts DESC LIMIT ?`
    )
    .all(since, ...args, limit) as RawHit[]
}

/** How far back search reads raw on-screen text word for word. */
const RAW_FRAME_TEXT_DAYS = 30

/** Ranking penalty for bulk mail (newsletters, promos): still searchable, never on top of the
 *  user's real conversations just because it is recent. */
const BULK_MAIL_PENALTY = 0.02

/** Push bulk-mail observations down the ranking. Reads their category in one query. */
function demoteBulkMail(results: Iterable<SearchResult>): void {
  const byId = new Map<number, SearchResult>()
  for (const r of results) {
    if (r.key.startsWith('obs:')) byId.set(Number(r.key.slice(4)), r)
  }
  if (!byId.size) return
  try {
    const ids = JSON.stringify([...byId.keys()])
    const rows = getDB()
      .prepare(
        "SELECT id FROM observations WHERE id IN (SELECT value FROM json_each(?)) AND category = 'consumption'"
      )
      .all(ids) as { id: number }[]
    for (const { id } of rows) byId.get(id)!.score -= BULK_MAIL_PENALTY
  } catch {
    // Observations are a Pro table; without it there is nothing to demote.
  }
}

function sourceRowExists(sql: string, id: number): boolean {
  return getDB().prepare(sql).get(id) !== undefined
}

/** Confirm a cached semantic row still has a visible source-of-truth record. */
function semanticSourceExists(hit: VecChunk): boolean {
  const id = Number(hit.key.slice(hit.key.indexOf(':') + 1))
  if (!Number.isSafeInteger(id) || id <= 0) return false
  if (hit.key.startsWith('frame:')) {
    return sourceRowExists('SELECT 1 FROM frames WHERE id = ?', id)
  }
  if (hit.key.startsWith('obs:')) {
    return sourceRowExists('SELECT 1 FROM observations WHERE id = ?', id)
  }
  if (hit.key.startsWith('sum:')) {
    return sourceRowExists('SELECT 1 FROM chat_summaries WHERE rowid = ?', id)
  }
  if (hit.key.startsWith('mtg:')) {
    return sourceRowExists('SELECT 1 FROM meetings WHERE id = ?', id)
  }
  if (hit.key.startsWith('mem:')) {
    return sourceRowExists('SELECT 1 FROM memories WHERE id = ?', id)
  }
  if (hit.key.startsWith('ent:')) {
    return sourceRowExists('SELECT 1 FROM entities WHERE id = ? AND hidden = 0', id)
  }
  if (hit.key.startsWith('fact:')) {
    return sourceRowExists(
      `SELECT 1 FROM entity_facts f JOIN entities e ON e.id = f.entity_id
        WHERE f.id = ? AND e.hidden = 0`,
      id
    )
  }
  return false
}

/** Query the semantic index while treating SQLite as the source of truth.
 * Stale vectors are harmless cache entries and never become user-visible hits.
 */
export async function searchSemanticSources(vector: number[], limit: number): Promise<RawHit[]> {
  if (isEmbeddingIndexRebuilding()) return []
  const hits = await searchVectors(vector, limit)
  return hits.filter(semanticSourceExists).map((h) => ({
    key: h.key,
    kind: h.kind as SearchKind,
    refId: h.refId,
    title: h.surface || h.kind,
    snippet: h.text,
    surface: h.surface,
    url: h.url || null,
    ts: h.ts
  }))
}

async function semanticHits(query: string, limit: number): Promise<RawHit[]> {
  // Someone is waiting on this one: it goes ahead of queued background indexing.
  const vector = await embeddings.generateEmbedding(query, { interactive: true })
  return searchSemanticSources(vector, limit)
}

// Best thumbnail for a hit: a frame's own image, or an observation's linked frame.
function thumbFor(hit: RawHit): string | null {
  const db = getDB()
  if (hit.key.startsWith('frame:')) {
    const r = db.prepare('SELECT image_path FROM frames WHERE id = ?').get(hit.refId) as
      | { image_path?: string }
      | undefined
    return r?.image_path ?? null
  }
  if (hit.kind === 'screen') {
    const r = db
      .prepare(
        'SELECT f.image_path FROM observation_frames of JOIN frames f ON f.id = of.frame_id WHERE of.observation_id = ? LIMIT 1'
      )
      .get(hit.refId) as { image_path?: string } | undefined
    return r?.image_path ?? null
  }
  return null
}

/** Hybrid universal search. `semantic` adds the LanceDB pass (slower first call). */
// NOTE: artifacts are intentionally NOT in universal search yet — a hit can't be
// deep-linked (it carries no conversation context and there's no standalone
// artifact viewer), so clicking one used to jump to a meaningless Replay moment.
// Re-add an `artifactHits` source here once artifacts have an openable target.

export async function universalSearch(
  query: string,
  opts: {
    limit?: number
    semantic?: boolean
    sources?: string[]
    kinds?: SearchKind[]
    collapseScreenMoments?: boolean
    sort?: SearchSort
    excludeChatId?: string
    /** Aborted when a newer search supersedes this one; the remaining stages are skipped. */
    signal?: AbortSignal
  } = {}
): Promise<SearchResult[]> {
  ensureRagStoreSchema()
  const q = query.trim()
  const limit = opts.limit ?? 30
  if (!q) {
    // No words yet: the newest of everything, so Search never opens on an empty page.
    const recent = rankResults(Array.from(fuseHits([recentHits(limit * 4, opts.sources)]).values()), {
      query: '',
      sources: opts.sources,
      kinds: opts.kinds,
      excludeChatId: opts.excludeChatId,
      sort: 'recency'
    })
    const page = collapseRepeats(recent).slice(0, limit)
    markSyncedMessages(page)
    for (const r of page)
      if (r.kind !== 'message')
        r.imagePath = thumbFor({ key: r.key, kind: r.kind, refId: r.refId } as RawHit)
    return page
  }
  // When filtering by source, cast a wider net per source so enough survive the filter.
  const perSource = opts.sources?.length ? 80 : Math.min(40, limit + 10)

  const lists = keywordHits(q, perSource)
  opts.signal?.throwIfAborted()
  if (opts.semantic !== false && !isEmbeddingIndexRebuilding()) {
    try {
      lists.push(await semanticHits(q, perSource))
    } catch {
      /* embedding model not ready — keyword results still fine */
    }
    opts.signal?.throwIfAborted()
  }

  // Reciprocal-rank fusion across all lists, keyed by the unique chunk key.
  const fused = fuseHits(lists)

  // Add a recency bias so recent hits float up (this week first, then progressively
  // older), plus a small nudge for your own deliberate content (chats / KB docs) so
  // it isn't buried under thousands of ambient screen captures.
  applyBoosts(fused.values(), Date.now())
  demoteBulkMail(fused.values())

  // Filter (source / current chat) then sort (relevance / recency / match).
  const ordered = rankResults(Array.from(fused.values()), {
    query: q,
    sources: opts.sources,
    kinds: opts.kinds,
    excludeChatId: opts.excludeChatId,
    sort: opts.sort
  })
  opts.signal?.throwIfAborted()
  const distinct = collapseRepeats(ordered)
  markSyncedMessages(distinct.slice(0, limit * 2))
  for (const r of distinct)
    if (r.kind !== 'message')
      r.imagePath = thumbFor({ key: r.key, kind: r.kind, refId: r.refId } as RawHit)

  if (!opts.collapseScreenMoments) return distinct.slice(0, limit)

  // One captured moment is indexed twice: its raw OCR frame and its distilled
  // observation. Replay shows moments, not index records, so collapse both forms
  // after ranking and thumbnail resolution. General search keeps both records.
  const seenMoments = new Set<string>()
  const moments: SearchResult[] = []
  for (const result of distinct) {
    const identity =
      result.kind === 'screen'
        ? result.imagePath || `${String(result.ts)}:${result.surface}`
        : result.key
    if (seenMoments.has(identity)) continue
    seenMoments.add(identity)
    moments.push(result)
    if (moments.length === limit) break
  }
  return moments
}
