// Pure search-ranking math, extracted so the ranking behaviour is unit-testable
// without the DB / Electron (mirrors model-sizing.ts). No imports, no side effects.
//
// These encode the search behaviours added this session:
//   1. Recency bias — recent hits float up (this week > last month > last quarter).
//   2. Own-content nudge — your deliberate chats / KB docs aren't buried under
//      thousands of ambient screen captures.
//   3. "Match" sort — rank by literal term overlap in title/snippet.

import type { SearchKind, SearchResult, SearchSort } from '../shared/search-contract'

export type { SearchKind, SearchResult, SearchSort } from '../shared/search-contract'

/** Recency boost added to a fused score. Tiered + sized to ~one rank of RRF, so a
 *  strong older match can still beat a weak recent one. No timestamp → 0. */
export function recencyBoost(ts: number, now: number): number {
  if (!ts) return 0
  const ageDays = (now - ts) / 86_400_000
  if (ageDays < 7) return 0.016
  if (ageDays < 30) return 0.009
  if (ageDays < 90) return 0.004
  return 0
}

/** Small visibility nudge for the user's own deliberate content (chats / KB docs). */
export function kindBoost(kind: string): number {
  return kind === 'chat' || kind === 'doc' ? 0.012 : 0
}

/** Literal term-overlap count in a haystack (for the "Match" sort). Case-insensitive. */
export function matchScore(haystack: string, terms: string[]): number {
  const hay = (haystack || '').toLowerCase()
  return terms.reduce((n, t) => n + (t ? hay.split(t).length - 1 : 0), 0)
}

// ---------------------------------------------------------------------------
// Query tokenisation + FTS expression (pure — no DB). One source of truth for
// how a free-text query splits into terms, shared by every LIKE/facet path.
// ---------------------------------------------------------------------------

/** Extract lowercased alphanumeric terms from a free-text query, capped at `max`.
 *  This is the single tokeniser used by every LIKE / facet source. */
export function queryTerms(query: string, max: number): string[] {
  return (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, max)
}

/** Sanitize a free-text query into an FTS5 MATCH expression: each token becomes a
 *  prefix-match term; punctuation is dropped so user input can't be a syntax error. */
export function ftsExpr(query: string): string {
  return queryTerms(query, 12)
    .map((t) => `"${t}"*`)
    .join(' ')
}

/**
 * SQL fragment converting a SQLite datetime column (stored as text) to epoch
 * milliseconds — `CAST(strftime('%s', <col>) AS INTEGER)*1000`. The idiom was
 * hand-written 6× across search.ts's SELECT lists; defined once here so a change
 * to the conversion is one edit. `col` is a caller-controlled column identifier
 * (never user input), safe to interpolate.
 */
export function epochMsSql(col: string): string {
  return `CAST(strftime('%s', ${col}) AS INTEGER)*1000`
}

/**
 * Column sets for the no-FTS LIKE search of each source. THE SINGLE SOURCE OF
 * TRUTH shared by the facet COUNT queries and the hit builders in search.ts — a
 * source's facet count used to be able to diverge from its results because the
 * WHERE clause was hand-written in both places. Add a column here and both update.
 */
export const LIKE_COLUMNS = {
  chat: ['rm.content', 'rc.title'],
  doc: ['c.content', 'd.name'],
  meeting: ['title', 'summary', 'transcript'],
  frame: ['text']
} as const

/**
 * Build the term-AND-ed LIKE WHERE fragment AND its bound params for a column set:
 * each term contributes one OR-group over the columns (`lower(col) LIKE ?`), the
 * groups AND-ed together; params are lowercased `%term%` wildcards, columns.length
 * per term. Returning both together guarantees the clause and the params always
 * agree in count — the facet counter and the hit query call this identically.
 */
export function likeMatch(
  columns: readonly string[],
  terms: string[]
): { where: string; args: string[] } {
  const perTerm = '(' + columns.map((c) => `lower(${c}) LIKE ?`).join(' OR ') + ')'
  return {
    where: terms.map(() => perTerm).join(' AND '),
    args: terms.flatMap((t) => columns.map(() => `%${t}%`))
  }
}

// ---------------------------------------------------------------------------
// Reciprocal-rank fusion + result assembly (pure — takes already-fetched hits)
// ---------------------------------------------------------------------------

/** A raw hit fetched from one source (FTS / LIKE / semantic), before fusion. */
export interface RawHit {
  key: string
  kind: SearchKind
  refId: number
  title: string
  snippet: string
  surface: string
  url: string | null
  ts: number
}

const RRF_K = 60
/** Reciprocal-rank-fusion weight for a 0-based rank. */
export function rrf(rank: number): number {
  return 1 / (RRF_K + rank)
}

/** Fuse ranked hit lists with reciprocal-rank fusion, de-duplicating by `key`.
 *  The first list a key appears in seeds its result shape (title/snippet/…);
 *  later appearances only add to its score. Snippet is capped at 280 chars. */
export function fuseHits(lists: RawHit[][]): Map<string, SearchResult> {
  const fused = new Map<string, SearchResult>()
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const existing = fused.get(hit.key)
      if (existing) {
        existing.score += rrf(rank)
        return
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
        score: rrf(rank)
      })
    })
  }
  return fused
}

/** Add the recency bias + own-content nudge to every fused result, in place. */
export function applyBoosts(results: Iterable<SearchResult>, now: number): void {
  for (const r of results) {
    r.score += recencyBoost(r.ts, now)
    r.score += kindBoost(r.kind)
  }
}

/** Filter + sort fused results into final ranked order. Pure: takes the fused
 *  results, applies the source / current-chat filters, then sorts by the chosen
 *  mode (relevance = blended score, recency = newest first, match = literal term
 *  overlap in title/snippet with score as tie-break). */
export function rankResults(
  results: SearchResult[],
  opts: {
    query: string
    sources?: string[]
    kinds?: SearchKind[]
    excludeChatId?: string
    sort?: SearchSort
  }
): SearchResult[] {
  const sourceSet = opts.sources?.length ? new Set(opts.sources.map((s) => s.toLowerCase())) : null
  const kindSet = opts.kinds?.length ? new Set(opts.kinds) : null
  let ordered = results
  if (sourceSet) ordered = ordered.filter((r) => sourceSet.has((r.surface || '').toLowerCase()))
  if (kindSet) ordered = ordered.filter((r) => kindSet.has(r.kind))
  // Don't let an answer cite the very conversation it's being asked in.
  if (opts.excludeChatId) ordered = ordered.filter((r) => r.key !== `chat:${opts.excludeChatId}`)
  const sort = opts.sort ?? 'relevance'
  if (sort === 'recency') {
    ordered.sort((a, b) => (b.ts || 0) - (a.ts || 0) || b.score - a.score)
  } else if (sort === 'match') {
    const terms = queryTerms(opts.query, Infinity)
    const m = (r: SearchResult): number => matchScore(`${r.title} ${r.snippet}`, terms)
    ordered.sort((a, b) => m(b) - m(a) || b.score - a.score)
  } else {
    ordered.sort((a, b) => b.score - a.score)
  }
  return ordered
}
