// Universal search — the single front door over everything Off Grid AI has seen.
// Hybrid: FTS5 keyword (exact words you saw) + LanceDB semantic (NLP recall),
// fused with reciprocal-rank fusion. Plus a background backfill that embeds the
// observation/frame/transcript backlog (using the in-app MiniLM model) so the
// semantic half actually covers your captured life. All local, all offline.
import { reportDesktopApplicationDegraded } from './composition/application-access'
import { getDB } from './database'
import { writeDiagnosticLog } from './diagnostics-log'
import { embeddings } from './embeddings'
import { ensureRagStoreSchema } from './rag/store'
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

export type { SearchResult, SearchSort } from './search-ranking'

// ---------------------------------------------------------------------------
// Backfill: embed the backlog into LanceDB (keys tracked in SQLite to skip work)
// ---------------------------------------------------------------------------

// One row per indexable item across all surfaces. frames.text is the raw OCR
// (richest for "find what I saw"); observations.summary is the distilled line.
const SOURCES_SQL = `
  SELECT 'frame:'||id AS key, 'screen' AS kind, id AS refId, text AS text,
         COALESCE(surface,'') AS surface, COALESCE(url,'') AS url,
         ${epochMsSql('ts')} AS ts
    FROM frames WHERE text IS NOT NULL AND length(text) > 20
  UNION ALL
  SELECT 'obs:'||id, 'screen', id, summary, COALESCE(surface,''), COALESCE(url,''),
         ${epochMsSql('ts')}
    FROM observations WHERE summary IS NOT NULL AND length(summary) > 0
  UNION ALL
  SELECT 'sum:'||rowid, 'meeting', rowid, summary, 'Meeting', '', 0
    FROM chat_summaries WHERE summary IS NOT NULL
  UNION ALL
  SELECT 'mtg:'||id, 'meeting', id,
         COALESCE(title,'Meeting')||'. '||COALESCE(summary, substr(transcript,1,2000)),
         'Meeting', '', COALESCE(started_at,0)
    FROM meetings WHERE COALESCE(summary, transcript) IS NOT NULL
  UNION ALL
  SELECT 'mem:'||id, 'memory', id, content, COALESCE(source_app,''), '', 0
    FROM memories WHERE content IS NOT NULL
  UNION ALL
  SELECT 'ent:'||id, 'entity', id, name||' '||COALESCE(summary,''), 'Entity', '', 0
    FROM entities WHERE hidden = 0
  UNION ALL
  SELECT 'fact:'||id, 'fact', entity_id, fact, 'Fact', '', 0
    FROM entity_facts`

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

function pendingCount(): number {
  ensureIndexTable()
  const row = getDB()
    .prepare(
      `SELECT COUNT(*) AS c FROM (${SOURCES_SQL}) s WHERE s.key NOT IN (SELECT key FROM vec_indexed)`
    )
    .get() as { c: number }
  return row.c
}

/** Embed one batch of un-indexed items into LanceDB. Returns progress. */
async function indexBatch(limit = 48): Promise<{ indexed: number; remaining: number }> {
  ensureIndexTable()
  const db = getDB()
  const rows = db
    .prepare(
      `SELECT * FROM (${SOURCES_SQL}) s WHERE s.key NOT IN (SELECT key FROM vec_indexed) LIMIT ?`
    )
    .all(limit) as PendingRow[]
  if (!rows.length) return { indexed: 0, remaining: 0 }

  const chunks: VecChunk[] = []
  for (const r of rows) {
    const text = (r.text || '').trim().slice(0, 1000)
    if (!text) continue
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
  db.transaction(() => rows.forEach((r) => mark.run(r.key)))()
  return { indexed: chunks.length, remaining: pendingCount() }
}

let backfilling = false
/** Drain the backlog in the background, one throttled batch at a time. */
export async function runBackfill(
  onProgress?: (p: { done: number; remaining: number }) => void
): Promise<void> {
  if (backfilling) return
  backfilling = true
  try {
    let done = 0
    for (;;) {
      const { indexed, remaining } = await indexBatch()
      done += indexed
      onProgress?.({ done, remaining })
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
export function searchSources(): { source: string; count: number }[] {
  ensureRagStoreSchema()
  const db = getDB()
  const rows = db
    .prepare(
      `SELECT surface AS source, COUNT(*) AS count FROM observations
        WHERE surface IS NOT NULL AND surface != '' GROUP BY surface ORDER BY count DESC LIMIT 20`
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
          `SELECT COALESCE(o.surface,'') AS source, COUNT(*) AS count
             FROM observation_fts f JOIN observations o ON o.id = f.rowid
            WHERE observation_fts MATCH ? AND o.surface IS NOT NULL AND o.surface != ''
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
    const docM = likeMatch(LIKE_COLUMNS.doc, terms)
    const kb = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (SELECT d.id FROM rag_chunks c JOIN rag_documents d ON d.id=c.doc_id WHERE ${docM.where} GROUP BY d.id)`
      )
      .get(...docM.args) as { c: number }
    if (kb.c) out.push({ source: 'Knowledge base', count: kb.c })
    const mtgM = likeMatch(LIKE_COLUMNS.meeting, terms)
    const mtg = db
      .prepare(`SELECT COUNT(*) AS c FROM meetings WHERE ${mtgM.where}`)
      .get(...mtgM.args) as { c: number }
    if (mtg.c) out.push({ source: 'Meeting', count: mtg.c })
  }
  return out
}

// ---------------------------------------------------------------------------
// Superseding a query stream
// ---------------------------------------------------------------------------

/**
 * A search box issues one request per settled query, and the newest one is the only answer anybody
 * will ever look at. Dropping the older ANSWER (which the renderer already does) still pays for it:
 * the embedding, the vector search, one source-of-truth probe per semantic hit, the fusion and
 * ranking, and one thumbnail query per result all run to completion and compete for the same CPU
 * that has to paint the next keystroke. So the older WORK stops instead.
 *
 * Superseding is per stream, and a stream is one surface's typing: the Search screen's box must not
 * cancel a retrieval a chat turn is waiting on, and vice versa. A caller that is not a stream of
 * queries (a one-shot tool call, a RAG retrieval) passes no stream and is never superseded.
 */
export class SupersededSearchError extends Error {
  constructor(stream: string) {
    super(`Search on "${stream}" stopped: a newer query superseded it.`)
    this.name = 'SupersededSearchError'
  }
}

/** Asserts, at each point work could be abandoned, that this request is still the newest one. */
export interface SearchStreamClaim {
  readonly check: () => void
  /** Drop this request's entry once it is finished, so the map holds only in-flight streams. */
  readonly release: () => void
}

/**
 * The stream identity for one typing surface in ONE window.
 *
 * A stream is "one surface's typing", and with more than one renderer window open the surface name
 * alone does not say that: two windows both searching would share the identity `search`, so one
 * window's newer keystroke would supersede a live query in the other, and each would be cancelling
 * work the other is still waiting for. The window is therefore part of the identity.
 *
 * `senderId` is the invoking `WebContents.id`, which the IPC boundary already has on its event and
 * which is how the rest of this process scopes per-window state (`artifact-preview-ipc.ts` keys
 * previews by `event.sender.id`; `voice-transcription-ipc.ts` keys a request by sender AND request
 * id). Deriving it here rather than at the boundary keeps the identity in the same file as the map
 * that consumes it, so the two cannot drift - and needs no registry of windows.
 */
export function searchStreamId(surface: string, senderId: number): string {
  return `${surface}#${String(senderId)}`
}

let issuedSearches = 0
/**
 * Newest token per stream. Keyed by (surface, window), so it is bounded by the number of streams
 * with a request IN FLIGHT: `release` removes the entry when the newest holder finishes. Window ids
 * are monotonic, so without the release a long session that opens and closes windows would grow
 * this map forever.
 */
const newestPerStream = new Map<string, number>()

/** No stream named: nothing can supersede this request, so every checkpoint passes. */
const NEVER_SUPERSEDED: SearchStreamClaim = { check: () => undefined, release: () => undefined }

function claimStream(stream: string | undefined): SearchStreamClaim {
  if (!stream) return NEVER_SUPERSEDED
  issuedSearches += 1
  const mine = issuedSearches
  newestPerStream.set(stream, mine)
  return {
    check: (): void => {
      if (newestPerStream.get(stream) !== mine) throw new SupersededSearchError(stream)
    },
    release: (): void => {
      // Only the newest holder clears the entry. An older request releasing would erase the token a
      // live newer request is still checking against, and that request would stop being cancellable.
      if (newestPerStream.get(stream) === mine) newestPerStream.delete(stream)
    }
  }
}

/**
 * Hand the event loop back for one macrotask before starting expensive work.
 *
 * A newer `search:universal` message can already be sitting in the IPC queue while this request is
 * running its (synchronous) keyword pass. Yielding lets that message be handled first, so the token
 * moves and the next checkpoint abandons this request BEFORE it asks the embedding model for a
 * vector nobody will use. Without the yield the older request reaches the model first and, because
 * embeddings are serialized onto one worker, makes the newest query wait behind it.
 */
function yieldToQueuedRequests(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
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
    // Raw frame OCR via LIKE — catches exact on-screen words dropped from the summary.
    likeFrameHits(query, perSource),
    // Your own chat conversations (title + message content), one hit per chat.
    likeChatHits(query, perSource),
    // Project knowledge-base documents (chunked file content).
    likeDocHits(query, perSource)
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

// Knowledge-base documents (per project) — LIKE over chunk content, one hit per
// document. The owning project_id is carried in `url` so the renderer can open it.
function likeDocHits(query: string, limit: number): RawHit[] {
  const terms = queryTerms(query, 6)
  if (!terms.length) return []
  const { where, args } = likeMatch(LIKE_COLUMNS.doc, terms)
  return getDB()
    .prepare(
      `SELECT 'doc:'||d.id AS key, 'doc' AS kind, d.id AS refId, d.name AS title,
              substr(c.content,1,300) AS snippet, 'Knowledge base' AS surface, d.project_id AS url,
              ${epochMsSql('d.created_at')} AS ts
         FROM rag_chunks c JOIN rag_documents d ON d.id = c.doc_id
        WHERE ${where} GROUP BY d.id LIMIT ?`
    )
    .all(...args, limit) as RawHit[]
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

// Frames have no FTS index; match raw OCR text on all tokens (AND), newest first.
function likeFrameHits(query: string, limit: number): RawHit[] {
  const terms = queryTerms(query, 6)
  if (!terms.length) return []
  const { where, args } = likeMatch(LIKE_COLUMNS.frame, terms)
  return getDB()
    .prepare(
      `SELECT 'frame:'||id AS key, 'screen' AS kind, id AS refId, COALESCE(surface,'Screen') AS title,
              substr(text,1,300) AS snippet, COALESCE(surface,'') AS surface, url AS url,
              ${epochMsSql('ts')} AS ts
         FROM frames WHERE text IS NOT NULL AND ${where} ORDER BY ts DESC LIMIT ?`
    )
    .all(...args, limit) as RawHit[]
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
export async function searchSemanticSources(
  vector: number[],
  limit: number,
  claim: SearchStreamClaim = NEVER_SUPERSEDED
): Promise<RawHit[]> {
  const hits = await searchVectors(vector, limit)
  // One source-of-truth probe per hit follows, and `searchVectors` is an await - the query can have
  // been typed past while it ran. Stopping here is what keeps obsolete work bounded: it is the
  // difference between abandoning a dead query and running N SQLite probes for nobody.
  claim.check()
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

/** One reporter, one key, so a standing "semantic search is not running" clears when it runs again. */
export const SEMANTIC_SEARCH_DEGRADATION_SOURCE = 'search-semantic'

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Report what the semantic half of a search just did: `reason` names a fault, `null` clears a
 * standing one because the pass ran.
 *
 * ONE guard wraps the whole body, and it deliberately swallows. Observation must never change the
 * outcome of the work it observes: the caller is a search that still holds good keyword hits, and
 * turning those hits into a rejection because REPORTING failed would invert the entire point of
 * this function. Every path in here can fail - shared application health can be unavailable before
 * the application root is registered, and the diagnostic's stderr mirror can throw on a dead pipe.
 * Silent is the same conclusion `guardConsoleStreams` reaches for the same reason
 * (`stream-guards.ts:12`): when the logger is what is broken, there is by definition nowhere to log
 * it, and a second reporting channel invented here would just be a second thing that can fail.
 *
 * The degradation report goes FIRST, before the diagnostic, precisely so a throwing logger cannot
 * cost the user the visible signal - the projection is the half a surface actually paints.
 *
 * What this guarantees: the caller always gets its result. What it merely ATTEMPTS: the report and
 * the log line. If both fail, the degradation is genuinely lost, and that is the accepted trade -
 * the alternative is failing a search that was perfectly answerable.
 */
function reportSemanticStatus(reason: string | null): void {
  try {
    reportDesktopApplicationDegraded({
      domain: 'rag',
      source: SEMANTIC_SEARCH_DEGRADATION_SOURCE,
      reason
    })
    // The reason only. NEVER the query: this log is written to disk, and a person's search terms are
    // among the most sensitive strings this application holds.
    if (reason !== null) writeDiagnosticLog('search', 'semantic.failed', { reason }, 'error')
  } catch {
    /* swallow: reporting a degradation must not be able to fail the search it observed */
  }
}

/**
 * The semantic list for a query, and the policy for when there isn't one.
 *
 * Three outcomes land here and they are NOT the same thing:
 *
 * - Superseded means this request was told to stop. That is not a failure - it is a query the user
 *   typed past - so it propagates untouched and the whole search ends. Nothing is reported.
 * - A pass that ran returns its hits, and clears this reporter's degradation entry. Zero hits is a
 *   real answer here: the query genuinely had no semantic neighbours.
 * - Any other fault - the embedding model unavailable, a vector-store or I/O error, a malformed
 *   response, a bug - means the semantic half DID NOT RUN. The keyword half is still a good answer,
 *   so this returns an empty list and the search continues on keywords alone; that fallback is the
 *   point and must not regress into a failed search. But the empty list is then indistinguishable
 *   from "no semantic matches existed", which is the defect this exists to prevent: the fault is
 *   recorded in the diagnostics log AND published on the `rag` degradation projection, so a surface
 *   can say the semantic half of search is not running, and why, instead of silently showing half
 *   the results as if they were all of them.
 */
async function semanticHitsOrDegrade(
  query: string,
  limit: number,
  claim: SearchStreamClaim
): Promise<RawHit[]> {
  try {
    const hits = await semanticHits(query, limit, claim)
    // Checked HERE, not only inside the callee. The callee checks before it resolves, but this
    // caller resumes in a later microtask - and another request can claim the stream in that gap,
    // so a check that passed there can already be stale by the time we publish. The same reason the
    // failure path checks before reporting: nothing about a query nobody is waiting for may reach
    // application health, and clearing a degradation that is still true for the LIVE query is the
    // worst version of that.
    claim.check()
    reportSemanticStatus(null)
    return hits
  } catch (error) {
    if (error instanceof SupersededSearchError) throw error
    // An answer from a query nobody is waiting for must not publish anything. A fault raised for a
    // query the user has already typed past says nothing about the one now in flight, and reporting
    // it would leave a "semantic search is not running" standing that the live query may contradict.
    // Superseded takes precedence over the fault, so this rethrows rather than reports.
    claim.check()
    reportSemanticStatus(`Semantic search did not run: ${describe(error)}`)
    return []
  }
}

async function semanticHits(
  query: string,
  limit: number,
  claim: SearchStreamClaim
): Promise<RawHit[]> {
  await yieldToQueuedRequests()
  claim.check() // don't embed for a query the user has already typed past
  const vector = await embeddings.generateEmbedding(query)
  claim.check() // don't search vectors, or probe SQLite per hit, for a dead query
  const hits = await searchSemanticSources(vector, limit, claim)
  // The last await has returned, so this is where a reply belonging to a query the user typed past
  // would otherwise look like a success. Checking BEFORE the caller reports is what stops an
  // obsolete reply clearing a degradation that is still true for the query actually in flight.
  claim.check()
  return hits
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

export interface UniversalSearchOptions {
  limit?: number
  semantic?: boolean
  sources?: string[]
  kinds?: SearchKind[]
  collapseScreenMoments?: boolean
  sort?: SearchSort
  excludeChatId?: string
  /** Shared policy resolves relative language; this adapter applies its absolute interval. */
  timeRange?: Parameters<typeof rankResults>[1]['timeRange']
  /**
   * Names this caller's stream of queries, so a newer one abandons this one. Build it with
   * `searchStreamId(surface, senderId)` so the identity is per WINDOW as well as per surface - a
   * bare surface name lets two windows supersede each other. A caller that is not a stream of
   * queries (a one-shot tool call, a RAG retrieval) passes nothing and is never superseded.
   */
  stream?: string
}

export async function universalSearch(
  query: string,
  opts: UniversalSearchOptions = {}
): Promise<SearchResult[]> {
  const claim = claimStream(opts.stream)
  try {
    return await runUniversalSearch(query, opts, claim)
  } finally {
    claim.release()
  }
}

async function runUniversalSearch(
  query: string,
  opts: UniversalSearchOptions,
  claim: SearchStreamClaim
): Promise<SearchResult[]> {
  ensureRagStoreSchema()
  const q = query.trim()
  if (!q) return []
  const limit = opts.limit ?? 30
  // When filtering by source, cast a wider net per source so enough survive the filter.
  const perSource = opts.sources?.length ? 80 : Math.min(40, limit + 10)

  // The keyword pass is synchronous SQL: it cannot be abandoned part-way and nothing newer can
  // arrive while it runs, so the first checkpoint that can fire is inside the semantic pass.
  const lists = keywordHits(q, perSource)
  if (opts.semantic !== false) lists.push(await semanticHitsOrDegrade(q, perSource, claim))

  // Fusion, ranking and one thumbnail query per result are the rest of the bill. Nothing below
  // awaits, so this is the last point at which a query the user has moved on from can be dropped.
  claim.check()

  // Reciprocal-rank fusion across all lists, keyed by the unique chunk key.
  const fused = fuseHits(lists)

  // Add a recency bias so recent hits float up (this week first, then progressively
  // older), plus a small nudge for your own deliberate content (chats / KB docs) so
  // it isn't buried under thousands of ambient screen captures.
  applyBoosts(fused.values(), Date.now())

  // Filter (source / current chat) then sort (relevance / recency / match).
  const ordered = rankResults(Array.from(fused.values()), {
    query: q,
    sources: opts.sources,
    kinds: opts.kinds,
    excludeChatId: opts.excludeChatId,
    sort: opts.sort,
    timeRange: opts.timeRange
  })
  for (const r of ordered)
    r.imagePath = thumbFor({ key: r.key, kind: r.kind, refId: r.refId } as RawHit)

  if (!opts.collapseScreenMoments) return ordered.slice(0, limit)

  // One captured moment is indexed twice: its raw OCR frame and its distilled
  // observation. Replay shows moments, not index records, so collapse both forms
  // after ranking and thumbnail resolution. General search keeps both records.
  const seenMoments = new Set<string>()
  const moments: SearchResult[] = []
  for (const result of ordered) {
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
