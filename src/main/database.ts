import { settingsChanged } from './settings-version'
import { selectedVersionRepairs, type StoredVersionRow } from '../shared/chat-versions'
// better-sqlite3-multiple-ciphers is a drop-in superset of better-sqlite3 that
// adds SQLCipher-style `PRAGMA key` encryption. Same API surface + types.
import Database from 'better-sqlite3-multiple-ciphers'
import { safeStorage } from 'electron'
import path from 'path'
import {
  FTS_SCHEMA_VERSION,
  FTS_TOKENIZE,
  FTS_TRIGRAM_TOKENIZE,
  ftsQuery,
  ftsTypeahead,
  needsTrigram,
  normaliseForIndex
} from '@offgrid/rag/records'
import { dataDir } from './runtime-env'
import fs from 'fs'
import crypto from 'crypto'
import { createSettingsStore, initializeSettingsStore } from './settings-store'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'
import type {
  ConversationSurface,
  RagConversationContract,
  RagMessageContract,
  UserProfileContract
} from '../shared/ipc-contracts'

/** Conversation-list page size when a caller does not ask for one, and the ceiling it may ask for. */
const DEFAULT_CONVERSATION_PAGE = 500
const MAX_CONVERSATION_PAGE = 2_000
/** Content-search result cap. Bounded because the caller renders a list, not a report. */
const DEFAULT_SEARCH_LIMIT = 200
const MAX_SEARCH_LIMIT = 1_000

let db: Database.Database | null = null

// --- Encryption at rest (new DBs only) -------------------------------------
// The DB key can't live inside the DB (it gates opening it), so it's stored as a
// safeStorage-encrypted file alongside it. Policy:
//   • .dbkey present            → encrypted DB (created by us) → open with the key
//   • no .dbkey, DB file exists → legacy plaintext DB → open as-is (NO migration)
//   • neither                   → fresh install → generate a key + create encrypted
// If the OS can't provide real encryption (no Keychain), we fall back to plaintext
// so the app still works rather than refusing to open.
function loadOrCreateKey(dbPath: string): string | null {
  const keyFile = path.join(path.dirname(dbPath), '.dbkey')
  try {
    if (fs.existsSync(keyFile)) {
      const blob = fs.readFileSync(keyFile)
      return safeStorage.decryptString(blob)
    }
  } catch (e) {
    console.error('[db] failed to read DB key — opening without encryption', e)
    return null
  }
  // No key yet. Only create one (→ encrypted DB) if there's no existing DB to
  // migrate and the OS gives us real encryption.
  if (fs.existsSync(dbPath)) return null // legacy plaintext DB — leave it
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[db] OS encryption unavailable — creating plaintext DB')
      return null
    }
    const key = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(keyFile, safeStorage.encryptString(key), { mode: 0o600 })
    console.log('[db] created encrypted database key')
    return key
  } catch (e) {
    console.error('[db] failed to create DB key — creating plaintext DB', e)
    return null
  }
}

// --- Full-text indexes --------------------------------------------------------------------------
// Every FTS5 table uses one tokenizer (FTS_TOKENIZE: keeps Devanagari vowel signs inside words) and
// indexes text exactly as normaliseForIndex leaves it (NFC, no zero-width joiners), so a word
// matches the same way in every corpus. Triggers normalise through offgrid_fts_text(); a rebuild
// re-inserts through it too, never with FTS5's 'rebuild' command, which would read the raw text.
// Each table records the FTS_SCHEMA_VERSION it was built with in fts_schema, so a tokenizer or
// normalisation change rebuilds every profile's indexes exactly once, in the background after
// start-up (never inside getDB()). frame_fts is the exception: see frame-text-index.ts.
//
// Chinese, Japanese, Thai, Lao, Khmer and Burmese are written without spaces, so unicode61 makes a
// whole run one token and a word inside it never matches. Each index with `trigram` set has a twin,
// `${name}_tri`, on FTS5's trigram tokenizer (any substring of three characters or more), holding
// only the rows whose text has such a script (offgrid_needs_trigram). See ensureTrigramIndex.

/** The SQLite functions the FTS triggers call. Every connection that writes indexed tables needs them. */
export function registerFtsFunctions(database: Database.Database): void {
  database.function('offgrid_fts_text', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? normaliseForIndex(value) : (value as null)
  )
  // 1 when any argument is text in a script written without spaces (the trigram twins' filter).
  database.function(
    'offgrid_needs_trigram',
    { deterministic: true, varargs: true },
    (...values: unknown[]) =>
      values.some((value) => typeof value === 'string' && needsTrigram(value)) ? 1 : 0
  )
}

/** An external-content FTS5 index over one table's text columns, kept in step by triggers. */
export interface FtsIndexSpec {
  /** The FTS5 table. */
  name: string
  /** The table it indexes, and the column that is that table's rowid. */
  source: string
  rowid: string
  /** Searched columns; their text is normalised as it is indexed. */
  columns: string[]
  /** Stored with each row but not searched (e.g. the owning conversation). */
  unindexed?: string[]
  /** Its triggers are `${triggers}_ai`, `_ad` and `_au`. */
  triggers: string
  /** Also keep a trigram twin (`${name}_tri`) of the rows in no-space scripts. */
  trigram?: boolean
}

export const CORE_FTS_INDEXES: FtsIndexSpec[] = [
  {
    name: 'rag_message_fts',
    source: 'rag_messages',
    rowid: 'id',
    columns: ['content'],
    unindexed: ['conversation_id'],
    triggers: 'rag_messages',
    trigram: true
  },
  {
    name: 'summary_fts',
    source: 'chat_summaries',
    rowid: 'rowid',
    columns: ['summary'],
    unindexed: ['session_id'],
    triggers: 'summaries',
    trigram: true
  },
  {
    name: 'entity_fts',
    source: 'entities',
    rowid: 'id',
    columns: ['name', 'summary', 'type'],
    triggers: 'entities',
    trigram: true
  }
]

/** Screen moments. Pro creates `observations`; the index is rebuilt here once the table exists. */
export const OBSERVATION_FTS: FtsIndexSpec = {
  name: 'observation_fts',
  source: 'observations',
  rowid: 'id',
  columns: ['summary'],
  triggers: 'observations',
  trigram: true
}

/**
 * The legacy `memories` and `entity_facts` stores are retired: nothing writes or searches them. Their
 * rows stay (the user's data, cleared by "Delete all my data"); their full-text indexes, which were
 * derived from those rows, and the triggers that kept them are removed so no stale copy of the text
 * outlives the rows. Idempotent.
 */
function retireLegacyMemoryIndexes(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;
    DROP TRIGGER IF EXISTS memories_next_ai;
    DROP TRIGGER IF EXISTS memories_next_ad;
    DROP TRIGGER IF EXISTS memories_next_au;
    DROP TRIGGER IF EXISTS entity_facts_ai;
    DROP TRIGGER IF EXISTS entity_facts_ad;
    DROP TRIGGER IF EXISTS entity_facts_au;
    DROP TRIGGER IF EXISTS entity_facts_next_ai;
    DROP TRIGGER IF EXISTS entity_facts_next_ad;
    DROP TRIGGER IF EXISTS entity_facts_next_au;
    DROP TABLE IF EXISTS memory_fts;
    DROP TABLE IF EXISTS memory_fts_next;
    DROP TABLE IF EXISTS entity_fact_fts;
    DROP TABLE IF EXISTS entity_fact_fts_next;
  `)
  for (const name of ['memory_fts', 'entity_fact_fts']) clearRebuildCursor(database, name)
}

/** Whether a table (or virtual table) exists. The one check every store uses: Pro creates many of
 *  the tables core reads, lazily. */
export function tableExists(database: Database.Database, name: string): boolean {
  return !!database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name)
}

/** True when `name` exists and was built with this build's tokenizer and normalisation. */
export function ftsIndexIsCurrent(database: Database.Database, name: string): boolean {
  database.exec(
    'CREATE TABLE IF NOT EXISTS fts_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL)'
  )
  const row = database.prepare('SELECT version FROM fts_schema WHERE name = ?').get(name) as
    | { version: number }
    | undefined
  return !!row && row.version >= FTS_SCHEMA_VERSION && tableExists(database, name)
}

export function markFtsIndexCurrent(database: Database.Database, name: string): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS fts_schema (name TEXT PRIMARY KEY, version INTEGER NOT NULL)'
  )
  database
    .prepare(
      'INSERT INTO fts_schema (name, version) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET version = excluded.version'
    )
    .run(name, FTS_SCHEMA_VERSION)
}

/** Deleted terms are removed from the index itself, not only marked (FTS5 'secure-delete'). */
export function enableFtsSecureDelete(database: Database.Database, name: string): void {
  database.exec(`INSERT INTO ${name}(${name}, rank) VALUES('secure-delete', 1)`)
}

function ftsRowValues(spec: FtsIndexSpec, row: 'new' | 'old'): string {
  return [
    `${row}.${spec.rowid}`,
    ...spec.columns.map((column) => `offgrid_fts_text(${row}.${column})`),
    ...(spec.unindexed ?? []).map((column) => `${row}.${column}`)
  ].join(', ')
}

function ftsColumnNames(spec: FtsIndexSpec): string {
  return ['rowid', ...spec.columns, ...(spec.unindexed ?? [])].join(', ')
}

/** Create the three sync triggers if they are missing. */
export function installFtsTriggers(database: Database.Database, spec: FtsIndexSpec): void {
  const { name, source, triggers } = spec
  const columns = ftsColumnNames(spec)
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS ${triggers}_ai AFTER INSERT ON ${source} BEGIN
      INSERT INTO ${name}(${columns}) VALUES (${ftsRowValues(spec, 'new')});
    END;
    CREATE TRIGGER IF NOT EXISTS ${triggers}_ad AFTER DELETE ON ${source} BEGIN
      INSERT INTO ${name}(${name}, ${columns}) VALUES ('delete', ${ftsRowValues(spec, 'old')});
    END;
    CREATE TRIGGER IF NOT EXISTS ${triggers}_au AFTER UPDATE ON ${source} BEGIN
      INSERT INTO ${name}(${name}, ${columns}) VALUES ('delete', ${ftsRowValues(spec, 'old')});
      INSERT INTO ${name}(${columns}) VALUES (${ftsRowValues(spec, 'new')});
    END;
  `)
}

/** Re-index every row of the source table (the index is emptied first). One statement: only for
 *  rare repairs (the legacy purge, "clear memories"); a schema upgrade rebuilds in the background
 *  (ensureFtsIndex queues it). */
export function rebuildFtsIndex(database: Database.Database, spec: FtsIndexSpec): void {
  database.exec(`INSERT INTO ${spec.name}(${spec.name}) VALUES('delete-all')`)
  database.exec(
    `INSERT INTO ${spec.name}(${ftsColumnNames(spec)})
     SELECT ${ftsSelectValues(spec)} FROM ${spec.source}`
  )
  const twin = trigramName(spec)
  // A twin still being filled in the background is left to finish (it reads the rows as they are).
  if (spec.trigram && ftsIndexIsCurrent(database, twin)) {
    database.exec(`INSERT INTO ${twin}(${twin}) VALUES('delete-all')`)
    database.exec(
      `INSERT INTO ${twin}(${trigramColumnNames(spec)})
       SELECT ${trigramSelectValues(spec)} FROM ${spec.source} WHERE ${trigramFilter(spec)}`
    )
  }
}

function ftsSelectValues(spec: FtsIndexSpec): string {
  return [
    spec.rowid,
    ...spec.columns.map((column) => `offgrid_fts_text(${column})`),
    ...(spec.unindexed ?? [])
  ].join(', ')
}

function createFtsTable(database: Database.Database, spec: FtsIndexSpec, name: string): void {
  const columns = [...spec.columns, ...(spec.unindexed ?? []).map((c) => `${c} UNINDEXED`)]
  database.exec(`
    CREATE VIRTUAL TABLE ${name} USING fts5(
      ${columns.join(', ')},
      content='${spec.source}'${spec.rowid === 'rowid' ? '' : `, content_rowid='${spec.rowid}'`},
      tokenize = "${FTS_TOKENIZE}"
    );
  `)
  enableFtsSecureDelete(database, name)
}

/**
 * Make `spec`'s index usable without reading its rows, so it is safe inside getDB() and on any
 * request path:
 *   - current: put back triggers something dropped;
 *   - missing: create it (empty) with its triggers; an empty source table makes it current;
 *   - built by an older schema: leave it serving, with the triggers it was built with (their
 *     deletes must match what it indexed), until the background rebuild replaces it.
 * Returns true when the index still needs rebuilding (queued; startIndexRebuilds runs it). A no-op
 * until the source table exists.
 */
/** Indexes small enough to verify at startup (to-dos, meetings): FTS5's own integrity check. */
const VERIFIED_AT_STARTUP = new Set(['action_fts', 'meeting_fts'])
const verified = new Set<string>()

/**
 * An index FTS5 reports inconsistent with its table (an entry deleted that was never added) is
 * marked out of date, so the background rebuild replaces it. Once per index per launch.
 */
function verifySmallIndex(database: Database.Database, spec: FtsIndexSpec): void {
  if (!VERIFIED_AT_STARTUP.has(spec.name) || verified.has(spec.name)) return
  verified.add(spec.name)
  if (!tableExists(database, spec.name) || !ftsIndexIsCurrent(database, spec.name)) return
  try {
    database.exec(`INSERT INTO ${spec.name}(${spec.name}, rank) VALUES ('integrity-check', 1)`)
  } catch (error) {
    console.warn(`[fts] ${spec.name} is inconsistent; rebuilding it:`, (error as Error).message)
    // Its triggers stop now, so edits cannot fail on it; the rebuild puts them back with the swap.
    database.exec(`
      DROP TRIGGER IF EXISTS ${spec.triggers}_ai;
      DROP TRIGGER IF EXISTS ${spec.triggers}_ad;
      DROP TRIGGER IF EXISTS ${spec.triggers}_au;
    `)
    database.prepare('DELETE FROM fts_schema WHERE name = ?').run(spec.name)
  }
}

export function ensureFtsIndex(database: Database.Database, spec: FtsIndexSpec): boolean {
  verifySmallIndex(database, spec)
  const pending = ensureMainFtsIndex(database, spec)
  if (spec.trigram) ensureTrigramIndex(database, spec)
  return pending
}

function ensureMainFtsIndex(database: Database.Database, spec: FtsIndexSpec): boolean {
  if (!tableExists(database, spec.source)) return false
  if (ftsIndexIsCurrent(database, spec.name)) {
    installFtsTriggers(database, spec)
    return false
  }
  if (!tableExists(database, spec.name)) {
    database.transaction(() => {
      database.exec(`
        DROP TRIGGER IF EXISTS ${spec.triggers}_ai;
        DROP TRIGGER IF EXISTS ${spec.triggers}_ad;
        DROP TRIGGER IF EXISTS ${spec.triggers}_au;
      `)
      createFtsTable(database, spec, spec.name)
      // Triggers only once every existing row is indexed. On a table that already has rows, an
      // update or delete would otherwise remove an entry that was never added, which FTS5 (with
      // secure-delete) reports as a malformed index. The background rebuild indexes the rows into a
      // twin with guarded triggers and installs these triggers when it swaps the twin in.
      if (!database.prepare(`SELECT 1 FROM ${spec.source} LIMIT 1`).get()) {
        installFtsTriggers(database, spec)
        markFtsIndexCurrent(database, spec.name)
      }
    })()
    if (ftsIndexIsCurrent(database, spec.name)) return false
  }
  queueIndexRebuild(spec.name, ftsRebuildStep(spec))
  return true
}

// --- Trigram twins -------------------------------------------------------------------------------
// `${name}_tri` is an external-content FTS5 table over the same source table and columns, on the
// trigram tokenizer, holding only the rows offgrid_needs_trigram picks (mostly Latin profiles hold
// next to nothing in it). Its triggers carry the same filter, so a delete removes exactly what an
// insert indexed; 'secure-delete' erases the deleted terms, as on every other index. A missing or
// outdated twin is created empty with its triggers and filled in the background in rowid order
// (fts_rebuild holds how far): until then its triggers index only rows already copied, and later
// rows are copied with their latest text, so no row is indexed twice or deleted unindexed. frame_fts
// has no twin: it is every word ever on screen, and observation summaries cover the moments.

/** The trigram twin of an index. */
export function trigramName(spec: { name: string }): string {
  return `${spec.name}_tri`
}

function trigramColumnNames(spec: FtsIndexSpec): string {
  return ['rowid', ...spec.columns].join(', ')
}

function trigramRowValues(spec: FtsIndexSpec, row: 'new' | 'old'): string {
  return [
    `${row}.${spec.rowid}`,
    ...spec.columns.map((column) => `offgrid_fts_text(${row}.${column})`)
  ].join(', ')
}

function trigramSelectValues(spec: FtsIndexSpec): string {
  return [spec.rowid, ...spec.columns.map((column) => `offgrid_fts_text(${column})`)].join(', ')
}

/** True for a row the twin indexes. `row` is 'new', 'old' or '' (the source table itself). */
function trigramFilter(spec: FtsIndexSpec, row: 'new' | 'old' | '' = ''): string {
  const prefix = row ? `${row}.` : ''
  return `offgrid_needs_trigram(${spec.columns.map((column) => prefix + column).join(', ')})`
}

function createTrigramTable(database: Database.Database, spec: FtsIndexSpec): void {
  const name = trigramName(spec)
  database.exec(`
    CREATE VIRTUAL TABLE ${name} USING fts5(
      ${spec.columns.join(', ')},
      content='${spec.source}'${spec.rowid === 'rowid' ? '' : `, content_rowid='${spec.rowid}'`},
      tokenize = "${FTS_TRIGRAM_TOKENIZE}"
    );
  `)
  enableFtsSecureDelete(database, name)
}

/** The twin's triggers. While it is being filled, only rows the fill has copied are kept in step. */
function installTrigramTriggers(database: Database.Database, spec: FtsIndexSpec): void {
  const name = trigramName(spec)
  const columns = trigramColumnNames(spec)
  rebuildState(database) // the triggers read fts_rebuild
  const copied = (row: 'new' | 'old'): string =>
    `${row}.${spec.rowid} <= COALESCE((SELECT cursor FROM fts_rebuild WHERE name = '${name}'), ${Number.MAX_SAFE_INTEGER})`
  const indexed = (row: 'new' | 'old'): string => `${trigramFilter(spec, row)} AND ${copied(row)}`
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS ${spec.triggers}_tri_ai AFTER INSERT ON ${spec.source}
    WHEN ${indexed('new')} BEGIN
      INSERT INTO ${name}(${columns}) VALUES (${trigramRowValues(spec, 'new')});
    END;
    CREATE TRIGGER IF NOT EXISTS ${spec.triggers}_tri_ad AFTER DELETE ON ${spec.source}
    WHEN ${indexed('old')} BEGIN
      INSERT INTO ${name}(${name}, ${columns}) VALUES ('delete', ${trigramRowValues(spec, 'old')});
    END;
    CREATE TRIGGER IF NOT EXISTS ${spec.triggers}_tri_au AFTER UPDATE OF ${spec.columns.join(', ')} ON ${spec.source}
    WHEN ${trigramFilter(spec, 'old')} OR ${trigramFilter(spec, 'new')} BEGIN
      INSERT INTO ${name}(${name}, ${columns}) SELECT 'delete', ${trigramRowValues(spec, 'old')} WHERE ${indexed('old')};
      INSERT INTO ${name}(${columns}) SELECT ${trigramRowValues(spec, 'new')} WHERE ${indexed('new')};
    END;
  `)
}

function dropTrigramTriggers(database: Database.Database, spec: FtsIndexSpec): void {
  database.exec(`
    DROP TRIGGER IF EXISTS ${spec.triggers}_tri_ai;
    DROP TRIGGER IF EXISTS ${spec.triggers}_tri_ad;
    DROP TRIGGER IF EXISTS ${spec.triggers}_tri_au;
  `)
}

/**
 * Make `spec`'s trigram twin usable without reading its rows (safe inside getDB()): a current twin
 * gets back any trigger something dropped; a missing or outdated one is created empty and filled in
 * the background after start-up (trigramFillStep); a fill under way resumes. A no-op until the
 * source table exists.
 */
export function ensureTrigramIndex(database: Database.Database, spec: FtsIndexSpec): void {
  if (!tableExists(database, spec.source)) return
  const name = trigramName(spec)
  if (ftsIndexIsCurrent(database, name)) {
    installTrigramTriggers(database, spec)
    return
  }
  if (rebuildCursor(database, name) === null || !tableExists(database, name)) {
    database.transaction(() => {
      dropTrigramTriggers(database, spec)
      database.exec(`DROP TABLE IF EXISTS ${name}`)
      createTrigramTable(database, spec)
      if (database.prepare(`SELECT 1 FROM ${spec.source} LIMIT 1`).get()) {
        setRebuildCursor(database, name, 0)
      } else {
        clearRebuildCursor(database, name)
        markFtsIndexCurrent(database, name)
      }
      installTrigramTriggers(database, spec)
    })()
    if (ftsIndexIsCurrent(database, name)) return
  } else {
    installTrigramTriggers(database, spec)
  }
  queueIndexRebuild(name, trigramFillStep(spec))
}

/** One slice of filling a twin with the source rows that need it, in rowid order. The last slice
 *  ends the fill (its triggers then keep every row in step) in the same transaction. */
function trigramFillStep(spec: FtsIndexSpec): () => boolean {
  let batch = 500
  const name = trigramName(spec)
  return () => {
    const database = getDB()
    if (!tableExists(database, spec.source) || !tableExists(database, name)) return false
    const cursor = rebuildCursor(database, name)
    if (cursor === null) return false
    const started = Date.now()
    const upper = (
      database
        .prepare(
          `SELECT MAX(r) AS r FROM (SELECT ${spec.rowid} AS r FROM ${spec.source}
            WHERE ${spec.rowid} > ? ORDER BY ${spec.rowid} LIMIT ?)`
        )
        .get(cursor, batch) as { r: number | null }
    ).r
    if (upper === null) {
      database.transaction(() => {
        clearRebuildCursor(database, name)
        markFtsIndexCurrent(database, name)
      })()
      return false
    }
    database.transaction(() => {
      database
        .prepare(
          `INSERT INTO ${name}(${trigramColumnNames(spec)})
           SELECT ${trigramSelectValues(spec)} FROM ${spec.source}
            WHERE ${spec.rowid} > ? AND ${spec.rowid} <= ? AND ${trigramFilter(spec)}`
        )
        .run(cursor, upper)
      setRebuildCursor(database, name, upper)
    })()
    batch = adaptBatch(batch, Date.now() - started)
    return true
  }
}

// --- Background index rebuilds ------------------------------------------------------------------
// A tokenizer or normalisation change (FTS_SCHEMA_VERSION) rebuilds each index beside the old one,
// `${name}_next`, a slice at a time on the main thread's idle moments, while the old index keeps
// answering searches. Rows are copied in rowid order; fts_rebuild holds how far the copy got, and
// the _next triggers mirror only edits to rows already copied (later rows are copied with their
// latest text). When every row is in, the new index replaces the old in one transaction. Progress
// survives a restart. Nothing here runs until startIndexRebuilds() (after start-up). The same queue
// and cursors (fts_rebuild) serve the document index rebuild, the trigram twins' fills and the
// memory-search queue seeding.

/** A slice indexes for about this long, then the thread rests. */
const REBUILD_SLICE_MS = 20
const REBUILD_PAUSE_MS = 60

const pendingRebuilds = new Map<string, () => boolean>()
let rebuildsStarted = false
let rebuildTimer: ReturnType<typeof setTimeout> | null = null

/** Queue background work (one slice per call; it returns whether more remains) under `name`. */
export function queueIndexRebuild(name: string, step: () => boolean): void {
  if (!pendingRebuilds.has(name)) pendingRebuilds.set(name, step)
  if (rebuildsStarted) scheduleRebuildSlice()
}

/** Start the queued index rebuilds, a slice at a time. Called once start-up has settled. */
export function startIndexRebuilds(): void {
  rebuildsStarted = true
  scheduleRebuildSlice()
}

/** Stop between slices (shutdown, profile switch). Progress is kept; the next start resumes. */
export function stopIndexRebuilds(): void {
  rebuildsStarted = false
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = null
}

function scheduleRebuildSlice(): void {
  if (rebuildTimer || !pendingRebuilds.size) return
  rebuildTimer = setTimeout(runRebuildSlice, REBUILD_PAUSE_MS)
  rebuildTimer.unref()
}

function runRebuildSlice(): void {
  rebuildTimer = null
  // A closed connection (shutdown, profile switch) is not reopened for background work.
  if (!rebuildsStarted || !db?.open) return
  const next = pendingRebuilds.entries().next()
  if (next.done) return
  const [name, step] = next.value
  let more = false
  try {
    more = step()
  } catch (error) {
    // Not marked current, so it is retried on the next launch; the old index keeps serving.
    console.error(`[database] background rebuild of ${name} failed; will retry`, error)
  }
  if (!more) pendingRebuilds.delete(name)
  scheduleRebuildSlice()
}

/** Rows a slice copies; adjusted so a slice takes about REBUILD_SLICE_MS. */
function adaptBatch(batch: number, elapsedMs: number): number {
  if (elapsedMs > REBUILD_SLICE_MS) return Math.max(10, Math.floor(batch / 2))
  if (elapsedMs < REBUILD_SLICE_MS / 2) return Math.min(5_000, batch * 2)
  return batch
}

function rebuildState(database: Database.Database): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS fts_rebuild (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL)'
  )
}

/** The highest rowid copied into `name`'s rebuild; null when no rebuild is under way. */
export function rebuildCursor(database: Database.Database, name: string): number | null {
  rebuildState(database)
  const row = database.prepare('SELECT cursor FROM fts_rebuild WHERE name = ?').get(name) as
    | { cursor: number }
    | undefined
  return row ? row.cursor : null
}

export function setRebuildCursor(database: Database.Database, name: string, cursor: number): void {
  rebuildState(database)
  database
    .prepare(
      'INSERT INTO fts_rebuild (name, cursor) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor'
    )
    .run(name, cursor)
}

export function clearRebuildCursor(database: Database.Database, name: string): void {
  rebuildState(database)
  database.prepare('DELETE FROM fts_rebuild WHERE name = ?').run(name)
}

/** Triggers that mirror edits to rows already copied into the rebuild. */
function installRebuildTriggers(database: Database.Database, spec: FtsIndexSpec): void {
  const next = `${spec.name}_next`
  const columns = ftsColumnNames(spec)
  const copied = (row: 'new' | 'old'): string =>
    `${row}.${spec.rowid} <= (SELECT cursor FROM fts_rebuild WHERE name = '${spec.name}')`
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS ${spec.triggers}_next_ai AFTER INSERT ON ${spec.source}
    WHEN ${copied('new')} BEGIN
      INSERT INTO ${next}(${columns}) VALUES (${ftsRowValues(spec, 'new')});
    END;
    CREATE TRIGGER IF NOT EXISTS ${spec.triggers}_next_ad AFTER DELETE ON ${spec.source}
    WHEN ${copied('old')} BEGIN
      INSERT INTO ${next}(${next}, ${columns}) VALUES ('delete', ${ftsRowValues(spec, 'old')});
    END;
    CREATE TRIGGER IF NOT EXISTS ${spec.triggers}_next_au AFTER UPDATE ON ${spec.source} BEGIN
      INSERT INTO ${next}(${next}, ${columns}) SELECT 'delete', ${ftsRowValues(spec, 'old')} WHERE ${copied('old')};
      INSERT INTO ${next}(${columns}) SELECT ${ftsRowValues(spec, 'new')} WHERE ${copied('new')};
    END;
  `)
}

function dropRebuildTriggers(database: Database.Database, spec: FtsIndexSpec): void {
  database.exec(`
    DROP TRIGGER IF EXISTS ${spec.triggers}_next_ai;
    DROP TRIGGER IF EXISTS ${spec.triggers}_next_ad;
    DROP TRIGGER IF EXISTS ${spec.triggers}_next_au;
  `)
}

/** One slice of `spec`'s background rebuild; the last one swaps the new index in. */
function ftsRebuildStep(spec: FtsIndexSpec): () => boolean {
  let batch = 200
  const next = `${spec.name}_next`
  return () => {
    const database = getDB()
    if (!tableExists(database, spec.source) || ftsIndexIsCurrent(database, spec.name)) return false
    let cursor = rebuildCursor(database, spec.name)
    if (cursor === null || !tableExists(database, next)) {
      database.transaction(() => {
        dropRebuildTriggers(database, spec)
        database.exec(`DROP TABLE IF EXISTS ${next}`)
        createFtsTable(database, spec, next)
        setRebuildCursor(database, spec.name, 0)
        installRebuildTriggers(database, spec)
      })()
      cursor = 0
    }
    const started = Date.now()
    const upper = (
      database
        .prepare(
          `SELECT MAX(r) AS r FROM (SELECT ${spec.rowid} AS r FROM ${spec.source}
            WHERE ${spec.rowid} > ? ORDER BY ${spec.rowid} LIMIT ?)`
        )
        .get(cursor, batch) as { r: number | null }
    ).r
    const copy = database.prepare(
      `INSERT INTO ${next}(${ftsColumnNames(spec)})
       SELECT ${ftsSelectValues(spec)} FROM ${spec.source}
        WHERE ${spec.rowid} > ? AND ${spec.rowid} <= ?`
    )
    if (upper === null) {
      // Every row is in: the new index replaces the old, with the normalising triggers.
      database.transaction(() => {
        copy.run(cursor, Number.MAX_SAFE_INTEGER)
        dropRebuildTriggers(database, spec)
        database.exec(`
          DROP TRIGGER IF EXISTS ${spec.triggers}_ai;
          DROP TRIGGER IF EXISTS ${spec.triggers}_ad;
          DROP TRIGGER IF EXISTS ${spec.triggers}_au;
          DROP TABLE IF EXISTS ${spec.name};
          ALTER TABLE ${next} RENAME TO ${spec.name};
        `)
        installFtsTriggers(database, spec)
        markFtsIndexCurrent(database, spec.name)
        clearRebuildCursor(database, spec.name)
      })()
      return false
    }
    database.transaction(() => {
      copy.run(cursor, upper)
      setRebuildCursor(database, spec.name, upper)
    })()
    batch = adaptBatch(batch, Date.now() - started)
    return true
  }
}

export function getDB(): Database.Database {
  if (db?.open) return db

  // better-sqlite3 keeps the Database object after close(), but every operation on
  // that object fails with "The database connection is not open". Tests, profile
  // lifecycle code, and shutdown/restart paths can legitimately close the shared
  // handle, so a closed cached instance must be treated as absent.
  db = null

  const dbPath = path.join(dataDir(), 'memories.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  console.log('Opening database at:', dbPath)

  const key = loadOrCreateKey(dbPath)
  db = new Database(dbPath)
  // PRAGMA key MUST run before any other access (it unlocks the file).
  if (key) {
    db.pragma(`key = '${key}'`)
    console.log('[db] opened with encryption at rest')
  }
  db.pragma('journal_mode = WAL')
  // Connection tuning only; durability (synchronous) and mmap stay at their defaults.
  // busy_timeout lets a write wait briefly for another connection instead of failing with
  // SQLITE_BUSY; the larger page cache and in-memory temp B-trees keep sorts and joins over
  // capture history off the disk.
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -65536')
  // Deleted content is overwritten inside the pages it lived in (screenpipe leaves it; a deleted
  // capture must not be readable from the file). FAST adds no I/O: pages already being written are
  // zeroed, whole freed pages are not. The FTS5 indexes also use their own 'secure-delete'.
  db.pragma('secure_delete = FAST')
  registerFtsFunctions(db)

  // Initialize Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, -- UUID or "app-slug"
        title TEXT,
        app_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL,
        role TEXT, -- 'user' | 'assistant'
        content TEXT,
        timestamp TEXT, -- Extracted timestamp like "6:57 PM"
        hash TEXT, -- SHA-256 of content for deduplication (legacy)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    -- Legacy memories, retired: nothing writes, indexes, embeds or searches them. Existing rows stay
    -- until the user deletes their data ("Delete all my data" clears them).
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      raw_text TEXT,
      source_app TEXT,
      session_id TEXT,
      message_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      embedding TEXT
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE,
      type TEXT NOT NULL DEFAULT 'Unknown',
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, type)
    );

    -- Legacy entity facts, retired like memories: rows stay, nothing writes or reads them.
    CREATE TABLE IF NOT EXISTS entity_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id INTEGER NOT NULL,
      fact TEXT NOT NULL,
      source_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_id, fact),
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entity_sessions (
      entity_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(entity_id, session_id),
      FOREIGN KEY(entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(session_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS entity_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL,
      target_entity_id INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'cooccurrence',
      weight REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_entity_id, target_entity_id, type),
      FOREIGN KEY(source_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY(target_entity_id) REFERENCES entities(id) ON DELETE CASCADE
    );
  `)

  // Create Chat Summaries Table if not exists (migrating to conversations table eventually)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_summaries (
      session_id TEXT PRIMARY KEY,
      summary TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // Master Memory Table - the retired cumulative profile; nothing writes or reads it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_memory (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      content TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // User Profile Table - stores onboarding questionnaire data as JSON
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // RAG Conversations Table - stores chat sessions with the memory assistant
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      origin_device_id TEXT,
      origin_device_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)

  // RAG Messages Table - stores messages in RAG conversations
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      origin_device_id TEXT,
      origin_device_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(conversation_id) REFERENCES rag_conversations(id) ON DELETE CASCADE
    );
  `)

  initializeSettingsStore(db)

  // Every full-text index over the core tables, on the shared tokenizer. message_fts indexed the
  // legacy scraped `messages` table for the retired rag:chat retrieval; nothing reads it now.
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS message_fts;
  `)
  // Cheap here: a missing index is created empty, and one built by an older schema keeps serving
  // while it is rebuilt in the background after start-up (startIndexRebuilds).
  for (const spec of [...CORE_FTS_INDEXES, OBSERVATION_FTS]) {
    try {
      ensureFtsIndex(db, spec)
    } catch (error) {
      console.error(`[database] full-text index ${spec.name} could not be prepared`, error)
    }
  }
  try {
    retireLegacyMemoryIndexes(db)
  } catch (error) {
    console.error('[database] legacy memory indexes could not be removed', error)
  }

  // The search index that makes the conversation list's content search an index lookup instead of
  // a table scan, and the one that serves the list's "last message in this conversation" reads.
  // rag_messages had NO index at all: every preview and every count was a full scan.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rag_messages_conversation ON rag_messages(conversation_id, created_at DESC, id DESC)'
  )
  // Only the user messages that carry attachments: the chat's document list and document cache
  // cleanup read these (documents/conversation-documents.ts) without scanning every message.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_rag_messages_attachments ON rag_messages(conversation_id, created_at, id)
     WHERE role = 'user' AND context LIKE '%"attachments"%'`
  )

  // Migration: Add timestamp column to messages if it doesn't exist
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN timestamp TEXT`)
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add message_id column to memories if it doesn't exist
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN message_id INTEGER`)
  } catch {
    // Column already exists, ignore
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_message_id ON memories(message_id)')

  // Migration: Add name column to memories if it doesn't exist
  try {
    db.exec(`ALTER TABLE memories ADD COLUMN name TEXT`)
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add project_id to rag_conversations (chats can be scoped to a project)
  try {
    db.exec(`ALTER TABLE rag_conversations ADD COLUMN project_id TEXT`)
  } catch {
    // Column already exists, ignore
  }
  // Migration: which screen a conversation belongs to. NULL is Chat; 'god' is a God conversation.
  try {
    db.exec(`ALTER TABLE rag_conversations ADD COLUMN surface TEXT`)
  } catch {
    // Column already exists, ignore
  }
  for (const column of ['origin_device_id', 'origin_device_name']) {
    try {
      db.exec(`ALTER TABLE rag_conversations ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists, ignore
    }
  }
  // The chat lists page by updated_at, optionally within one project. Without these every list
  // and search page sorted the whole table.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rag_conversations_updated ON rag_conversations(updated_at, id)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_rag_conversations_project_updated ON rag_conversations(project_id, updated_at, id)'
  )

  // Migration: Add a stable UUID to rag_messages so chat messages can replicate across devices.
  //
  // WHY: `rag_messages.id` is INTEGER AUTOINCREMENT, which is device-local. Cross-device sync keys
  // every record by a globally-unique id, so device A's row 7 and device B's row 7 would look like
  // the SAME message and silently overwrite each other. The autoincrement id stays as the local
  // primary key; `uuid` is the cross-device identity. Mobile uses the same column name and the same
  // 'message' entity name — they must match or the two platforms will not converge.
  try {
    db.exec(`ALTER TABLE rag_messages ADD COLUMN uuid TEXT`)
  } catch {
    // Column already exists, ignore
  }
  for (const column of ['origin_device_id', 'origin_device_name']) {
    try {
      db.exec(`ALTER TABLE rag_messages ADD COLUMN ${column} TEXT`)
    } catch {
      // Column already exists, ignore
    }
  }
  // Backfill rows that predate the column. Done in JS because SQLite has no uuid() function.
  try {
    const needsUuid = db
      .prepare('SELECT id FROM rag_messages WHERE uuid IS NULL OR uuid = ?')
      .all('') as Array<{ id: number }>
    if (needsUuid.length > 0) {
      const assign = db.prepare('UPDATE rag_messages SET uuid = ? WHERE id = ?')
      for (const row of needsUuid) assign.run(crypto.randomUUID(), row.id)
    }
  } catch {
    // Table may not exist yet on a brand-new profile; the CREATE above covers that path.
  }
  // Unique so a replayed remote op upserts instead of duplicating. SQLite treats NULLs as
  // distinct, so this is safe to create even if a backfill ever misses a row.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_rag_messages_uuid ON rag_messages(uuid)')

  const versionRepairs = selectedVersionRepairs(
    db
      .prepare(
        `SELECT id, content, context FROM rag_messages WHERE role = 'assistant' AND context LIKE '%"variantIndex"%'`
      )
      .all() as StoredVersionRow[]
  )
  if (versionRepairs.length) {
    const update = db.prepare('UPDATE rag_messages SET content = ? WHERE id = ?')
    db.transaction(() => {
      for (const row of versionRepairs) update.run(row.content, row.id)
    })()
  }

  // Profiles have never been ANALYZEd, so the planner had no statistics. The limit bounds each
  // table's sample so this stays cheap on multi-GB databases; 0x10002 also analyzes tables
  // whose statistics are missing. Later, optimizeDB() refreshes stats for Pro tables created
  // after this point.
  try {
    db.pragma('analysis_limit = 1000')
    db.pragma('optimize = 0x10002')
  } catch (error) {
    console.warn('[database] PRAGMA optimize failed', error)
  }

  return db
}

/** Refresh planner statistics where SQLite judges them stale. Cheap; safe to call periodically. */
export function optimizeDB(): void {
  if (!db?.open) return
  try {
    db.pragma('optimize')
  } catch (error) {
    console.warn('[database] PRAGMA optimize failed', error)
  }
}

/** Run an idempotent schema migration (CREATE TABLE IF NOT EXISTS …) on the
 *  shared DB. Exposed so the pro package can create its own tables (observations,
 *  entities, approvals, …) without core knowing about them. */
export function runMigration(sql: string): void {
  getDB().exec(sql)
}

// === NEW API ACCESSORS ===

export interface ChatSessionRecord {
  session_id: string
  title: string | null
  source_app: string | null
  last_activity: string
  entity_count: number
  summary: string | null
}

export interface MessageRecord {
  id: number
  conversation_id: string
  role: string | null
  content: string | null
  timestamp: string | null
  hash: string | null
  created_at: string
}

export function getChatSessions(): ChatSessionRecord[] {
  const db = getDB()
  // Query conversations with entity counts instead of message count
  const query = `
        SELECT 
            c.id as session_id,
            c.title,
            c.app_name as source_app,
            c.updated_at as last_activity,
            (SELECT COUNT(DISTINCT es.entity_id) FROM entity_sessions es WHERE es.session_id = c.id) as entity_count,
            (SELECT summary FROM chat_summaries cs WHERE cs.session_id = c.id) as summary
        FROM conversations c
        ORDER BY c.updated_at DESC
    `
  return db.prepare(query).all() as ChatSessionRecord[]
}

export function upsertChatSummary(sessionId: string, summary: string): void {
  const db = getDB()
  const stmt = db.prepare(`
        INSERT INTO chat_summaries (session_id, summary, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) DO UPDATE SET
            summary = excluded.summary,
            updated_at = excluded.updated_at
    `)
  stmt.run(sessionId, summary)
}

export function getMemoriesForSession(sessionId: string, limit: number = 200): MessageRecord[] {
  const db = getDB()
  // Fetch from new 'messages' table
  const stmt = db.prepare(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?'
  )
  const messages = stmt.all(sessionId, limit) as MessageRecord[]

  // Map to old Memory interface shape if needed by UI, or UI updates?
  // UI expects { id, content, raw_text, source_app, created_at, role? }
  // We added 'role' to messages.
  return messages
}

export function checkMessageExists(hash: string, conversationId: string): boolean {
  const db = getDB()
  const stmt = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND hash = ? LIMIT 1')
  const result = stmt.get(conversationId, hash)
  return !!result
}

// One-shot, idempotent purge of the legacy "My Memories" data: the AI-chat
// conversations the old watcher scraped (Claude / ChatGPT / Gemini, web +
// desktop) and everything derived from them — messages, the retired memories
// and entity facts, summaries, and entities left orphaned afterwards. The shared
// `entities` table is ALSO fed by the current screen-capture/observation
// pipeline, so we only drop entities with no remaining link in entity_sessions,
// entity_facts, OR observation_entities. Once the legacy conversations are gone
// this finds nothing and is a no-op, so it's safe to call on every startup.
export function purgeLegacyChatImports(): Record<string, number> | null {
  const db = getDB()
  const legacy = db
    .prepare(
      `
        SELECT id FROM conversations
        WHERE app_name IN ('Claude.ai','ChatGPT','Gemini')
           OR LOWER(app_name) LIKE '%claude%'
           OR LOWER(app_name) LIKE '%chatgpt%'
           OR LOWER(app_name) LIKE '%gemini%'
    `
    )
    .all() as { id: string }[]
  const ids = legacy.map((r) => r.id)
  if (ids.length === 0) return null

  const ph = ids.map(() => '?').join(',')
  const hasObsEntities = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='observation_entities'`)
    .get()

  const run = db.transaction(() => {
    const counts: Record<string, number> = {}
    const messages = db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (${ph})`)
      .get(...ids) as { c: number }
    counts.messages = messages.c
    counts.memories = db
      .prepare(`DELETE FROM memories WHERE session_id IN (${ph})`)
      .run(...ids).changes
    counts.summaries = db
      .prepare(`DELETE FROM chat_summaries WHERE session_id IN (${ph})`)
      .run(...ids).changes
    counts.entityFacts = db
      .prepare(`DELETE FROM entity_facts WHERE source_session_id IN (${ph})`)
      .run(...ids).changes
    // Cascades messages + entity_sessions (both FK conversations ON DELETE CASCADE).
    counts.conversations = db
      .prepare(`DELETE FROM conversations WHERE id IN (${ph})`)
      .run(...ids).changes
    // Drop entities now orphaned across every link table (keeps current-capture entities).
    const orphanGuard = hasObsEntities
      ? `id NOT IN (SELECT entity_id FROM entity_sessions)
               AND id NOT IN (SELECT entity_id FROM entity_facts)
               AND id NOT IN (SELECT entity_id FROM observation_entities)`
      : `id NOT IN (SELECT entity_id FROM entity_sessions)
               AND id NOT IN (SELECT entity_id FROM entity_facts)`
    counts.entitiesDeleted = hasObsEntities
      ? db.prepare(`DELETE FROM entities WHERE ${orphanGuard}`).run().changes
      : 0 // without obs links we can't tell current from legacy — leave them
    // The stale consolidated profile is gone for good.
    counts.masterMemory = db.prepare(`DELETE FROM master_memory`).run().changes
    // Re-index the external-content FTS tables so they don't point at deleted rows.
    for (const spec of CORE_FTS_INDEXES) {
      try {
        rebuildFtsIndex(db, spec)
      } catch {
        /* table may be absent */
      }
    }
    return counts
  })
  const result = run()
  console.log('[DB] Purged legacy My Memories chat imports:', result)
  return result
}

export function getAllChatSummaries(): { session_id: string; summary: string }[] {
  const db = getDB()
  const stmt = db.prepare(
    'SELECT session_id, summary FROM chat_summaries WHERE summary IS NOT NULL'
  )
  return stmt.all() as { session_id: string; summary: string }[]
}

// === ENTITIES ===

/**
 * SQLite persistence primitive for EntityDomain. Callers must use
 * resolveEntityCandidate() so admission cannot be bypassed.
 */
export function resolveEntityRecord(
  name: string,
  type: string = 'Unknown'
): { entityId: number; created: boolean } {
  const db = getDB()
  const resolvedType = type.trim() || 'Unknown'
  const resolve = db.transaction(() => {
    const insert = db
      .prepare(
        `INSERT INTO entities (name, type, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(name, type) DO NOTHING`
      )
      .run(name, resolvedType)
    if (insert.changes === 0) {
      db.prepare(
        'UPDATE entities SET updated_at = CURRENT_TIMESTAMP WHERE name = ? AND type = ?'
      ).run(name, resolvedType)
    }
    const row = db
      .prepare('SELECT id FROM entities WHERE name = ? AND type = ?')
      .get(name, resolvedType) as { id: number } | undefined
    return { entityId: row?.id ?? 0, created: insert.changes > 0 }
  })
  return resolve()
}

export function updateEntitySummary(entityId: number, summary: string): void {
  const db = getDB()
  const stmt = db.prepare(`
      UPDATE entities SET summary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `)
  stmt.run(summary, entityId)
}

export function upsertEntitySession(entityId: number, sessionId: string): void {
  const db = getDB()
  const stmt = db.prepare(`
      INSERT OR IGNORE INTO entity_sessions (entity_id, session_id)
      VALUES (?, ?)
    `)
  stmt.run(entityId, sessionId)
}

export interface EntityRecord {
  id: number
  name: string
  type: string
  summary: string | null
  updated_at: string
}

export type SessionEntityRecord = EntityRecord

export function getEntitiesForSession(sessionId: string): SessionEntityRecord[] {
  const db = getDB()
  const stmt = db.prepare(`
      SELECT e.id, e.name, e.type, e.summary, e.updated_at
      FROM entities e
      JOIN entity_sessions es ON es.entity_id = e.id
      WHERE es.session_id = ?
      GROUP BY e.id
      ORDER BY e.updated_at DESC
    `)
  return stmt.all(sessionId) as SessionEntityRecord[]
}

// === DELETE FUNCTIONS ===

/**
 * SQLite persistence primitive for EntityDomain. Core does not rely on foreign
 * key enforcement here: native-driver defaults and historical profiles can
 * differ, so all core dependants are removed explicitly in one transaction.
 */
export function deleteEntityRecord(entityId: number): boolean {
  const db = getDB()
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM entity_edges WHERE source_entity_id = ? OR target_entity_id = ?').run(
      entityId,
      entityId
    )
    // Retired facts are not read any more, but an entity's delete still takes them with it.
    db.prepare('DELETE FROM entity_facts WHERE entity_id = ?').run(entityId)
    db.prepare('DELETE FROM entity_sessions WHERE entity_id = ?').run(entityId)
    return db.prepare('DELETE FROM entities WHERE id = ?').run(entityId).changes > 0
  })
  const deleted = remove()
  console.log(`Deleted entity ${entityId}, deleted: ${deleted}`)
  return deleted
}

// === USER PROFILE ===

export type UserProfile = UserProfileContract

export function getUserProfile(): UserProfile | null {
  const db = getDB()
  const row = db.prepare('SELECT data FROM user_profile WHERE id = 1').get() as
    | { data: string }
    | undefined
  if (!row) return null
  try {
    return JSON.parse(row.data) as UserProfile
  } catch {
    return null
  }
}

export function saveUserProfile(profile: UserProfile): void {
  const db = getDB()
  const now = new Date().toISOString()
  const dataWithTimestamp = { ...profile, completedAt: now }
  const json = JSON.stringify(dataWithTimestamp)

  db.prepare(
    `
        INSERT INTO user_profile (id, data, updated_at)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = ?
    `
  ).run(json, now, json, now)
}

// === RAG CONVERSATIONS ===

export type RagConversation = RagConversationContract
export type { ConversationSurface }

/** Move existing conversations to a screen, e.g. God conversations kept before the column. */
export function setRagConversationsSurface(
  ids: readonly string[],
  surface: ConversationSurface
): void {
  if (!ids.length) return
  const statement = getDB().prepare('UPDATE rag_conversations SET surface = ? WHERE id = ?')
  getDB().transaction(() => {
    for (const id of ids) statement.run(surface === 'god' ? 'god' : null, id)
  })()
  // Paired devices learn the move too, or the conversation stays on the other screen there.
  for (const id of ids) {
    emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  }
}
export type RagMessage = RagMessageContract

export function createRagConversation(
  id: string,
  title?: string,
  projectId?: string | null,
  surface?: ConversationSurface
): string {
  const db = getDB()
  db.prepare(
    `
        INSERT INTO rag_conversations (id, title, project_id, surface, created_at, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `
  ).run(id, title || null, projectId || null, surface === 'god' ? 'god' : null)
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  return id
}

/** One bounded page of the conversation list. `updatedBefore` continues from the last row seen. */
export interface RagConversationPage {
  readonly limit?: number
  /** `updated_at` of the last row the caller already has. Omit for the newest page. */
  readonly updatedBefore?: string
}

function conversationPageLimit(page?: RagConversationPage): number {
  // No page requested keeps the existing full list: the sidebar and project counts have no
  // "load more" yet. SQLite reads LIMIT -1 as no limit.
  if (!page) return -1
  const requested = page.limit ?? DEFAULT_CONVERSATION_PAGE
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_CONVERSATION_PAGE
  return Math.min(Math.floor(requested), MAX_CONVERSATION_PAGE)
}

/**
 * The conversation list, newest first, one bounded page at a time.
 *
 * It used to return EVERY conversation with three correlated subqueries per row - a count and two
 * ordered LIMIT 1 reads for the preview - against a `rag_messages` table with no index at all. So
 * the cost was conversations x messages, on Electron's main thread, every time the list refreshed.
 *
 * Now: the preview and the count come from two index-driven passes over
 * `idx_rag_messages_conversation` instead of 3N subqueries, and the page has an explicit limit
 * with a cursor. The limit bounds what this RETURNS - nothing is trimmed or deleted, and a caller
 * that wants older conversations asks for them with `updatedBefore`.
 */
export function getRagConversations(
  projectId?: string | null,
  page?: RagConversationPage,
  surface?: ConversationSurface
): RagConversation[] {
  const db = getDB()
  const conditions: string[] = []
  const parameters: unknown[] = []
  // Omitted: every conversation. Chat lists its own and leaves God's to God.
  if (surface === 'god') conditions.push("rc.surface = 'god'")
  else if (surface === 'chat') conditions.push("(rc.surface IS NULL OR rc.surface <> 'god')")
  if (projectId === null) conditions.push('rc.project_id IS NULL')
  else if (projectId !== undefined) {
    conditions.push('rc.project_id = ?')
    parameters.push(projectId)
  }
  if (page?.updatedBefore) {
    conditions.push('rc.updated_at < ?')
    parameters.push(page.updatedBefore)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  parameters.push(conversationPageLimit(page))
  // The page is chosen FIRST, then the message reads are restricted to it. Aggregating every
  // message in the database to describe 500 conversations would have replaced one bad shape with
  // another; both joins below are index lookups over the page's conversations only.
  const stmt = db.prepare(`
        WITH page AS (
            SELECT rc.id, rc.title, rc.project_id, rc.surface, rc.origin_device_id,
                   rc.origin_device_name, rc.created_at, rc.updated_at
            FROM rag_conversations rc
            ${where}
            ORDER BY rc.updated_at DESC
            LIMIT ?
        )
        SELECT
            page.id,
            page.title,
            page.project_id,
            page.surface,
            page.origin_device_id,
            page.origin_device_name,
            page.created_at,
            page.updated_at,
            COALESCE(counts.message_count, 0) as message_count,
            -- The last turn, for the list's one-line preview. A conversation synced from a phone
            -- otherwise listed as a title with nothing under it. One ordered pass over
            -- idx_rag_messages_conversation picks it, instead of two ordered subqueries per row.
            last.role as last_role,
            last.content as last_content
        FROM page
        LEFT JOIN (
            SELECT conversation_id, COUNT(*) as message_count
            FROM rag_messages
            WHERE conversation_id IN (SELECT id FROM page)
            GROUP BY conversation_id
        ) counts ON counts.conversation_id = page.id
        LEFT JOIN (
            SELECT conversation_id, role, content FROM (
                SELECT conversation_id, role, content,
                       ROW_NUMBER() OVER (
                         PARTITION BY conversation_id ORDER BY created_at DESC, id DESC
                       ) as recency
                FROM rag_messages
                WHERE conversation_id IN (SELECT id FROM page)
            ) WHERE recency = 1
        ) last ON last.conversation_id = page.id
        ORDER BY page.updated_at DESC
    `)
  return stmt.all(...parameters) as RagConversation[]
}

export function getRagConversation(id: string): RagConversation | null {
  const db = getDB()
  return db
    .prepare(
      `
        SELECT id, title, project_id, surface, origin_device_id, origin_device_name, created_at,
               updated_at
        FROM rag_conversations
        WHERE id = ?
    `
    )
    .get(id) as RagConversation | null
}

export function setRagConversationProject(id: string, projectId: string | null): void {
  const db = getDB()
  const result = db
    .prepare(
      `UPDATE rag_conversations SET project_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
    .run(projectId, id)
  if (result.changes === 1) {
    emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  }
}

/**
 * Conversation ids whose MESSAGE CONTENT matches a query (all of its words) — so the chat-list
 * search can match what was said, not just the title.
 *
 * This was `lower(content) LIKE '%term%'` per term, with no LIMIT, over a `rag_messages` table
 * with no index: a leading wildcard cannot use one, so every keystroke's search read every message
 * ever stored, synchronously, on the main thread. It is an FTS5 MATCH against
 * `rag_message_fts` now, and it returns a bounded page - the caller renders a list, not a report.
 */
export function searchRagConversationIds(query: string, limit?: number): string[] {
  // Type-ahead: every word must match, each as a word start (the last may still be half typed).
  const match = ftsTypeahead(query)
  if (!match) return []
  const requested = limit ?? DEFAULT_SEARCH_LIMIT
  const bounded = Math.min(
    Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : DEFAULT_SEARCH_LIMIT,
    MAX_SEARCH_LIMIT
  )
  const rows = getDB()
    .prepare(
      `SELECT DISTINCT conversation_id
         FROM rag_message_fts
        WHERE rag_message_fts MATCH ?
        LIMIT ?`
    )
    .all(match, bounded) as { conversation_id: string }[]
  return rows.map((row) => row.conversation_id)
}

/** Desktop chat search (title substring or the same escaped message FTS), newest first.
 * Keyset pages have no fixed result cap, so older matches remain accessible.
 */
export function searchRagConversationPage(
  query: string,
  limit: number,
  cursor?: { updatedAt: string; id: string }
): {
  id: string
  title: string | null
  created_at: string
  updated_at: string
  origin_device_id: string | null
  excerpt: string
  turn_count: number
  fallback_title: string | null
}[] {
  const match = ftsTypeahead(query)
  return getDB()
    .prepare(
      `
    SELECT rc.id, rc.title, rc.created_at, rc.updated_at, rc.origin_device_id,
      (SELECT COUNT(*) FROM rag_messages WHERE conversation_id = rc.id
        AND role IN ('user', 'assistant')) AS turn_count,
      (SELECT substr(content, 1, 48) FROM (
        SELECT role, content, created_at, id FROM rag_messages WHERE conversation_id = rc.id
          AND role IN ('user', 'assistant')
        ORDER BY julianday(created_at) DESC, id DESC LIMIT 40
      ) WHERE role = 'user' ORDER BY julianday(created_at) ASC, id ASC LIMIT 1) AS fallback_title,
      COALESCE((SELECT snippet(rag_message_fts, 0, '', '', '…', 32)
        FROM rag_message_fts WHERE rag_message_fts MATCH ?
          AND conversation_id = rc.id ORDER BY rank LIMIT 1), rc.title, '') AS excerpt
    FROM rag_conversations rc
    WHERE (instr(lower(COALESCE(rc.title, '')), lower(?)) > 0
      OR rc.id IN (SELECT conversation_id FROM rag_message_fts WHERE rag_message_fts MATCH ?))
      ${cursor ? 'AND (rc.updated_at < ? OR (rc.updated_at = ? AND rc.id < ?))' : ''}
    ORDER BY rc.updated_at DESC, rc.id DESC LIMIT ?
  `
    )
    .all(
      match ?? '""',
      query,
      match ?? '""',
      ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
      limit
    ) as {
    id: string
    title: string | null
    created_at: string
    updated_at: string
    origin_device_id: string | null
    excerpt: string
    turn_count: number
    fallback_title: string | null
  }[]
}

/**
 * Recent messages from OTHER chats in the same project — lets a project chat
 * reference what was discussed in sibling conversations. Returns chronological.
 */
export function getProjectChatHistory(
  projectId: string,
  excludeConversationId: string,
  limit = 12
): { role: string; content: string; title: string | null }[] {
  const db = getDB()
  // Project memory spans every sibling chat in the project (rag_conversations),
  // so context isn't lost across chats in the project.
  const rows = db
    .prepare(
      `
        SELECT rm.role AS role, rm.content AS content, rc.title AS title, rm.created_at AS created_at
        FROM rag_messages rm
        JOIN rag_conversations rc ON rc.id = rm.conversation_id
        WHERE rc.project_id = ? AND rm.conversation_id != ?
        ORDER BY rm.created_at DESC
        LIMIT ?
    `
    )
    .all(projectId, excludeConversationId, limit) as {
    role: string
    content: string
    title: string | null
    created_at: string
  }[]
  return rows.map(({ role, content, title }) => ({ role, content, title })).reverse()
}

/** A sibling project chat's message, with the conversation it belongs to and when it was said. */
export interface ProjectConversationMessage {
  role: string
  content: string
  title: string | null
  conversation_id: string
  created_at: string
}

/** Relevant messages from other conversations in one project, best match first (bm25 over
 *  rag_message_fts). Never crosses projects. */
export function searchProjectConversations(
  projectId: string,
  query: string,
  excludeConversationId = '',
  limit = 6
): ProjectConversationMessage[] {
  const match = ftsQuery(query)
  if (!match) return []
  return getDB()
    .prepare(
      `SELECT rm.role, rm.content, rc.title, rm.conversation_id, rm.created_at
         FROM rag_message_fts f
         JOIN rag_messages rm ON rm.id = f.rowid
         JOIN rag_conversations rc ON rc.id = rm.conversation_id
        WHERE rag_message_fts MATCH ? AND rc.project_id = ? AND rm.conversation_id != ?
        ORDER BY bm25(rag_message_fts), rm.created_at DESC, rm.id DESC
        LIMIT ?`
    )
    .all(
      match,
      projectId,
      excludeConversationId,
      Math.min(12, Math.max(1, limit))
    ) as ProjectConversationMessage[]
}

export function updateRagConversationTitle(id: string, title: string): RagConversation {
  const normalizedTitle = title.trim()
  if (!normalizedTitle) {
    throw new Error('Conversation title cannot be empty')
  }
  const db = getDB()
  const result = db
    .prepare(
      `
        UPDATE rag_conversations 
        SET title = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE id = ?
    `
    )
    .run(normalizedTitle, id)
  if (result.changes !== 1) {
    throw new Error(`Conversation not found: ${id}`)
  }
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'put' })
  return getRagConversation(id)!
}

export function deleteRagConversation(id: string): boolean {
  const db = getDB()
  const messages = db
    .prepare('SELECT uuid FROM rag_messages WHERE conversation_id = ?')
    .all(id) as Array<{ uuid: string }>
  // FKs are off (no PRAGMA foreign_keys), so rag_messages' ON DELETE CASCADE never
  // fires — delete the conversation's messages explicitly or they orphan (D23).
  db.prepare('DELETE FROM rag_messages WHERE conversation_id = ?').run(id)
  const info = db.prepare('DELETE FROM rag_conversations WHERE id = ?').run(id)
  if (info.changes === 0) return false
  for (const message of messages) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.message,
      entityId: message.uuid,
      kind: 'delete'
    })
  }
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.conversation, entityId: id, kind: 'delete' })
  return true
}

/** The stored message: the device-local row id, and the uuid every device knows it by. */
export interface AddedRagMessage {
  id: number
  uuid: string
}

/**
 * The uuid is RETURNED, not discarded.
 *
 * It is the cross-device identity of the message, and it was minted here and thrown away, so a
 * caller could not name the message it had just created. Anything that had to point at that message
 * from elsewhere therefore pointed at something device-local instead - which is how a generated
 * image came to be named by an absolute path on one Mac.
 */
export function addRagMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  context?: unknown,
  /**
   * The identity this message ALREADY has, when something named it before it was stored.
   *
   * A streamed reply is named at its first token, so the frames a paired device renders live carry
   * the same id as the record that follows. Minting a fresh one here instead is what left the peer
   * unable to match the two, so it drew the answer twice until its preview timed out.
   */
  knownUuid?: string
): AddedRagMessage {
  const db = getDB()
  const contextJson = context ? JSON.stringify(context) : null
  const uuid = knownUuid ?? crypto.randomUUID()

  // uuid is the cross-device identity for sync (the autoincrement id is device-local).
  const info = db
    .prepare(
      `
        INSERT INTO rag_messages (uuid, conversation_id, role, content, context, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `
    )
    .run(uuid, conversationId, role, content, contextJson)

  // Update conversation updated_at timestamp
  db.prepare(
    `
        UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `
  ).run(conversationId)

  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: uuid, kind: 'put' })
  emitSyncMutation({
    entity: CORE_SYNC_ENTITIES.conversation,
    entityId: conversationId,
    kind: 'put'
  })
  return { id: Number(info.lastInsertRowid), uuid }
}

/** Replace one saved message without removing the turns that follow it. */
export function updateRagMessage(
  conversationId: string,
  messageId: string,
  content: string,
  context?: unknown
): boolean {
  const db = getDB()
  const existing = db
    .prepare(
      `SELECT id, uuid, context FROM rag_messages
       WHERE conversation_id = ? AND (uuid = ? OR CAST(id AS TEXT) = ?)`
    )
    .get(conversationId, messageId, messageId) as
    | { id: number; uuid: string; context: string | null }
    | undefined
  if (!existing) return false

  const contextJson = context === undefined ? existing.context : JSON.stringify(context)
  db.prepare('UPDATE rag_messages SET content = ?, context = ? WHERE id = ?').run(
    content,
    contextJson,
    existing.id
  )
  db.prepare('UPDATE rag_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    conversationId
  )
  emitSyncMutation({ entity: CORE_SYNC_ENTITIES.message, entityId: existing.uuid, kind: 'put' })
  emitSyncMutation({
    entity: CORE_SYNC_ENTITIES.conversation,
    entityId: conversationId,
    kind: 'put'
  })
  return true
}

// Keep the first `keepCount` messages of a conversation (chronological) and
// delete the rest — used by regenerate/edit so old answers don't pile up.
export function truncateRagMessages(conversationId: string, keepCount: number): number {
  const db = getDB()
  const rows = db
    .prepare(
      `SELECT id, uuid FROM rag_messages WHERE conversation_id = ? ORDER BY julianday(created_at) ASC, id ASC`
    )
    .all(conversationId) as Array<{ id: number; uuid: string }>
  const toDelete = rows.slice(Math.max(0, keepCount))
  if (!toDelete.length) return 0
  const ph = toDelete.map(() => '?').join(',')
  const result = db
    .prepare(`DELETE FROM rag_messages WHERE id IN (${ph})`)
    .run(...toDelete.map(({ id }) => id))
  for (const message of toDelete) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.message,
      entityId: message.uuid,
      kind: 'delete'
    })
  }
  return result.changes
}

export function getRagMessages(conversationId: string): RagMessage[] {
  const db = getDB()
  return db
    .prepare(
      `
        SELECT id, uuid, conversation_id, role, content, context,
               origin_device_id, origin_device_name, created_at
        FROM rag_messages
        WHERE conversation_id = ?
        ORDER BY julianday(created_at) ASC, id ASC
    `
    )
    .all(conversationId) as RagMessage[]
}

// === APP SETTINGS ===

export interface AppSettings {
  memoryStrictness?: 'lenient' | 'balanced' | 'strict'
  entityStrictness?: 'lenient' | 'balanced' | 'strict'
  [key: string]: unknown
}

export function getSettings(): AppSettings {
  const db = getDB()
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as {
    key: string
    value: string
  }[]
  const settings: AppSettings = {}
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value)
    } catch {
      settings[row.key] = row.value
    }
  }
  // Set defaults if not present
  if (!settings.memoryStrictness) settings.memoryStrictness = 'balanced'
  if (!settings.entityStrictness) settings.entityStrictness = 'balanced'
  return settings
}

export function saveSetting(key: string, value: unknown): void {
  createSettingsStore(getDB()).set(key, value)
  settingsChanged()
}

export function getSetting<T>(key: string, defaultValue: T): T {
  return createSettingsStore(getDB()).get(key, defaultValue)
}

export function deleteSetting(key: string): void {
  createSettingsStore(getDB()).delete(key)
  settingsChanged()
}
