// Memory search on desktop: the shared records engine (@offgrid/rag/records RecordSearchService)
// over this app's stores - keyword sources in SQLite FTS5, record vectors in the encrypted
// database, the people a question names, the ms-marco cross-encoder and the record embedder.
// Universal search (search.ts) and the chat tools both search through recordSearch.

import {
  ftsTypeahead,
  parseTimeWindow,
  RecordSearchService,
  withoutTimePhrase,
  type QueryEmbedPort,
  type RecordHit,
  type RecordRerankPort,
  type RecordSearchOptions,
  type RecordSearchResult,
  type RecordSource
} from '@offgrid/rag/records'
import type { SearchKind, SearchResult } from '../../shared/search-contract'
import { embeddings } from '../embeddings'
import { RECORD_EMBEDDER } from '../embedding-models'
import { entityRecall } from './entities'
import { ensureRecordSchema } from './schema'
import { RECORD_SOURCES, type DesktopRecordHit } from './sources'
import { embedQueuedRecords, hasRecordVectors, recordVectors, recordVectorStatus } from './store'

export { ensureRecordSchema } from './schema'
export { releaseRecordIndex } from './store'
export {
  actionWhenSql,
  screenMomentKey,
  SYNCED_BULK_MAIL,
  visibleEntity,
  windowSql
} from './sources'
export type { DesktopRecordHit } from './sources'

/** The record kinds a search can be narrowed to. Search kinds map onto them ('message' is a
 *  screen moment from a connected account). */
const RECORD_KINDS = new Set(RECORD_SOURCES.map((source) => source.kind))

function recordKinds(kinds: readonly string[]): string[] {
  const out = new Set<string>()
  for (const kind of kinds) {
    const mapped = kind === 'message' ? 'screen' : kind
    if (RECORD_KINDS.has(mapped)) out.add(mapped)
  }
  return [...out]
}

const queryEmbedder: QueryEmbedPort = {
  async embedQuery(text) {
    // Someone is waiting on this one: it goes ahead of queued background indexing.
    const [vector] = await embeddings.embed([RECORD_EMBEDDER.queryPrefix + text], {
      model: RECORD_EMBEDDER.model,
      interactive: true,
      source: 'Memory search'
    })
    return vector ?? []
  }
}

/** The ms-marco cross-encoder the document engine reranks with. */
const recordReranker: RecordRerankPort = {
  rerank: (query, passages) => embeddings.rerank(query, passages)
}

let service: RecordSearchService | null = null

const deps = {
  vectors: recordVectors,
  embed: queryEmbedder,
  rerank: recordReranker,
  entities: entityRecall,
  onWarning: (message: string, error: unknown) => console.warn(`[records] ${message}`, error)
}

function recordService(): RecordSearchService {
  return (service ??= new RecordSearchService({ ...deps, sources: RECORD_SOURCES }))
}

/** A service whose keyword sources all search `match` (a search box's AND-of-word-starts) whatever
 *  the engine builds from the question; meaning search still reads the question. */
function keywordTypeaheadService(match: string): RecordSearchService {
  return new RecordSearchService({
    ...deps,
    sources: RECORD_SOURCES.map((source): RecordSource => ({
      ...source,
      keyword: (_match, window, limit) => source.keyword(match, window, limit)
    }))
  })
}

export interface DesktopRecordSearchOptions extends RecordSearchOptions {
  /**
   * The Search screen: keywords match the way a search box types (every word, each as a word
   * start: ftsTypeahead), while meaning search still runs. `typeahead` (the command palette) is
   * the same without meaning search.
   */
  keywordTypeahead?: boolean
}

/**
 * Search everything the user did or saw. `kinds` may use search kinds ('message' searches screen
 * moments); kinds with no records (attachments) match nothing. Meaning search is skipped while no
 * record has a vector yet (nothing to compare the question with).
 */
export async function recordSearch(
  question: string,
  options: DesktopRecordSearchOptions = {}
): Promise<RecordSearchResult> {
  ensureRecordSchema()
  const { keywordTypeahead, kinds, ...rest } = options
  const narrowed = kinds?.length ? recordKinds(kinds) : null
  if (narrowed && !narrowed.length) return { hits: [], window: null }
  const semantic = rest.semantic !== false && !rest.typeahead && hasRecordVectors()
  const search = { ...rest, semantic, ...(narrowed ? { kinds: narrowed } : {}) }
  if (keywordTypeahead && !rest.typeahead) {
    // The words the engine searches: the whole question when a time phrase only boosts.
    const words =
      rest.timeMode === 'boost' || rest.window === null
        ? question
        : withoutTimePhrase(question, rest.window ?? parseTimeWindow(question, rest.now))
    const match = ftsTypeahead(words)
    if (match) return keywordTypeaheadService(match).search(question, search)
  }
  return recordService().search(question, search)
}

/** A record as a universal-search result (the shape the renderer, citations and Sources use). */
export function recordToSearchResult(hit: RecordHit & { score?: number }): SearchResult {
  const desktop = hit as DesktopRecordHit & { score?: number }
  const kind = (desktop.synced ? 'message' : hit.kind) as SearchKind
  return {
    key: hit.key,
    kind,
    refId: typeof hit.refId === 'number' ? hit.refId : Number(hit.refId) || 0,
    title: hit.title || hit.kind,
    // A moment's card shows its summary; the on-screen words after it are for ranking.
    snippet: (hit.key.startsWith('obs:') ? (hit.text.split('\n', 1)[0] ?? '') : hit.text).slice(
      0,
      280
    ),
    surface: hit.surface ?? '',
    url: hit.url ?? null,
    ts: hit.ts || 0,
    imagePath: hit.imagePath ?? null,
    score: desktop.score ?? 0
  }
}

/** Stored record vectors (current embedder) and records waiting to be embedded. */
export function recordIndexStatus(): { vectors: number; pending: number } {
  ensureRecordSchema()
  return recordVectorStatus()
}

let draining = false

/** How long after a search the indexer waits before its next batch. */
const SEARCH_QUIET_MS = 3000

/**
 * Embed every queued record in the background, a batch at a time, and resolve when the queue is
 * empty (or stops moving). The embedder stays loaded for the whole drain.
 */
export async function embedRecordBacklog(
  onProgress?: (progress: { done: number; remaining: number }) => void
): Promise<void> {
  if (draining) return
  ensureRecordSchema()
  if (!recordVectorStatus().pending) return
  draining = true
  const release = embeddings.hold()
  try {
    let done = 0
    for (;;) {
      const batch = await embedQueuedRecords((texts) =>
        embeddings.embed(texts, { model: RECORD_EMBEDDER.model, source: 'Memory indexing' })
      )
      done += batch.embedded
      onProgress?.({ done, remaining: batch.remaining })
      if (batch.remaining === 0 || batch.processed === 0) break
      // Searches come first: wait until nobody has searched for a moment before the next batch.
      await embeddings.whenQuiet(SEARCH_QUIET_MS)
    }
  } finally {
    release()
    draining = false
  }
}
