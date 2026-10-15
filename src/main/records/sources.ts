// Where each kind of record lives, for the shared records engine: keyword search (FTS5, within a
// time window when the question names one), the newest records in a window, hydration of vector
// hits, and the text each record is embedded with. SQLite is the source of truth; a key that no
// longer has a row simply hydrates to nothing.
//
// Keys: obs:<observation> and frame:<frame> (screen), act:<action item>, mtg:<meeting>,
// ent:<entity>, sum:<chat summary rowid>, chat:<conversation id>, doc:<knowledge-base document>.
// The legacy memories and entity facts are retired: no source searches them and nothing embeds them.
//
// Text in scripts written without spaces (Chinese, Japanese, Thai…) is also searched through each
// index's trigram twin (`${fts}_tri`, database.ts): `trigram` on a source.

import {
  formatDay,
  fuseLists,
  type RecordHit,
  type RecordSource,
  type TimeWindow,
  type TrigramQuery
} from '@offgrid/rag/records'
import { getDB, tableExists } from '../database'

/** A desktop record: `synced` marks a screen moment made from a connected account (mail, chat). */
export interface DesktopRecordHit extends RecordHit {
  synced?: boolean
}

/** One moment, once: capture records the same screen again and again while it stays put, each with
 *  the same summary, and a result list showed dozens of identical cards. Screen moments with the same
 *  app and summary share this key (search results, the empty-query feed and the chat tools collapse
 *  on it); a synced message and every other record keep their own. */
export function screenMomentKey(hit: RecordHit): string {
  if (hit.kind !== 'screen' || (hit as DesktopRecordHit).synced) return hit.key
  const summary = (hit.text.split('\n', 1)[0] ?? '').trim()
  if (!summary) return hit.key
  return `screen\u0000${(hit.surface ?? '').toLowerCase()}\u0000${summary.toLowerCase()}`
}

type Db = ReturnType<typeof getDB>
type Row = Record<string, unknown>

/** How much of a moment's on-screen text joins its summary, in search and in its embedding. */
const EXCERPT_CHARS = 600
/** Longest text a record is embedded with (MiniLM reads about 256 tokens). */
const EMBED_CHARS = 2_000

/** Bulk mail synced from a connected account (newsletters, promotions) on observation `o`: the one
 *  predicate for leaving it out of counts and the feed, and for demoting it in results. */
export const SYNCED_BULK_MAIL = `(COALESCE(o.category, '') = 'consumption' AND o.source_key IS NOT NULL)`
/** Share of a bulk-mail result's score taken away: searchable, never favoured. */
const BULK_MAIL_PENALTY = 0.5

/** A SQLite datetime column as epoch ms. */
export const epochMs = (column: string): string =>
  `CAST(strftime('%s', ${column}) AS INTEGER) * 1000`
/** Same text as pro's idx_observations_ts_sec expression, so window reads use that index. */
const epochSec = (column: string): string => `CAST(strftime('%s', ${column}) AS INTEGER)`

/** `AND <column in window>` and its arguments: the one time-window rule for every store. `unit` is
 *  how the column stores time (SQLite datetime text, or epoch ms). */
export function windowSql(
  column: string,
  window: TimeWindow | null,
  unit: 'datetime' | 'ms'
): { sql: string; args: number[] } {
  if (!window) return { sql: '', args: [] }
  if (unit === 'ms')
    return { sql: ` AND ${column} >= ? AND ${column} < ?`, args: [window.start, window.end] }
  const expr = epochSec(column)
  return {
    sql: ` AND ${expr} >= ? AND ${expr} < ?`,
    args: [Math.floor(window.start / 1000), Math.ceil(window.end / 1000)]
  }
}

const columnsSeen = new WeakMap<object, Map<string, boolean>>()
/** Whether `table` has `column`. Pro adds some columns later, so only a yes is remembered. */
function hasColumn(db: Db, table: string, column: string): boolean {
  let seen = columnsSeen.get(db)
  if (!seen) columnsSeen.set(db, (seen = new Map()))
  const id = `${table}.${column}`
  if (seen.get(id)) return true
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (row) => row.name === column
  )
  if (has) seen.set(id, true)
  return has
}

/** The one hidden-entity rule: a SQL condition true for entities the user has not hidden.
 *  `entities.hidden` is a Pro column; without it nothing is hidden. */
export function visibleEntity(db: Db, alias: string): string {
  return hasColumn(db, 'entities', 'hidden') ? `${alias}.hidden = 0` : '1'
}

/** The absolute due instant (`due_at`, ms) when this profile has it. */
function dueAtSql(db: Db, alias: string): string {
  return hasColumn(db, 'action_items', 'due_at') ? `${alias}.due_at` : 'NULL'
}

const json = (values: unknown[]): string => JSON.stringify(values)
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value) || 0)

function keyParts(key: string): { prefix: string; id: string } {
  const at = key.indexOf(':')
  return { prefix: key.slice(0, at), id: key.slice(at + 1) }
}

/** The quoted terms of an FTS5 expression built by ftsQuery or ftsTypeahead, lower-case. */
function matchTerms(match: string): string[] {
  return [...match.matchAll(/"((?:[^"]|"")+)"/g)].map((m) =>
    m[1]!.replace(/""/g, '"').toLowerCase()
  )
}

/** The newest rows of a trigram twin a one- or two-character run is looked for in. */
const SHORT_RUN_SCAN = 5_000

/**
 * Rowids of `table` (as `s`) for a no-space-script question, from the trigram twin of `fts`: the
 * trigram MATCH (runs of three characters or more), best first, then the newest of the twin's rows
 * whose text holds a one- or two-character run, which no trigram can match. The twin holds only rows
 * in those scripts (its %_docsize shadow table lists them), so the scan never reads the rest.
 * `where` and `window` are extra conditions on `s`; `columns` the indexed columns.
 */
function trigramRowids(
  db: Db,
  options: {
    fts: string
    table: string
    columns: string[]
    where?: string
    window: { sql: string; args: number[] }
    query: TrigramQuery
    limit: number
  }
): number[][] {
  const { table, columns, window, query, limit } = options
  const tri = `${options.fts}_tri`
  if (!tableExists(db, tri)) return []
  const where = options.where ? ` AND ${options.where}` : ''
  const lists: number[][] = []
  if (query.match) {
    lists.push(
      (
        db
          .prepare(
            `SELECT s.rowid AS id FROM ${tri} JOIN ${table} s ON s.rowid = ${tri}.rowid
              WHERE ${tri} MATCH ?${where}${window.sql} ORDER BY bm25(${tri}) LIMIT ?`
          )
          .all(query.match, ...window.args, limit) as { id: number }[]
      ).map((row) => row.id)
    )
  }
  if (query.short.length) {
    const contains = query.short
      .flatMap(() => columns.map((column) => `instr(offgrid_fts_text(s.${column}), ?) > 0`))
      .join(' OR ')
    lists.push(
      (
        db
          .prepare(
            `SELECT s.rowid AS id
               FROM (SELECT id FROM ${tri}_docsize ORDER BY id DESC LIMIT ${SHORT_RUN_SCAN}) d
               JOIN ${table} s ON s.rowid = d.id
              WHERE (${contains})${where}${window.sql}
              ORDER BY d.id DESC LIMIT ?`
          )
          .all(
            ...query.short.flatMap((run) => columns.map(() => run)),
            ...window.args,
            limit
          ) as { id: number }[]
      ).map((row) => row.id)
    )
  }
  return lists
}

/** Lists of keys fused into one, best first. */
function fuseKeys(lists: string[][], limit: number): string[] {
  return fuseLists(
    lists.map((items) => ({ items })),
    (key) => key
  )
    .slice(0, limit)
    .map((entry) => entry.item)
}

// ---------------------------------------------------------------------------------------------
// Screen moments
// ---------------------------------------------------------------------------------------------

/** Frames read per moment for its excerpt; a moment that stayed on screen can have dozens. */
const EXCERPT_FRAMES = 4

/** The distinct lines of a moment's on-screen text (its first frames), up to `max` chars. */
function frameExcerpts(db: Db, observationIds: number[], max = EXCERPT_CHARS): Map<number, string> {
  const out = new Map<number, string>()
  if (!observationIds.length || !tableExists(db, 'observation_frames')) return out
  const rows = db
    .prepare(
      `SELECT id, text FROM (
         SELECT of.observation_id AS id, substr(f.text, 1, 4000) AS text,
                ROW_NUMBER() OVER (PARTITION BY of.observation_id ORDER BY f.id) AS n
           FROM observation_frames of JOIN frames f ON f.id = of.frame_id
          WHERE of.observation_id IN (SELECT value FROM json_each(?))
            AND f.text IS NOT NULL AND COALESCE(f.source, '') != 'connector')
        WHERE n <= ${EXCERPT_FRAMES} ORDER BY id, n`
    )
    .all(json(observationIds)) as { id: number; text: string }[]
  const seen = new Map<number, Set<string>>()
  for (const row of rows) {
    let lines = seen.get(row.id)
    if (!lines) seen.set(row.id, (lines = new Set()))
    let excerpt = out.get(row.id) ?? ''
    for (const raw of row.text.split(/\n+/)) {
      if (excerpt.length >= max) break
      const line = raw.replace(/\s+/g, ' ').trim()
      const id = line.toLowerCase()
      if (line.length < 3 || lines.has(id)) continue
      lines.add(id)
      excerpt = excerpt ? `${excerpt} · ${line}` : line
    }
    out.set(row.id, excerpt.slice(0, max))
  }
  return out
}

function hydrateObservations(
  db: Db,
  ids: number[],
  matched: Map<number, string>
): DesktopRecordHit[] {
  if (!ids.length || !tableExists(db, 'observations')) return []
  const rows = db
    .prepare(
      `SELECT o.id, o.summary, COALESCE(o.surface, '') AS surface, o.url, ${epochMs('o.ts')} AS ts,
              CASE WHEN o.salience > 0 THEN o.salience ELSE 0.5 END AS evidence,
              ${SYNCED_BULK_MAIL} AS bulk,
              (SELECT f.image_path FROM observation_frames of JOIN frames f ON f.id = of.frame_id
                WHERE of.observation_id = o.id AND f.image_path IS NOT NULL
                ORDER BY f.id LIMIT 1) AS imagePath,
              EXISTS (SELECT 1 FROM observation_frames of JOIN frames f ON f.id = of.frame_id
                WHERE of.observation_id = o.id AND f.source = 'connector') AS synced
         FROM observations o WHERE o.id IN (SELECT value FROM json_each(?))`
    )
    .all(json(ids)) as Row[]
  const excerpts = frameExcerpts(db, ids)
  return rows.map((row) => {
    const id = num(row.id)
    const synced = !!row.synced
    const body = [matched.get(id), excerpts.get(id)].filter(Boolean).join(' · ')
    return {
      key: `obs:${id}`,
      kind: 'screen',
      refId: id,
      title: text(row.surface) || 'Screen',
      text: body ? `${text(row.summary)}\n${body.slice(0, EXCERPT_CHARS)}` : text(row.summary),
      ts: num(row.ts),
      surface: text(row.surface),
      url: text(row.url) || null,
      // A synced message has no screenshot.
      imagePath: synced ? null : text(row.imagePath) || null,
      evidence: num(row.evidence),
      ...(row.bulk ? { penalty: BULK_MAIL_PENALTY } : {}),
      synced
    }
  })
}

function hydrateFrames(db: Db, ids: number[]): DesktopRecordHit[] {
  if (!ids.length || !tableExists(db, 'frames')) return []
  return (
    db
      .prepare(
        `SELECT id, COALESCE(surface, '') AS surface, url, image_path AS imagePath,
                substr(text, 1, ${EXCERPT_CHARS}) AS text, ${epochMs('ts')} AS ts
           FROM frames WHERE id IN (SELECT value FROM json_each(?))`
      )
      .all(json(ids)) as Row[]
  ).map((row) => ({
    key: `frame:${num(row.id)}`,
    kind: 'screen',
    refId: num(row.id),
    title: text(row.surface) || 'Screen',
    text: text(row.text),
    ts: num(row.ts),
    surface: text(row.surface),
    url: text(row.url) || null,
    imagePath: text(row.imagePath) || null
  }))
}

/** Screen moments: their summaries (observation_fts) and every word on screen (frame_fts). A frame
 *  that belongs to a moment counts for that moment; a frame of its own is a hit with its picture. */
const screenSource: RecordSource = {
  kind: 'screen',
  decays: true,
  keyword(match, window, limit) {
    const db = getDB()
    const lists: string[][] = []
    const matched = new Map<number, string>()
    if (tableExists(db, 'observation_fts')) {
      const w = windowSql('o.ts', window, 'datetime')
      lists.push(
        (
          db
            .prepare(
              `SELECT o.id FROM observation_fts f JOIN observations o ON o.id = f.rowid
                WHERE observation_fts MATCH ?${w.sql} ORDER BY bm25(observation_fts) LIMIT ?`
            )
            .all(match, ...w.args, limit) as { id: number }[]
        ).map((row) => `obs:${row.id}`)
      )
    }
    // Raw screen text is the largest index by far (tens of millions of frames). Scoring every frame
    // a common word or short prefix matches took seconds, so frame hits are the NEWEST matches — an
    // index walk, no scoring (screenpipe orders screen text by time the same way); relevance comes
    // from the moment summaries above and from meaning search. A one- or two-letter prefix is too
    // broad to read raw screen text at all.
    const tooBroad = /^("[^"]{1,2}"\*(\s+AND\s+|$))+$/u.test(match)
    if (!tooBroad && tableExists(db, 'frame_fts')) {
      const w = windowSql('fr.ts', window, 'datetime')
      const frames = db
        .prepare(
          `SELECT fr.id, substr(fr.text, 1, 300) AS text,
                  (SELECT of.observation_id FROM observation_frames of WHERE of.frame_id = fr.id
                    LIMIT 1) AS observationId
             FROM frame_fts x JOIN frames fr ON fr.id = x.rowid
            WHERE frame_fts MATCH ?${w.sql}
            ORDER BY x.rowid DESC LIMIT ?`
        )
        .all(match, ...w.args, limit) as {
        id: number
        text: string
        observationId: number | null
      }[]
      lists.push(
        frames.map((frame) => {
          if (frame.observationId == null) return `frame:${frame.id}`
          if (!matched.has(frame.observationId))
            matched.set(frame.observationId, frame.text.replace(/\s+/g, ' ').trim())
          return `obs:${frame.observationId}`
        })
      )
    }
    return hydrateInOrder(db, fuseKeys(lists, limit), matched)
  },
  // Moment summaries only: frame_fts has no trigram twin (see database.ts).
  trigram(query, window, limit) {
    const db = getDB()
    const lists = trigramRowids(db, {
      fts: 'observation_fts',
      table: 'observations',
      columns: ['summary'],
      window: windowSql('s.ts', window, 'datetime'),
      query,
      limit
    })
    return hydrateInOrder(
      db,
      fuseKeys(
        lists.map((ids) => ids.map((id) => `obs:${id}`)),
        limit
      )
    )
  },
  recent(window, limit) {
    const db = getDB()
    if (!tableExists(db, 'observations')) return []
    const w = windowSql('o.ts', window, 'datetime')
    const ids = (
      db
        .prepare(
          `SELECT o.id FROM observations o
            WHERE o.summary IS NOT NULL AND o.summary != '' AND NOT ${SYNCED_BULK_MAIL}${w.sql}
            ORDER BY ${epochSec('o.ts')} DESC LIMIT ?`
        )
        .all(...w.args, limit) as { id: number }[]
    ).map((row) => `obs:${row.id}`)
    return hydrateInOrder(db, ids)
  }
}

// ---------------------------------------------------------------------------------------------
// Actions, meetings, people, summaries
// ---------------------------------------------------------------------------------------------

/** When a to-do came from, in ms: `source_ts` is epoch seconds for captured sources and ms for
 *  manual jots (pro action-schema actionSourceMs); `created_at` (ms) stands in when there is none.
 *  `alias` is the action_items alias (none in an index expression). */
export function actionWhenSql(alias = ''): string {
  const column = (name: string): string => (alias ? `${alias}.${name}` : name)
  const source = column('source_ts')
  return `(CASE WHEN ${source} IS NULL OR ${source} <= 0 THEN ${column('created_at')} WHEN ${source} > 1000000000000 THEN ${source} ELSE ${source} * 1000 END)`
}

const ACTION_WHEN = actionWhenSql('a')

function hydrateActions(db: Db, ids: number[]): DesktopRecordHit[] {
  if (!ids.length || !tableExists(db, 'action_items')) return []
  return (
    db
      .prepare(
        `SELECT a.id, a.text, a.due, ${dueAtSql(db, 'a')} AS dueAt, a.status,
                a.entity_name AS entityName, a.confidence, ${ACTION_WHEN} AS ts
           FROM action_items a
          WHERE a.id IN (SELECT value FROM json_each(?)) AND a.status != 'dismissed'`
      )
      .all(json(ids)) as Row[]
  ).map((row) => {
    const status = text(row.status)
    const label = status === 'done' ? 'Done' : status === 'suggested' ? 'Suggested to-do' : 'To-do'
    return {
      key: `act:${num(row.id)}`,
      kind: 'action',
      refId: num(row.id),
      title: row.entityName ? `${label} · ${text(row.entityName)}` : label,
      text: actionText(row),
      ts: num(row.ts),
      surface: 'To-do',
      url: null,
      evidence: row.confidence == null ? 0.5 : num(row.confidence)
    }
  })
}

/** A to-do with its due date: the absolute day when it was resolved, else the words as said. */
function actionText(row: Row): string {
  const due = row.dueAt ? formatDay(num(row.dueAt)) : text(row.due)
  return `${text(row.text)}${due ? ` (due ${due})` : ''}`
}

function hydrateMeetings(db: Db, ids: number[]): DesktopRecordHit[] {
  if (!ids.length || !tableExists(db, 'meetings')) return []
  return (
    db
      .prepare(
        `SELECT id, COALESCE(title, 'Meeting') AS title,
                COALESCE(summary, substr(transcript, 1, ${EXCERPT_CHARS}), '') AS text,
                COALESCE(started_at, created_at, 0) AS ts
           FROM meetings WHERE id IN (SELECT value FROM json_each(?))`
      )
      .all(json(ids)) as Row[]
  ).map((row) => ({
    key: `mtg:${num(row.id)}`,
    kind: 'meeting',
    refId: num(row.id),
    title: text(row.title),
    text: text(row.text),
    ts: num(row.ts),
    surface: 'Meeting',
    url: null
  }))
}

function hydrateEntities(db: Db, ids: number[]): DesktopRecordHit[] {
  if (!ids.length) return []
  return (
    db
      .prepare(
        `SELECT e.id, e.name, e.type, e.summary, ${epochMs('e.updated_at')} AS ts
           FROM entities e
          WHERE e.id IN (SELECT value FROM json_each(?)) AND ${visibleEntity(db, 'e')}`
      )
      .all(json(ids)) as Row[]
  ).map((row) => ({
    key: `ent:${num(row.id)}`,
    kind: 'entity',
    refId: num(row.id),
    title: text(row.name),
    text: entityText(row),
    ts: num(row.ts),
    surface: 'Entity',
    url: null
  }))
}

function entityText(row: Row): string {
  return `${text(row.name)} (${text(row.type) || 'Unknown'})${row.summary ? `: ${text(row.summary)}` : ''}`
}

function hydrateSummaries(db: Db, ids: number[]): DesktopRecordHit[] {
  if (!ids.length) return []
  return (
    db
      .prepare(
        `SELECT rowid AS id, session_id AS sessionId, summary, ${epochMs('updated_at')} AS ts
           FROM chat_summaries WHERE rowid IN (SELECT value FROM json_each(?))`
      )
      .all(json(ids)) as Row[]
  ).map((row) => ({
    key: `sum:${num(row.id)}`,
    kind: 'summary',
    refId: num(row.id),
    title: 'Chat summary',
    text: text(row.summary),
    ts: num(row.ts),
    surface: 'Chat summary',
    // The chat it summarises.
    url: text(row.sessionId) || null
  }))
}

const HYDRATORS: Record<
  string,
  (db: Db, ids: number[], matched: Map<number, string>) => DesktopRecordHit[]
> = {
  obs: hydrateObservations,
  frame: hydrateFrames,
  act: hydrateActions,
  mtg: hydrateMeetings,
  ent: hydrateEntities,
  sum: hydrateSummaries
}

/**
 * Records for keys, in the keys' order. A key whose row is gone (or hidden, or dismissed) is left
 * out. `matched` adds the on-screen words a frame search found to that moment's text.
 */
export function hydrateRecords(
  keys: string[],
  matched = new Map<number, string>()
): DesktopRecordHit[] {
  return hydrateInOrder(getDB(), keys, matched)
}

function hydrateInOrder(
  db: Db,
  keys: string[],
  matched = new Map<number, string>()
): DesktopRecordHit[] {
  const byPrefix = new Map<string, number[]>()
  for (const key of keys) {
    const { prefix, id } = keyParts(key)
    if (!HYDRATORS[prefix]) continue
    const ids = byPrefix.get(prefix) ?? []
    ids.push(Number(id))
    byPrefix.set(prefix, ids)
  }
  const found = new Map<string, DesktopRecordHit>()
  for (const [prefix, ids] of byPrefix) {
    for (const hit of HYDRATORS[prefix]!(db, ids, matched)) found.set(hit.key, hit)
  }
  return keys.map((key) => found.get(key)).filter((hit): hit is DesktopRecordHit => !!hit)
}

/** A keyword source over one FTS5 table whose rowid is the record's id, and its trigram twin. */
function ftsSource(options: {
  kind: string
  decays: boolean
  prefix: string
  fts: string
  /** Joined as `s`; `when` reads its time. */
  table: string
  /** The indexed columns of `table`. */
  columns: string[]
  when: { column: string; unit: 'datetime' | 'ms' }
  /** Extra WHERE conditions on `s`. */
  where?: (db: Db) => string
}): RecordSource {
  const { kind, decays, prefix, fts, table, columns, when } = options
  return {
    kind,
    decays,
    trigram(query, window, limit) {
      const db = getDB()
      const lists = trigramRowids(db, {
        fts,
        table,
        columns,
        ...(options.where ? { where: options.where(db) } : {}),
        window: windowSql(when.column, window, when.unit),
        query,
        limit
      })
      return hydrateInOrder(
        db,
        fuseKeys(
          lists.map((ids) => ids.map((id) => `${prefix}:${id}`)),
          limit
        )
      )
    },
    keyword(match, window, limit) {
      const db = getDB()
      if (!tableExists(db, fts)) return []
      const w = windowSql(when.column, window, when.unit)
      const ids = db
        .prepare(
          `SELECT s.rowid AS id FROM ${fts} JOIN ${table} s ON s.rowid = ${fts}.rowid
            WHERE ${fts} MATCH ?${options.where ? ` AND ${options.where(db)}` : ''}${w.sql}
            ORDER BY bm25(${fts}) LIMIT ?`
        )
        .all(match, ...w.args, limit) as { id: number }[]
      return hydrateInOrder(
        db,
        ids.map((row) => `${prefix}:${row.id}`)
      )
    }
  }
}

const actionSource: RecordSource = {
  ...ftsSource({
    kind: 'action',
    decays: false,
    prefix: 'act',
    fts: 'action_fts',
    table: 'action_items',
    columns: ['text', 'raw_text'],
    when: { column: actionWhenSql('s'), unit: 'ms' },
    where: () => "s.status != 'dismissed'"
  }),
  recent(window, limit) {
    const db = getDB()
    if (!tableExists(db, 'action_items')) return []
    const ids = db
      .prepare(
        `SELECT a.id FROM action_items a
          WHERE a.status != 'dismissed' AND ${ACTION_WHEN} >= ? AND ${ACTION_WHEN} < ?
          ORDER BY ${ACTION_WHEN} DESC LIMIT ?`
      )
      .all(window.start, window.end, limit) as { id: number }[]
    return hydrateInOrder(
      db,
      ids.map((row) => `act:${row.id}`)
    )
  }
}

const meetingSource: RecordSource = {
  ...ftsSource({
    kind: 'meeting',
    decays: false,
    prefix: 'mtg',
    fts: 'meeting_fts',
    table: 'meetings',
    columns: ['title', 'summary'],
    when: { column: 'COALESCE(s.started_at, s.created_at)', unit: 'ms' }
  }),
  recent(window, limit) {
    const db = getDB()
    if (!tableExists(db, 'meetings')) return []
    const ids = db
      .prepare(
        `SELECT id FROM meetings WHERE started_at >= ? AND started_at < ?
          ORDER BY started_at DESC LIMIT ?`
      )
      .all(window.start, window.end, limit) as { id: number }[]
    return hydrateInOrder(
      db,
      ids.map((row) => `mtg:${row.id}`)
    )
  }
}

const entitySource: RecordSource = ftsSource({
  kind: 'entity',
  decays: false,
  prefix: 'ent',
  fts: 'entity_fts',
  table: 'entities',
  columns: ['name', 'summary', 'type'],
  when: { column: 's.updated_at', unit: 'datetime' },
  where: (db) => visibleEntity(db, 's')
})

const summarySource: RecordSource = ftsSource({
  kind: 'summary',
  decays: true,
  prefix: 'sum',
  fts: 'summary_fts',
  table: 'chat_summaries',
  columns: ['summary'],
  when: { column: 's.updated_at', unit: 'datetime' }
})

// ---------------------------------------------------------------------------------------------
// Chats and knowledge bases (keyword only)
// ---------------------------------------------------------------------------------------------

function chatHit(row: Row): DesktopRecordHit {
  const id = text(row.id)
  return {
    key: `chat:${id}`,
    kind: 'chat',
    refId: 0,
    title: text(row.title) || 'Chat',
    text: text(row.text),
    ts: num(row.ts),
    surface: 'Chat',
    // The conversation to open.
    url: id
  }
}

/** Chat hits for messages, best first: one per conversation, its first message in `ids`. */
function chatHitsForMessages(db: Db, ids: number[], limit: number): DesktopRecordHit[] {
  if (!ids.length) return []
  const rows = new Map(
    (
      db
        .prepare(
          `SELECT m.id AS mid, m.conversation_id AS id, rc.title,
                  substr(m.content, 1, ${EXCERPT_CHARS}) AS text, ${epochMs('m.created_at')} AS ts
             FROM rag_messages m JOIN rag_conversations rc ON rc.id = m.conversation_id
            WHERE m.id IN (SELECT value FROM json_each(?))`
        )
        .all(json(ids)) as Row[]
    ).map((row) => [num(row.mid), row])
  )
  const seen = new Set<string>()
  const hits: DesktopRecordHit[] = []
  for (const id of ids) {
    const row = rows.get(id)
    if (!row || seen.has(text(row.id))) continue
    seen.add(text(row.id))
    hits.push(chatHit(row))
    if (hits.length === limit) break
  }
  return hits
}

/** Your chats: one hit per conversation, its best-matching message (rag_message_fts), plus chats
 *  whose title has the words. The conversation id is the hit's url. */
const chatSource: RecordSource = {
  kind: 'chat',
  decays: true,
  trigram(query, window, limit) {
    const db = getDB()
    // Titles are matched by the keyword list (a substring test on each quoted term).
    const lists = trigramRowids(db, {
      fts: 'rag_message_fts',
      table: 'rag_messages',
      columns: ['content'],
      window: windowSql('s.created_at', window, 'datetime'),
      query,
      limit: limit * 10
    })
    return fuseLists(
      lists.map((ids) => ({ items: chatHitsForMessages(db, ids, limit) })),
      (hit) => hit.key
    )
      .slice(0, limit)
      .map((entry) => entry.item)
  },
  keyword(match, window, limit) {
    const db = getDB()
    const w = windowSql('m.created_at', window, 'datetime')
    const byContent = db
      .prepare(
        `SELECT best.conversation_id AS id, rc.title, substr(m.content, 1, ${EXCERPT_CHARS}) AS text,
                ${epochMs('m.created_at')} AS ts
           FROM (SELECT conversation_id, mid, MIN(score) AS score
                   FROM (SELECT rag_message_fts.rowid AS mid, rag_message_fts.conversation_id,
                                rag_message_fts.rank AS score
                           FROM rag_message_fts JOIN rag_messages m ON m.id = rag_message_fts.rowid
                          WHERE rag_message_fts MATCH ?${w.sql}
                          ORDER BY rag_message_fts.rank LIMIT ?)
                  GROUP BY conversation_id) best
           JOIN rag_conversations rc ON rc.id = best.conversation_id
           JOIN rag_messages m ON m.id = best.mid
          ORDER BY best.score LIMIT ?`
      )
      .all(match, ...w.args, limit * 10, limit) as Row[]
    const terms = matchTerms(match)
    // A search box's expression needs every word (AND); a question's, any of them.
    const join = / AND /.test(match) ? ' AND ' : ' OR '
    const tw = windowSql('rc.updated_at', window, 'datetime')
    const byTitle = terms.length
      ? (db
          .prepare(
            `SELECT rc.id, rc.title,
                    COALESCE((SELECT substr(content, 1, ${EXCERPT_CHARS}) FROM rag_messages
                               WHERE conversation_id = rc.id ORDER BY id DESC LIMIT 1), '') AS text,
                    ${epochMs('rc.updated_at')} AS ts
               FROM rag_conversations rc
              WHERE (${terms.map(() => "instr(lower(COALESCE(rc.title, '')), ?) > 0").join(join)})${tw.sql}
              ORDER BY (${terms.map(() => "(instr(lower(COALESCE(rc.title, '')), ?) > 0)").join(' + ')}) DESC,
                       rc.updated_at DESC
              LIMIT ?`
          )
          .all(...terms, ...tw.args, ...terms, limit) as Row[])
      : []
    return fuseLists(
      [{ items: byContent.map(chatHit) }, { items: byTitle.map(chatHit) }],
      (hit) => hit.key
    )
      .slice(0, limit)
      .map((entry) => entry.item)
  },
  recent(window, limit) {
    const w = windowSql('rc.updated_at', window, 'datetime')
    return (
      getDB()
        .prepare(
          `SELECT rc.id, rc.title,
                  COALESCE((SELECT substr(content, 1, ${EXCERPT_CHARS}) FROM rag_messages
                             WHERE conversation_id = rc.id ORDER BY id DESC LIMIT 1), '') AS text,
                  ${epochMs('rc.updated_at')} AS ts
             FROM rag_conversations rc WHERE 1 = 1${w.sql}
            ORDER BY rc.updated_at DESC LIMIT ?`
        )
        .all(...w.args, limit) as Row[]
    ).map(chatHit)
  }
}

/** Project knowledge-base documents: the document index's keyword search (bm25), best passage per
 *  file, and the newest files in a window. The owning project id is the hit's url. */
function docHit(row: Row): DesktopRecordHit {
  const id = num(row.id)
  return {
    key: `doc:${id}`,
    kind: 'doc',
    refId: id,
    title: text(row.name),
    text: text(row.text),
    ts: num(row.ts),
    surface: 'Knowledge base',
    url: text(row.projectId) || null
  }
}

/**
 * Knowledge-base documents for passages, best first: one hit per file, its best passage. `passages`
 * is a subquery of (document_id, position, rank), lowest rank best; `args` are its arguments.
 */
function docHitsForPassages(
  db: Db,
  passages: string,
  args: unknown[],
  window: TimeWindow | null,
  limit: number
): DesktopRecordHit[] {
  const w = windowSql('d.created_at', window, 'datetime')
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.project_id AS projectId, substr(c.text, 1, ${EXCERPT_CHARS}) AS text,
              ${epochMs('d.created_at')} AS ts
         FROM (${passages}) f
         JOIN rag_documents d ON d.document_id = f.document_id
         JOIN attached_document_chunks c ON c.document_id = f.document_id AND c.position = f.position
        WHERE 1 = 1${w.sql}
        ORDER BY f.rank`
    )
    .all(...args, ...w.args) as Row[]
  const seen = new Set<number>()
  const hits: DesktopRecordHit[] = []
  for (const row of rows) {
    const id = num(row.id)
    if (seen.has(id)) continue
    seen.add(id)
    hits.push(docHit(row))
    if (hits.length === limit) break
  }
  return hits
}

const DOC_TRIGRAM = 'attached_document_fts_tri'

const docSource: RecordSource = {
  kind: 'doc',
  decays: false,
  keyword(match, window, limit) {
    const db = getDB()
    if (!tableExists(db, 'attached_document_fts') || !tableExists(db, 'rag_documents')) return []
    return docHitsForPassages(
      db,
      `SELECT document_id, position, bm25(attached_document_fts) AS rank
         FROM attached_document_fts WHERE attached_document_fts MATCH ?
        ORDER BY rank LIMIT ?`,
      [match, limit * 20],
      window,
      limit
    )
  },
  // The passage index's trigram twin holds its own copy of each passage in a no-space script.
  trigram(query, window, limit) {
    const db = getDB()
    if (!tableExists(db, DOC_TRIGRAM) || !tableExists(db, 'rag_documents')) return []
    const lists: DesktopRecordHit[][] = []
    if (query.match)
      lists.push(
        docHitsForPassages(
          db,
          `SELECT document_id, position, bm25(${DOC_TRIGRAM}) AS rank
             FROM ${DOC_TRIGRAM} WHERE ${DOC_TRIGRAM} MATCH ?
            ORDER BY rank LIMIT ?`,
          [query.match, limit * 20],
          window,
          limit
        )
      )
    if (query.short.length)
      lists.push(
        docHitsForPassages(
          db,
          `SELECT document_id, position, -rowid AS rank
             FROM (SELECT rowid, document_id, position, body FROM ${DOC_TRIGRAM}
                    ORDER BY rowid DESC LIMIT ${SHORT_RUN_SCAN})
            WHERE ${query.short.map(() => 'instr(body, ?) > 0').join(' OR ')}
            LIMIT ?`,
          [...query.short, limit * 20],
          window,
          limit
        )
      )
    return fuseLists(
      lists.map((items) => ({ items })),
      (hit) => hit.key
    )
      .slice(0, limit)
      .map((entry) => entry.item)
  },
  recent(window, limit) {
    const db = getDB()
    if (!tableExists(db, 'rag_documents')) return []
    const w = windowSql('d.created_at', window, 'datetime')
    return (
      db
        .prepare(
          `SELECT d.id, d.name, d.project_id AS projectId, ${epochMs('d.created_at')} AS ts,
                  COALESCE((SELECT substr(c.text, 1, ${EXCERPT_CHARS}) FROM attached_document_chunks c
                             WHERE c.document_id = d.document_id ORDER BY c.position LIMIT 1), '') AS text
             FROM rag_documents d WHERE 1 = 1${w.sql}
            ORDER BY d.created_at DESC LIMIT ?`
        )
        .all(...w.args, limit) as Row[]
    ).map(docHit)
  }
}

/** Every keyword source, in no particular order (the engine fuses them with equal votes). */
export const RECORD_SOURCES: RecordSource[] = [
  screenSource,
  actionSource,
  meetingSource,
  entitySource,
  summarySource,
  chatSource,
  docSource
]

// ---------------------------------------------------------------------------------------------
// What each record is embedded with
// ---------------------------------------------------------------------------------------------

export interface EmbeddableRecord {
  kind: string
  refId: string
  ts: number
  text: string
}

function rowsFor(db: Db, table: string, sql: string, ids: number[]): Row[] {
  if (!ids.length || !tableExists(db, table)) return []
  return db.prepare(sql).all(json(ids)) as Row[]
}

/**
 * The text each key is embedded with, and its kind and time. Keys whose row is gone are absent.
 * A moment is its summary plus a de-duplicated excerpt of its frames' words (no raw frame is
 * embedded on its own); a person is their name, type and summary; a to-do is its text and due date;
 * a meeting is its title and summary.
 */
export function embeddableRecords(keys: string[]): Map<string, EmbeddableRecord> {
  const db = getDB()
  const byPrefix = new Map<string, number[]>()
  for (const key of keys) {
    const { prefix, id } = keyParts(key)
    const ids = byPrefix.get(prefix) ?? []
    ids.push(Number(id))
    byPrefix.set(prefix, ids)
  }
  const out = new Map<string, EmbeddableRecord>()
  const put = (prefix: string, kind: string, row: Row, body: string): void => {
    out.set(`${prefix}:${num(row.id)}`, {
      kind,
      refId: String(num(row.id)),
      ts: num(row.ts),
      text: body.replace(/\s+/g, ' ').trim().slice(0, EMBED_CHARS)
    })
  }
  const obsIds = byPrefix.get('obs') ?? []
  const excerpts = frameExcerpts(db, obsIds)
  for (const row of rowsFor(
    db,
    'observations',
    `SELECT id, summary, ${epochMs('ts')} AS ts FROM observations
      WHERE id IN (SELECT value FROM json_each(?))`,
    obsIds
  ))
    put('obs', 'screen', row, `${text(row.summary)}\n${excerpts.get(num(row.id)) ?? ''}`)
  for (const row of rowsFor(
    db,
    'action_items',
    `SELECT a.id, a.text, a.due, ${dueAtSql(db, 'a')} AS dueAt, ${ACTION_WHEN} AS ts
       FROM action_items a
      WHERE a.id IN (SELECT value FROM json_each(?))`,
    byPrefix.get('act') ?? []
  ))
    put('act', 'action', row, actionText(row))
  for (const row of rowsFor(
    db,
    'meetings',
    `SELECT id, title, summary, COALESCE(started_at, created_at, 0) AS ts FROM meetings
      WHERE id IN (SELECT value FROM json_each(?))`,
    byPrefix.get('mtg') ?? []
  ))
    put('mtg', 'meeting', row, [text(row.title), text(row.summary)].filter(Boolean).join('. '))
  for (const row of rowsFor(
    db,
    'entities',
    `SELECT id, name, type, summary, ${epochMs('updated_at')} AS ts FROM entities
      WHERE id IN (SELECT value FROM json_each(?))`,
    byPrefix.get('ent') ?? []
  ))
    put('ent', 'entity', row, entityText(row))
  for (const row of rowsFor(
    db,
    'chat_summaries',
    `SELECT rowid AS id, summary, ${epochMs('updated_at')} AS ts FROM chat_summaries
      WHERE rowid IN (SELECT value FROM json_each(?))`,
    byPrefix.get('sum') ?? []
  ))
    put('sum', 'summary', row, text(row.summary))
  return out
}
