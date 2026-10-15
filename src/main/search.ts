// Universal search — the single front door over everything Off Grid AI has seen. It is the
// records engine (records/, over @offgrid/rag/records): keyword (FTS5) and meaning (record
// vectors) per source, fused with reciprocal-rank fusion, the people a question names, a time
// window read from the question, and an optional cross-encoder. This file adds what the Search
// screen and the command palette need on top: sources (surfaces) to filter by, facet counts, the
// sort modes, the newest-first feed for an empty query, and the embedding backlog. All local, all
// offline.
import { getDB, tableExists } from './database'
import { ensureRagStoreSchema } from './rag/store'
import {
  ftsTrigramQuery,
  ftsTypeahead,
  needsTrigram,
  parseTimeWindow,
  withoutTimePhrase,
  type RecordHit,
  type TimeWindow
} from '@offgrid/rag/records'
import {
  embedRecordBacklog,
  ensureRecordSchema,
  recordIndexStatus,
  recordSearch,
  recordToSearchResult,
  screenMomentKey
} from './records'
import {
  actionWhenSql,
  epochMs,
  hydrateRecords,
  SYNCED_BULK_MAIL,
  windowSql
} from './records/sources'
import type { SearchKind, SearchResult, SearchSort } from '../shared/search-contract'

export type { SearchResult, SearchSort } from '../shared/search-contract'

/** Most results one search returns (the Search screen pages 50 at a time). */
const MAX_RESULTS = 200
/** Results asked of the engine beyond the page, for the moments Replay folds together. */
const RESULT_MARGIN = 10

// ---------------------------------------------------------------------------
// Backfill: embed the record backlog (record_queue) into record_vectors
// ---------------------------------------------------------------------------

/** Drain the embedding backlog in the background, one throttled batch at a time. */
export async function runBackfill(
  onProgress?: (p: { done: number; remaining: number }) => void
): Promise<void> {
  await embedRecordBacklog(onProgress)
}

export async function searchStatus(): Promise<{ vectors: number; pending: number }> {
  return recordIndexStatus()
}

// ---------------------------------------------------------------------------
// Sources (surfaces) and facet counts
// ---------------------------------------------------------------------------

/** Distinct moments, as the result list shows them: one per app and summary, not one per capture. */
const DISTINCT_MOMENTS = 'COUNT(DISTINCT lower(trim(o.summary)))'

/** Surfaces that are not apps a moment was seen in, and the record kind each one is. Any other
 *  surface is a screen moment's app. */
const SURFACE_KINDS: Record<string, string[]> = {
  meeting: ['meeting'],
  chat: ['chat'],
  'knowledge base': ['doc'],
  'to-do': ['action'],
  entity: ['entity'],
  'chat summary': ['summary']
}

/** Totals are a full pass over every observation; the rail asks for them on every visit. */
const SOURCE_TOTALS_TTL_MS = 60_000
let sourceTotals: { at: number; rows: { source: string; count: number }[] } | null = null

/** Data sources available to filter by (surfaces seen, busiest first, + meetings, to-dos, chats
 *  and knowledge bases). Bulk mail synced from a connected account is searchable but not counted. */
export function searchSources(): { source: string; count: number }[] {
  const now = Date.now()
  if (sourceTotals && now - sourceTotals.at < SOURCE_TOTALS_TTL_MS) return sourceTotals.rows
  const rows = countSources(null)
  sourceTotals = { at: now, rows }
  return rows
}

/** Items per source, within `window` when given: what the empty-query feed and a time-only query
 *  ("yesterday") list. Only sources with at least one item. */
function countSources(window: TimeWindow | null): { source: string; count: number }[] {
  ensureRagStoreSchema()
  const db = getDB()
  const out: { source: string; count: number }[] = []
  if (tableExists(db, 'observations')) {
    const w = windowSql('o.ts', window, 'datetime')
    out.push(
      ...(db
        .prepare(
          `SELECT o.surface AS source, ${DISTINCT_MOMENTS} AS count FROM observations o
            WHERE o.surface IS NOT NULL AND o.surface != '' AND NOT ${SYNCED_BULK_MAIL}
              AND o.summary IS NOT NULL AND o.summary != ''${w.sql}
            GROUP BY o.surface ORDER BY count DESC LIMIT 20`
        )
        .all(...w.args) as { source: string; count: number }[])
    )
  }
  const counted = (source: string, table: string, sql: string, args: unknown[]): void => {
    if (!tableExists(db, table)) return
    const c = (db.prepare(sql).get(...args) as { c: number }).c
    if (c) out.push({ source, count: c })
  }
  const meetings = windowSql('started_at', window, 'ms')
  counted('Meeting', 'meetings', `SELECT COUNT(*) AS c FROM meetings WHERE 1 = 1${meetings.sql}`, [
    ...meetings.args
  ])
  const actions = windowSql(actionWhenSql('a'), window, 'ms')
  counted(
    'To-do',
    'action_items',
    `SELECT COUNT(*) AS c FROM action_items a WHERE a.status != 'dismissed'${actions.sql}`,
    actions.args
  )
  // Your own data, not just captured surfaces: chats and project knowledge bases.
  const chats = windowSql('updated_at', window, 'datetime')
  counted(
    'Chat',
    'rag_conversations',
    `SELECT COUNT(*) AS c FROM rag_conversations WHERE 1 = 1${chats.sql}`,
    chats.args
  )
  const documents = windowSql('created_at', window, 'datetime')
  counted(
    'Knowledge base',
    'rag_documents',
    `SELECT COUNT(*) AS c FROM rag_documents WHERE 1 = 1${documents.sql}`,
    documents.args
  )
  return out
}

/**
 * How a search box reads a query, the same for results and facet counts. A time phrase alone
 * ("yesterday") lists that window. With other words, the time only ranks items near it higher
 * ("monday standup", "Black Friday" may be words), and every word must match as a word start.
 */
function readSearchBox(query: string): { window: TimeWindow | null; timeOnly: boolean } {
  const window = parseTimeWindow(query)
  return { window, timeOnly: !!window && !ftsTypeahead(withoutTimePhrase(query, window)) }
}

/** Per-source counts for a query — drives the Sources rail so the numbers reflect the current
 *  search (Chat: 1, Knowledge base: 0, …), read the way universalSearch reads it: a time-only query
 *  counts what each source has in that window, any other query counts its keyword matches. Empty
 *  query → total counts (searchSources). Only sources with ≥1 match are returned. */
export function searchFacets(query: string): { source: string; count: number }[] {
  ensureRagStoreSchema()
  ensureRecordSchema()
  const q = query.trim()
  if (!q) return searchSources()
  const { window, timeOnly } = readSearchBox(q)
  if (timeOnly) return countSources(window)
  const match = ftsTypeahead(q)
  if (!match) return []
  const db = getDB()
  // A query in a script written without spaces also counts what its trigram twins match (runs of
  // three characters or more; shorter runs are only found by the search itself).
  const trigram = needsTrigram(q) ? ftsTrigramQuery(q)?.match : null
  /** `column` among the rows `fts` matches, or its trigram twin matches. */
  const matched = (fts: string, column: string, key = 'rowid'): { sql: string; args: string[] } => {
    const twin = `${fts}_tri`
    const own = `${column} IN (SELECT ${key} FROM ${fts} WHERE ${fts} MATCH ?)`
    if (!trigram || !tableExists(db, twin)) return { sql: own, args: [match] }
    return {
      sql: `(${own} OR ${column} IN (SELECT ${key} FROM ${twin} WHERE ${twin} MATCH ?))`,
      args: [match, trigram]
    }
  }
  const out: { source: string; count: number }[] = []
  const counted = (source: string, index: string, sql: string, args: unknown[]): void => {
    if (!tableExists(db, index)) return
    const c = (db.prepare(sql).get(...args) as { c: number }).c
    if (c) out.push({ source, count: c })
  }
  if (tableExists(db, 'observation_fts')) {
    const m = matched('observation_fts', 'o.id')
    out.push(
      ...(db
        .prepare(
          `SELECT COALESCE(o.surface,'') AS source, ${DISTINCT_MOMENTS} AS count
             FROM observations o
            WHERE ${m.sql} AND o.surface IS NOT NULL AND o.surface != ''
              AND NOT ${SYNCED_BULK_MAIL}
            GROUP BY o.surface ORDER BY count DESC`
        )
        .all(...m.args) as { source: string; count: number }[])
    )
  }
  if (tableExists(db, 'rag_message_fts')) {
    const m = matched('rag_message_fts', 'm.id')
    counted(
      'Chat',
      'rag_messages',
      `SELECT COUNT(DISTINCT m.conversation_id) AS c FROM rag_messages m WHERE ${m.sql}`,
      m.args
    )
  }
  if (tableExists(db, 'rag_documents') && tableExists(db, 'attached_document_fts')) {
    const m = matched('attached_document_fts', 'd.document_id', 'document_id')
    counted(
      'Knowledge base',
      'rag_documents',
      `SELECT COUNT(DISTINCT d.id) AS c FROM rag_documents d WHERE ${m.sql}`,
      m.args
    )
  }
  if (tableExists(db, 'meeting_fts')) {
    const m = matched('meeting_fts', 's.id')
    counted('Meeting', 'meetings', `SELECT COUNT(*) AS c FROM meetings s WHERE ${m.sql}`, m.args)
  }
  if (tableExists(db, 'action_fts')) {
    const m = matched('action_fts', 's.id')
    counted(
      'To-do',
      'action_items',
      `SELECT COUNT(*) AS c FROM action_items s WHERE ${m.sql} AND s.status != 'dismissed'`,
      m.args
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// The empty-query feed
// ---------------------------------------------------------------------------

/** The newest things in the index, for an empty query: captured moments (a screen that stayed put
 *  is one moment, not one per capture), recorded meetings, your chats and, when that source is
 *  chosen, your to-dos — newest first, within the chosen sources. Search opens on this feed. */
function recentResults(limit: number, sources?: string[]): SearchResult[] {
  const db = getDB()
  const wanted = sources?.length ? sources.map((source) => source.toLowerCase()) : null
  const want = (source: string): boolean => !wanted || wanted.includes(source.toLowerCase())
  const result = (row: Omit<SearchResult, 'imagePath' | 'score'>): SearchResult => ({
    ...row,
    imagePath: null,
    score: 0
  })
  // Newest moments, read light (id, app, summary) and folded on the same key search results use,
  // so only the moments shown are hydrated.
  const momentRows = tableExists(db, 'observations')
    ? (db
        .prepare(
          `SELECT o.id, COALESCE(o.surface, '') AS surface, o.summary FROM observations o
            WHERE o.summary IS NOT NULL AND o.summary != ''
              AND NOT ${SYNCED_BULK_MAIL}
              ${wanted ? `AND lower(o.surface) IN (${wanted.map(() => '?').join(',')})` : ''}
            ORDER BY o.ts DESC LIMIT ?`
        )
        .all(...(wanted ?? []), Math.min(400, limit * 4)) as {
        id: number
        surface: string
        summary: string
      }[])
    : []
  const seen = new Set<string>()
  const momentKeys: string[] = []
  for (const row of momentRows) {
    const hit: RecordHit = {
      key: `obs:${row.id}`,
      kind: 'screen',
      refId: row.id,
      title: row.surface,
      text: row.summary,
      ts: 0,
      surface: row.surface
    }
    const id = screenMomentKey(hit)
    if (seen.has(id)) continue
    seen.add(id)
    momentKeys.push(hit.key)
    if (momentKeys.length === limit) break
  }
  // To-dos only when chosen: an open feed is what was seen and said, not the task list.
  const actionKeys =
    wanted && want('To-do') && tableExists(db, 'action_items')
      ? (
          db
            .prepare(
              `SELECT a.id FROM action_items a WHERE a.status != 'dismissed'
                ORDER BY ${actionWhenSql('a')} DESC LIMIT ?`
            )
            .all(limit) as { id: number }[]
        ).map((row) => `act:${row.id}`)
      : []
  // Moments and to-dos come through the records' hydration, so they carry their picture, synced
  // state and due date.
  const records = hydrateRecords([...momentKeys, ...actionKeys]).map(recordToSearchResult)
  const meetings =
    want('Meeting') && tableExists(db, 'meetings')
      ? (
          db
            .prepare(
              `SELECT 'mtg:'||id AS key, id AS refId, COALESCE(title,'Meeting') AS title,
                      substr(COALESCE(summary, transcript, ''),1,300) AS snippet,
                      COALESCE(started_at,0) AS ts
                 FROM meetings ORDER BY started_at DESC LIMIT ?`
            )
            .all(limit) as {
            key: string
            refId: number
            title: string
            snippet: string
            ts: number
          }[]
        ).map((row) => result({ ...row, kind: 'meeting', surface: 'Meeting', url: null }))
      : []
  const chats = want('Chat')
    ? (
        db
          .prepare(
            `SELECT 'chat:'||rc.id AS key, COALESCE(rc.title,'Chat') AS title,
                    COALESCE((SELECT substr(rm.content,1,300) FROM rag_messages rm
                               WHERE rm.conversation_id = rc.id ORDER BY rm.rowid DESC LIMIT 1),'') AS snippet,
                    rc.id AS url, ${epochMs('rc.updated_at')} AS ts
               FROM rag_conversations rc ORDER BY rc.updated_at DESC LIMIT ?`
          )
          .all(limit) as { key: string; title: string; snippet: string; url: string; ts: number }[]
      ).map((row) => result({ ...row, kind: 'chat', refId: 0, surface: 'Chat' }))
    : []
  return [...records, ...meetings, ...chats]
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Lower-cased words of a query, for the "Match" sort. */
function queryTerms(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** Literal term-overlap count in a haystack (for the "Match" sort). Case-insensitive. */
export function matchScore(haystack: string, terms: string[]): number {
  const hay = (haystack || '').toLowerCase()
  return terms.reduce((n, t) => n + (t ? hay.split(t).length - 1 : 0), 0)
}

function sortResults(results: SearchResult[], query: string, sort: SearchSort): SearchResult[] {
  if (sort === 'recency')
    return results.sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.score - a.score)
  if (sort === 'match') {
    const terms = queryTerms(query)
    const m = (r: SearchResult): number => matchScore(`${r.title} ${r.snippet}`, terms)
    return results.sort((a, b) => m(b) - m(a) || b.score - a.score)
  }
  return results
}

/** The record kinds a source (surface) filter needs searched. */
function kindsForSources(sources: string[]): string[] {
  const kinds = new Set<string>()
  for (const source of sources) {
    for (const kind of SURFACE_KINDS[source.toLowerCase()] ?? ['screen']) kinds.add(kind)
  }
  return [...kinds]
}

// NOTE: artifacts are intentionally NOT in universal search yet — a hit can't be
// deep-linked (it carries no conversation context and there's no standalone
// artifact viewer), so clicking one used to jump to a meaningless Replay moment.
// Re-add an artifact source once artifacts have an openable target.

/** Universal search, for search boxes: every word must match as a word start, and a time phrase
 *  ranks items near it higher (a time phrase alone lists that window). `semantic` adds meaning
 *  search (slower first call: the index loads); without it (the command palette's type-ahead)
 *  only words match. `rerank` runs the cross-encoder over the best results. */
export async function universalSearch(
  query: string,
  opts: {
    limit?: number
    semantic?: boolean
    /** Cross-encoder over the head of the results; only where someone waits on the answer. */
    rerank?: boolean
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
  ensureRecordSchema()
  const q = query.trim()
  const limit = Math.min(MAX_RESULTS, Math.max(1, Math.floor(opts.limit ?? 30)))
  const sourceSet = opts.sources?.length
    ? new Set(opts.sources.map((source) => source.toLowerCase()))
    : null
  const kindSet = opts.kinds?.length ? new Set<string>(opts.kinds) : null
  const excluded = opts.excludeChatId ? `chat:${opts.excludeChatId}` : null
  const keep = (result: SearchResult): boolean =>
    (!sourceSet || sourceSet.has((result.surface || '').toLowerCase())) &&
    // A synced message is a screen moment that came from a connected account.
    (!kindSet ||
      kindSet.has(result.kind) ||
      (result.kind === 'message' && kindSet.has('screen'))) &&
    result.key !== excluded

  if (!q) {
    // No words yet: the newest of everything, so Search never opens on an empty page.
    return recentResults(limit, opts.sources).filter(keep).slice(0, limit)
  }

  // A source filter narrows the kinds searched; the engine leaves out what the filters do not keep
  // before it ranks, so the page needs no wider net.
  let kinds = opts.kinds?.length ? (opts.kinds as string[]) : undefined
  if (opts.sources?.length) {
    const fromSources = kindsForSources(opts.sources)
    kinds = kinds
      ? kinds.filter((kind) => fromSources.includes(kind === 'message' ? 'screen' : kind))
      : fromSources
    if (!kinds.length) return []
  }
  opts.signal?.throwIfAborted()
  const { timeOnly } = readSearchBox(q)
  const semantic = opts.semantic !== false
  const { hits } = await recordSearch(q, {
    limit: Math.min(MAX_RESULTS, limit + RESULT_MARGIN),
    semantic,
    rerank: opts.rerank === true,
    // Type-ahead keywords (AND, word starts); the palette also skips meaning search.
    ...(semantic ? { keywordTypeahead: true } : { typeahead: true }),
    timeMode: timeOnly ? 'filter' : 'boost',
    ...(kinds ? { kinds } : {}),
    collapseKey: screenMomentKey,
    ...(sourceSet || kindSet || excluded
      ? { exclude: (hit: RecordHit) => !keep(recordToSearchResult(hit)) }
      : {})
  })
  opts.signal?.throwIfAborted()
  const ordered = sortResults(hits.map(recordToSearchResult), q, opts.sort ?? 'relevance')
  if (!opts.collapseScreenMoments) return ordered.slice(0, limit)

  // Replay shows moments, not records: a moment's own frame and the moment collapse to one picture.
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
