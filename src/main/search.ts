// Universal search — the single front door over everything Off Grid has seen.
// Hybrid: FTS5 keyword (exact words you saw) + LanceDB semantic (NLP recall),
// fused with reciprocal-rank fusion. Plus a background backfill that embeds the
// observation/frame/transcript backlog (using the in-app MiniLM model) so the
// semantic half actually covers your captured life. All local, all offline.
import { getDB } from './database';
import { embeddings } from './embeddings';
import { addChunks, searchVectors, vectorCount, type VecChunk } from './vectors';
import { recencyBoost, kindBoost, matchScore } from './search-ranking';

export type SearchKind = 'screen' | 'meeting' | 'memory' | 'entity' | 'fact' | 'artifact' | 'chat' | 'doc';

export interface SearchResult {
  key: string;
  kind: SearchKind;
  refId: number;
  title: string;
  snippet: string;
  surface: string;
  url: string | null;
  ts: number; // epoch ms
  imagePath: string | null;
  score: number;
}

// ---------------------------------------------------------------------------
// Backfill: embed the backlog into LanceDB (keys tracked in SQLite to skip work)
// ---------------------------------------------------------------------------

// One row per indexable item across all surfaces. frames.text is the raw OCR
// (richest for "find what I saw"); observations.summary is the distilled line.
const SOURCES_SQL = `
  SELECT 'frame:'||id AS key, 'screen' AS kind, id AS refId, text AS text,
         COALESCE(surface,'') AS surface, COALESCE(url,'') AS url,
         CAST(strftime('%s', ts) AS INTEGER)*1000 AS ts
    FROM frames WHERE text IS NOT NULL AND length(text) > 20
  UNION ALL
  SELECT 'obs:'||id, 'screen', id, summary, COALESCE(surface,''), COALESCE(url,''),
         CAST(strftime('%s', ts) AS INTEGER)*1000
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
    FROM entity_facts`;

interface PendingRow { key: string; kind: SearchKind; refId: number; text: string; surface: string; url: string; ts: number }

function ensureIndexTable(): void {
  getDB().exec('CREATE TABLE IF NOT EXISTS vec_indexed (key TEXT PRIMARY KEY)');
}

function pendingCount(): number {
  ensureIndexTable();
  const row = getDB()
    .prepare(`SELECT COUNT(*) AS c FROM (${SOURCES_SQL}) s WHERE s.key NOT IN (SELECT key FROM vec_indexed)`)
    .get() as { c: number };
  return row.c;
}

/** Embed one batch of un-indexed items into LanceDB. Returns progress. */
export async function indexBatch(limit = 48): Promise<{ indexed: number; remaining: number }> {
  ensureIndexTable();
  const db = getDB();
  const rows = db
    .prepare(`SELECT * FROM (${SOURCES_SQL}) s WHERE s.key NOT IN (SELECT key FROM vec_indexed) LIMIT ?`)
    .all(limit) as PendingRow[];
  if (!rows.length) return { indexed: 0, remaining: 0 };

  const chunks: VecChunk[] = [];
  for (const r of rows) {
    const text = (r.text || '').trim().slice(0, 1000);
    if (!text) continue;
    const vector = await embeddings.generateEmbedding(text);
    chunks.push({ key: r.key, kind: r.kind, refId: r.refId, vector, text: text.slice(0, 300), surface: r.surface, url: r.url, ts: r.ts || 0 });
  }
  await addChunks(chunks);

  const mark = db.prepare('INSERT OR IGNORE INTO vec_indexed (key) VALUES (?)');
  db.transaction(() => rows.forEach((r) => mark.run(r.key)))();
  return { indexed: chunks.length, remaining: pendingCount() };
}

let backfilling = false;
/** Drain the backlog in the background, one throttled batch at a time. */
export async function runBackfill(onProgress?: (p: { done: number; remaining: number }) => void): Promise<void> {
  if (backfilling) return;
  backfilling = true;
  try {
    let done = 0;
    for (;;) {
      const { indexed, remaining } = await indexBatch();
      done += indexed;
      onProgress?.({ done, remaining });
      if (remaining === 0) break;
      await new Promise((r) => setTimeout(r, 50)); // breathe — don't starve the LLM/UI
    }
  } finally {
    backfilling = false;
  }
}

export async function searchStatus(): Promise<{ vectors: number; pending: number }> {
  return { vectors: await vectorCount(), pending: pendingCount() };
}

/** Data sources available to filter by (surfaces seen, busiest first, + meetings). */
export function searchSources(): { source: string; count: number }[] {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT surface AS source, COUNT(*) AS count FROM observations
        WHERE surface IS NOT NULL AND surface != '' GROUP BY surface ORDER BY count DESC LIMIT 20`
    )
    .all() as { source: string; count: number }[];
  const mtg = db.prepare('SELECT COUNT(*) AS c FROM meetings').get() as { c: number };
  if (mtg.c) rows.push({ source: 'Meeting', count: mtg.c });
  // Your own data, not just captured surfaces: chats and project knowledge bases.
  const chat = db.prepare('SELECT COUNT(*) AS c FROM rag_conversations').get() as { c: number };
  if (chat.c) rows.push({ source: 'Chat', count: chat.c });
  const kb = db.prepare('SELECT COUNT(*) AS c FROM rag_documents').get() as { c: number };
  if (kb.c) rows.push({ source: 'Knowledge base', count: kb.c });
  return rows;
}

/** Per-source MATCH counts for a query — drives the Sources rail facet counts so
 *  the numbers reflect the current search (Chat: 1, Knowledge base: 0, …). Empty
 *  query → total counts (searchSources). Only sources with ≥1 match are returned. */
export function searchFacets(query: string): { source: string; count: number }[] {
  const q = query.trim();
  if (!q) return searchSources();
  const db = getDB();
  const out: { source: string; count: number }[] = [];
  const m = ftsExpr(q);
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
    );
  }
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
  if (terms.length) {
    const chatWhere = terms.map(() => '(lower(rm.content) LIKE ? OR lower(rc.title) LIKE ?)').join(' AND ');
    const chat = db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT rc.id FROM rag_messages rm JOIN rag_conversations rc ON rc.id=rm.conversation_id WHERE ${chatWhere} GROUP BY rc.id)`)
      .get(...terms.flatMap((t) => [`%${t}%`, `%${t}%`])) as { c: number };
    if (chat.c) out.push({ source: 'Chat', count: chat.c });
    const docWhere = terms.map(() => '(lower(c.content) LIKE ? OR lower(d.name) LIKE ?)').join(' AND ');
    const kb = db
      .prepare(`SELECT COUNT(*) AS c FROM (SELECT d.id FROM rag_chunks c JOIN rag_documents d ON d.id=c.doc_id WHERE ${docWhere} GROUP BY d.id)`)
      .get(...terms.flatMap((t) => [`%${t}%`, `%${t}%`])) as { c: number };
    if (kb.c) out.push({ source: 'Knowledge base', count: kb.c });
    const mtgWhere = terms.map(() => '(lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(transcript) LIKE ?)').join(' AND ');
    const mtg = db
      .prepare(`SELECT COUNT(*) AS c FROM meetings WHERE ${mtgWhere}`)
      .get(...terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`])) as { c: number };
    if (mtg.c) out.push({ source: 'Meeting', count: mtg.c });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query: keyword (FTS5) + semantic (LanceDB), fused with RRF
// ---------------------------------------------------------------------------

// Sanitize a free-text query into an FTS5 MATCH expression: each token becomes a
// prefix-match term; punctuation is dropped so user input can't be a syntax error.
function ftsExpr(query: string): string {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12);
  return terms.map((t) => `"${t}"*`).join(' ');
}

const RRF_K = 60;
function rrf(rank: number): number {
  return 1 / (RRF_K + rank);
}


interface RawHit { key: string; kind: SearchKind; refId: number; title: string; snippet: string; surface: string; url: string | null; ts: number }

// One FTS source → ranked raw hits (best first). `sql` must SELECT the RawHit columns.
function ftsHits(sql: string, match: string, limit: number): RawHit[] {
  if (!match) return [];
  return getDB().prepare(sql).all(match, limit) as RawHit[];
}

function keywordHits(query: string, perSource: number): RawHit[][] {
  const m = ftsExpr(query);
  const epochMs = `CAST(strftime('%s', o.ts) AS INTEGER)*1000`;
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
      `SELECT 'fact:'||o.entity_id AS key, 'fact' AS kind, o.entity_id AS refId,
              (SELECT name FROM entities e WHERE e.id = o.entity_id) AS title,
              o.fact AS snippet, 'Fact' AS surface, NULL AS url, 0 AS ts
         FROM entity_fact_fts f JOIN entity_facts o ON o.id = f.rowid
        WHERE entity_fact_fts MATCH ? ORDER BY bm25(entity_fact_fts) LIMIT ?`,
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
    likeDocHits(query, perSource),
  ];
}

// Chat conversations have no FTS index — LIKE over message content OR the chat
// title, one hit per conversation (newest first). The conversation id (TEXT) is
// carried in `url` so the renderer can open that exact chat.
function likeChatHits(query: string, limit: number): RawHit[] {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map(() => '(lower(rm.content) LIKE ? OR lower(rc.title) LIKE ?)').join(' AND ');
  const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  return getDB()
    .prepare(
      `SELECT 'chat:'||rc.id AS key, 'chat' AS kind, 0 AS refId, COALESCE(rc.title,'Chat') AS title,
              substr(rm.content,1,300) AS snippet, 'Chat' AS surface, rc.id AS url,
              CAST(strftime('%s', rc.updated_at) AS INTEGER)*1000 AS ts
         FROM rag_messages rm JOIN rag_conversations rc ON rc.id = rm.conversation_id
        WHERE ${where} GROUP BY rc.id ORDER BY rc.updated_at DESC LIMIT ?`
    )
    .all(...args, limit) as RawHit[];
}

// Knowledge-base documents (per project) — LIKE over chunk content, one hit per
// document. The owning project_id is carried in `url` so the renderer can open it.
function likeDocHits(query: string, limit: number): RawHit[] {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map(() => '(lower(c.content) LIKE ? OR lower(d.name) LIKE ?)').join(' AND ');
  const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  return getDB()
    .prepare(
      `SELECT 'doc:'||d.id AS key, 'doc' AS kind, d.id AS refId, d.name AS title,
              substr(c.content,1,300) AS snippet, 'Knowledge base' AS surface, d.project_id AS url,
              CAST(strftime('%s', d.created_at) AS INTEGER)*1000 AS ts
         FROM rag_chunks c JOIN rag_documents d ON d.id = c.doc_id
        WHERE ${where} GROUP BY d.id LIMIT ?`
    )
    .all(...args, limit) as RawHit[];
}

function likeMeetingHits(query: string, limit: number): RawHit[] {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map(() => '(lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(transcript) LIKE ?)').join(' AND ');
  const args = terms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]);
  return getDB()
    .prepare(
      `SELECT 'mtg:'||id AS key, 'meeting' AS kind, id AS refId, COALESCE(title,'Meeting') AS title,
              substr(COALESCE(summary, transcript),1,300) AS snippet, 'Meeting' AS surface, NULL AS url,
              COALESCE(started_at,0) AS ts
         FROM meetings WHERE ${where} ORDER BY started_at DESC LIMIT ?`
    )
    .all(...args, limit) as RawHit[];
}

// Frames have no FTS index; match raw OCR text on all tokens (AND), newest first.
function likeFrameHits(query: string, limit: number): RawHit[] {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 6);
  if (!terms.length) return [];
  const where = terms.map(() => 'lower(text) LIKE ?').join(' AND ');
  const args = terms.map((t) => `%${t}%`);
  return getDB()
    .prepare(
      `SELECT 'frame:'||id AS key, 'screen' AS kind, id AS refId, COALESCE(surface,'Screen') AS title,
              substr(text,1,300) AS snippet, COALESCE(surface,'') AS surface, url AS url,
              CAST(strftime('%s', ts) AS INTEGER)*1000 AS ts
         FROM frames WHERE text IS NOT NULL AND ${where} ORDER BY ts DESC LIMIT ?`
    )
    .all(...args, limit) as RawHit[];
}

// Recent feed for the EMPTY-query default state: the latest of everything you've
// seen/said/saved — observations (all surfaces incl. connectors), your chats, and
// meetings — newest first. The same source rail + sort tabs then filter it. Each
// query is guarded so a missing table (free build / fresh db) just contributes none.
function recentFeedLists(limit: number): RawHit[][] {
  const db = getDB();
  const q = (sql: string, n: number): RawHit[] => { try { return db.prepare(sql).all(n) as RawHit[]; } catch { return []; } };
  return [
    q(`SELECT 'obs:'||o.id AS key, 'screen' AS kind, o.id AS refId, COALESCE(o.surface,'Screen') AS title,
              o.summary AS snippet, COALESCE(o.surface,'') AS surface, o.url AS url,
              CAST(strftime('%s', o.ts) AS INTEGER)*1000 AS ts
         FROM observations o WHERE o.summary IS NOT NULL AND TRIM(o.summary) != ''
        ORDER BY o.ts DESC LIMIT ?`, limit),
    q(`SELECT 'chat:'||rc.id AS key, 'chat' AS kind, 0 AS refId, COALESCE(rc.title,'Chat') AS title,
              '' AS snippet, 'Chat' AS surface, rc.id AS url,
              CAST(strftime('%s', rc.updated_at) AS INTEGER)*1000 AS ts
         FROM rag_conversations rc ORDER BY rc.updated_at DESC LIMIT ?`, Math.min(limit, 25)),
    q(`SELECT 'mtg:'||id AS key, 'meeting' AS kind, id AS refId, COALESCE(title,'Meeting') AS title,
              substr(COALESCE(summary,transcript),1,300) AS snippet, 'Meeting' AS surface, NULL AS url,
              COALESCE(started_at,0) AS ts
         FROM meetings ORDER BY started_at DESC LIMIT ?`, Math.min(limit, 25)),
  ];
}

async function semanticHits(query: string, limit: number): Promise<RawHit[]> {
  const vector = await embeddings.generateEmbedding(query);
  const hits = await searchVectors(vector, limit);
  return hits.map((h) => ({ key: h.key, kind: h.kind as SearchKind, refId: h.refId, title: h.surface || h.kind, snippet: h.text, surface: h.surface, url: h.url || null, ts: h.ts }));
}

// Best thumbnail for a hit: a frame's own image, or an observation's linked frame.
function thumbFor(hit: RawHit): string | null {
  const db = getDB();
  if (hit.key.startsWith('frame:')) {
    const r = db.prepare('SELECT image_path FROM frames WHERE id = ?').get(hit.refId) as { image_path?: string } | undefined;
    return r?.image_path ?? null;
  }
  if (hit.kind === 'screen') {
    const r = db
      .prepare('SELECT f.image_path FROM observation_frames of JOIN frames f ON f.id = of.frame_id WHERE of.observation_id = ? LIMIT 1')
      .get(hit.refId) as { image_path?: string } | undefined;
    return r?.image_path ?? null;
  }
  return null;
}

/** Hybrid universal search. `semantic` adds the LanceDB pass (slower first call). */
// NOTE: artifacts are intentionally NOT in universal search yet — a hit can't be
// deep-linked (it carries no conversation context and there's no standalone
// artifact viewer), so clicking one used to jump to a meaningless Replay moment.
// Re-add an `artifactHits` source here once artifacts have an openable target.

export type SearchSort = 'relevance' | 'recency' | 'match';

export async function universalSearch(
  query: string,
  opts: { limit?: number; semantic?: boolean; sources?: string[]; sort?: SearchSort; excludeChatId?: string } = {}
): Promise<SearchResult[]> {
  const q = query.trim();
  const limit = opts.limit ?? 30;
  // When filtering by source, cast a wider net per source so enough survive the filter.
  const perSource = opts.sources?.length ? 80 : Math.min(40, limit + 10);
  const sourceSet = opts.sources?.length ? new Set(opts.sources.map((s) => s.toLowerCase())) : null;

  // Empty query → the recent feed (the default landing state). With a query →
  // keyword + semantic hits.
  const lists = q ? keywordHits(q, perSource) : recentFeedLists(Math.max(perSource, limit + 20));
  if (q && opts.semantic !== false) {
    try {
      lists.push(await semanticHits(q, perSource));
    } catch {
      /* embedding model not ready — keyword results still fine */
    }
  }

  // Reciprocal-rank fusion across all lists, keyed by the unique chunk key.
  const fused = new Map<string, SearchResult>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const existing = fused.get(hit.key);
      if (existing) {
        existing.score += rrf(rank);
        return;
      }
      fused.set(hit.key, {
        key: hit.key,
        kind: hit.kind,
        refId: hit.refId,
        title: hit.title || hit.kind,
        snippet: (hit.snippet || '').slice(0, 280),
        surface: hit.surface || '',
        url: hit.url,
        ts: hit.ts || 0,
        imagePath: null,
        score: rrf(rank),
      });
    });
  }

  // Add a recency bias so recent hits float up (this week first, then progressively
  // older), plus a small nudge for your own deliberate content (chats / KB docs) so
  // it isn't buried under thousands of ambient screen captures.
  const now = Date.now();
  for (const r of fused.values()) {
    r.score += recencyBoost(r.ts, now);
    r.score += kindBoost(r.kind);
  }
  let ordered = Array.from(fused.values());
  if (sourceSet) ordered = ordered.filter((r) => sourceSet.has((r.surface || '').toLowerCase()));
  // Don't let an answer cite the very conversation it's being asked in.
  if (opts.excludeChatId) ordered = ordered.filter((r) => r.key !== `chat:${opts.excludeChatId}`);
  // Sort: relevance = blended score (default); recency = newest first; match =
  // strongest literal term overlap in title/snippet (ties broken by score).
  // Empty feed is always newest-first; with a query, honor the chosen sort.
  const sort = q ? (opts.sort ?? 'relevance') : 'recency';
  if (sort === 'recency') {
    ordered.sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.score - a.score);
  } else if (sort === 'match') {
    const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const m = (r: SearchResult): number => matchScore(`${r.title} ${r.snippet}`, terms);
    ordered.sort((a, b) => m(b) - m(a) || b.score - a.score);
  } else {
    ordered.sort((a, b) => b.score - a.score);
  }
  const ranked = ordered.slice(0, limit);
  for (const r of ranked) r.imagePath = thumbFor({ key: r.key, kind: r.kind, refId: r.refId } as RawHit);
  return ranked;
}
