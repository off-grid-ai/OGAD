// The tables behind memory search: record_vectors (one float vector per embeddable record, in the
// encrypted database), record_queue (records waiting to be embedded), the action and meeting
// full-text indexes (each with its trigram twin for no-space scripts, database.ts), and the triggers
// that keep all of them in step with their source tables.
//
// Deletion is one transaction: every source table's AFTER DELETE trigger removes the record's
// vector and queue entry inside the statement that deleted the row (Open WebUI deletes the row
// and the vector in two stores, and a failed second delete leaves an orphan).
//
// Pro creates observations, action items and meetings lazily, so each table's triggers and index
// are installed the first time it is seen. Its existing rows are queued in the background after
// start-up, a slice at a time (the cursor survives a restart); rows written after the triggers
// exist are queued by them, so nothing is missed. Nothing here reads a whole table on the request
// path: a first search only installs triggers and creates missing indexes empty.

import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import {
  clearRebuildCursor,
  ensureFtsIndex,
  getDB,
  OBSERVATION_FTS,
  queueIndexRebuild,
  rebuildCursor,
  setRebuildCursor,
  tableExists,
  type FtsIndexSpec
} from '../database'
import { RECORD_EMBEDDER } from '../embedding-models'
import { actionWhenSql } from './sources'

type Db = ReturnType<typeof getDB>

/** A table whose rows are embedded as records. */
interface EmbeddedTable {
  /** The record kind (RecordSource.kind). */
  kind: string
  /** Record keys are `${prefix}:${id}`. */
  prefix: string
  table: string
  /** The column that identifies a row ('rowid' for tables keyed by text). */
  id: string
  /** Columns whose change makes the record embed again. */
  watch: string[]
}

const EMBEDDED_TABLES: EmbeddedTable[] = [
  { kind: 'screen', prefix: 'obs', table: 'observations', id: 'id', watch: ['summary'] },
  { kind: 'action', prefix: 'act', table: 'action_items', id: 'id', watch: ['text', 'due'] },
  { kind: 'meeting', prefix: 'mtg', table: 'meetings', id: 'id', watch: ['title', 'summary'] },
  {
    kind: 'entity',
    prefix: 'ent',
    table: 'entities',
    id: 'id',
    watch: ['name', 'type', 'summary']
  },
  { kind: 'summary', prefix: 'sum', table: 'chat_summaries', id: 'rowid', watch: ['summary'] }
]

/** The retired legacy stores (memories, entity facts): their rows stay, but nothing embeds or
 *  searches them, so their queue triggers, queued keys, seeding cursors and vectors go. */
const RETIRED_TABLES = [
  { table: 'memories', prefix: 'mem', kind: 'memory' },
  { table: 'entity_facts', prefix: 'fact', kind: 'fact' }
]

function retireLegacyRecords(db: Db): void {
  db.transaction(() => {
    for (const { table, prefix, kind } of RETIRED_TABLES) {
      db.exec(`
        DROP TRIGGER IF EXISTS ${table}_record_ai;
        DROP TRIGGER IF EXISTS ${table}_record_au;
        DROP TRIGGER IF EXISTS ${table}_record_ad;
      `)
      // Range scans on the keys' primary key and the kind index.
      db.prepare('DELETE FROM record_queue WHERE key >= ? AND key < ?').run(
        `${prefix}:`,
        `${prefix};`
      )
      db.prepare('DELETE FROM record_vectors WHERE kind = ?').run(kind)
      clearRebuildCursor(db, `record_queue:${table}`)
    }
  })()
}

/** To-dos by what they say (and the words as first heard). */
const ACTION_FTS: FtsIndexSpec = {
  name: 'action_fts',
  source: 'action_items',
  rowid: 'id',
  columns: ['text', 'raw_text'],
  triggers: 'action_items_fts',
  trigram: true
}

/** Meetings by title and summary. Transcripts are documents, searched by the document engine. */
const MEETING_FTS: FtsIndexSpec = {
  name: 'meeting_fts',
  source: 'meetings',
  rowid: 'id',
  columns: ['title', 'summary'],
  triggers: 'meetings_fts',
  trigram: true
}

/** Read paths the record sources use, per table; created once the table exists. */
const READ_INDEXES: Record<string, string[]> = {
  meetings: ['CREATE INDEX IF NOT EXISTS idx_meetings_started ON meetings(started_at)'],
  action_items: [
    `CREATE INDEX IF NOT EXISTS idx_action_items_when ON action_items(${actionWhenSql()})`
  ]
}

function triggerExists(db: Db, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name)
}

/** Queue, re-queue and forget one table's records as its rows change. Its existing rows are queued
 *  in the background (queueExistingRecords). */
function installRecordTriggers(db: Db, spec: EmbeddedTable): void {
  const { table, prefix, id, watch } = spec
  const key = (row: 'new' | 'old'): string => `'${prefix}:' || ${row}.${id}`
  db.transaction(() => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_record_ai AFTER INSERT ON ${table} BEGIN
        INSERT OR IGNORE INTO record_queue (key) VALUES (${key('new')});
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_record_au AFTER UPDATE OF ${watch.join(', ')} ON ${table} BEGIN
        INSERT OR IGNORE INTO record_queue (key) VALUES (${key('new')});
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_record_ad AFTER DELETE ON ${table} BEGIN
        DELETE FROM record_vectors WHERE key = ${key('old')};
        DELETE FROM record_queue WHERE key = ${key('old')};
      END;
    `)
    setRebuildCursor(db, seedName(spec), 0)
  })()
}

const seedName = (spec: EmbeddedTable): string => `record_queue:${spec.table}`

/** One background slice queueing a table's rows that have no vector, oldest first (so the newest
 *  get the highest queue positions and embed first). Returns whether more remain. */
function queueExistingRecords(spec: EmbeddedTable): () => boolean {
  const { table, prefix, id } = spec
  const name = seedName(spec)
  return () => {
    const db = getDB()
    const cursor = rebuildCursor(db, name)
    if (cursor === null) return false
    if (!tableExists(db, table)) {
      clearRebuildCursor(db, name)
      return false
    }
    const upper = (
      db
        .prepare(
          `SELECT MAX(r) AS r FROM (SELECT ${id} AS r FROM ${table} WHERE ${id} > ? ORDER BY ${id} LIMIT 2000)`
        )
        .get(cursor) as { r: number | null }
    ).r
    if (upper === null) {
      clearRebuildCursor(db, name)
      return false
    }
    db.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO record_queue (key)
         SELECT '${prefix}:' || t.${id} FROM ${table} t
          WHERE t.${id} > ? AND t.${id} <= ?
            AND NOT EXISTS (SELECT 1 FROM record_vectors v WHERE v.key = '${prefix}:' || t.${id})
          ORDER BY t.${id}`
      ).run(cursor, upper)
      setRebuildCursor(db, name, upper)
    })()
    return true
  }
}

/** The LanceDB index this replaces held a plaintext copy of captured text beside the encrypted
 *  database. It and its receipts table go once the vectors live in SQLCipher. */
function removeLegacyVectorStore(db: Db): void {
  db.exec('DROP TABLE IF EXISTS vec_indexed')
  try {
    const dir = path.join(app.getPath('userData'), 'lancedb')
    void fs.promises.rm(dir, { recursive: true, force: true }).catch((error) => {
      console.warn('[records] could not remove the legacy vector store', error)
    })
  } catch {
    /* no Electron app paths (tests) */
  }
}

const ready = new WeakMap<object, Set<string>>()

/**
 * Create the record tables, and the triggers and indexes of every source table that exists.
 * Cheap after the first call: a table is checked again only until it has been seen.
 */
export function ensureRecordSchema(): void {
  const db = getDB()
  let done = ready.get(db)
  if (!done) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS record_vectors (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT 0,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        vector BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_record_vectors_kind_ts ON record_vectors(kind, ts);
      CREATE INDEX IF NOT EXISTS idx_record_vectors_model ON record_vectors(model);
      -- Records to embed: new, edited, or embedded by another model. Newest rowid embeds first.
      CREATE TABLE IF NOT EXISTS record_queue (key TEXT PRIMARY KEY);
    `)
    // A different embedder makes every stored vector stale. They stay (search ignores them, by
    // model) until each record is embedded again.
    db.prepare(
      'INSERT OR IGNORE INTO record_queue (key) SELECT key FROM record_vectors WHERE model != ?'
    ).run(RECORD_EMBEDDER.model)
    removeLegacyVectorStore(db)
    retireLegacyRecords(db)
    done = new Set()
    ready.set(db, done)
  }
  for (const spec of EMBEDDED_TABLES) {
    if (done.has(spec.table) || !tableExists(db, spec.table)) continue
    if (!triggerExists(db, `${spec.table}_record_ad`)) installRecordTriggers(db, spec)
    // Queueing the rows that predate the triggers (resumed after a restart) runs in the background.
    if (rebuildCursor(db, seedName(spec)) !== null)
      queueIndexRebuild(seedName(spec), queueExistingRecords(spec))
    for (const sql of READ_INDEXES[spec.table] ?? []) db.exec(sql)
    done.add(spec.table)
  }
  // An observation's search text includes its frames' words, so linking a frame embeds it again,
  // and unlinking or deleting one (a privacy delete) drops the vector made from its words and
  // embeds the moment again from what is left.
  if (
    !done.has('observation_frames') &&
    tableExists(db, 'observation_frames') &&
    tableExists(db, 'observations')
  ) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS observation_frames_record_ai AFTER INSERT ON observation_frames BEGIN
        INSERT OR IGNORE INTO record_queue (key) VALUES ('obs:' || new.observation_id);
      END;
      CREATE TRIGGER IF NOT EXISTS observation_frames_record_ad AFTER DELETE ON observation_frames
      WHEN EXISTS (SELECT 1 FROM observations WHERE id = old.observation_id) BEGIN
        DELETE FROM record_vectors WHERE key = 'obs:' || old.observation_id;
        INSERT OR IGNORE INTO record_queue (key) VALUES ('obs:' || old.observation_id);
      END;
    `)
    done.add('observation_frames')
  }
  if (
    !done.has('frames') &&
    tableExists(db, 'frames') &&
    tableExists(db, 'observation_frames') &&
    tableExists(db, 'observations')
  ) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS frames_record_ad AFTER DELETE ON frames BEGIN
        DELETE FROM record_vectors WHERE key IN (
          SELECT 'obs:' || observation_id FROM observation_frames WHERE frame_id = old.id);
        INSERT OR IGNORE INTO record_queue (key)
          SELECT 'obs:' || of.observation_id FROM observation_frames of
           WHERE of.frame_id = old.id
             AND EXISTS (SELECT 1 FROM observations o WHERE o.id = of.observation_id);
      END;
    `)
    done.add('frames')
  }
  // Created empty when missing; one built by an older schema keeps serving and is rebuilt in the
  // background after start-up.
  for (const spec of [OBSERVATION_FTS, ACTION_FTS, MEETING_FTS]) {
    if (done.has(spec.name) || !tableExists(db, spec.source)) continue
    ensureFtsIndex(db, spec)
    done.add(spec.name)
  }
}
