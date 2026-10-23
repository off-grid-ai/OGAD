// Full-text index over every captured frame's on-screen text. Search used to LIKE-scan all of
// frames.text (hundreds of MB) on the main thread for every query, which took seconds. The index
// is contentless (the text is not stored twice) with contentless_delete, so a frame that changes
// or goes away is simply dropped from it. New and edited frames are indexed by triggers; frames
// captured before the index existed are indexed in the background, newest first, in small batches.
//
// frame_fts keeps the tokenizer it was created with. It is the largest index by far (every word
// ever on screen), and rebuilding it for the shared tokenizer (FTS_TOKENIZE, which keeps Devanagari
// vowel signs inside words) would mean indexing everything twice on the main thread. Frame text is
// mostly Latin, and a Hindi whole word still matches the old tokenizer through the phrase query
// ftsQuery builds. A new index is created on the shared tokenizer; an existing one is rebuilt only
// once a chunked, off-main-thread rebuild exists. Text is normalised (normaliseForIndex) on the way
// in either way, so queries and indexed text agree.

import {
  enableFtsSecureDelete,
  getDB,
  markFtsIndexCurrent,
  registerFtsFunctions,
  tableExists
} from './database'
import { FTS_TOKENIZE, normaliseForIndex } from '@offgrid/rag/records'

/** The backfill runs on the main thread in short slices: an average frame carries ~6KB of OCR, and
 *  200-frame batches held the thread over half a second each, which made the whole app lag. Each
 *  slice indexes frames for at most this long, then rests, so it takes a fifth of the thread. */
const SLICE_BUDGET_MS = 20
const BACKFILL_PAUSE_MS = 80
/** Frames read per slice; a slice usually stops on its time budget first. */
const BACKFILL_BATCH = 50

type IndexDatabase = ReturnType<typeof getDB>

/** Below this frame id, frames still wait for the backfill; it works down from here. */
function startCursor(db: IndexDatabase): number {
  return (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM frames').get() as { id: number })
    .id
}

function writeState(db: IndexDatabase, cursor: number): void {
  // The cursor lives beside the index, so the index needs nothing but this database.
  db.exec(
    `CREATE TABLE IF NOT EXISTS frame_fts_state (id INTEGER PRIMARY KEY CHECK (id = 1), cursor INTEGER NOT NULL);
     INSERT OR REPLACE INTO frame_fts_state (id, cursor) VALUES (1, ${Math.floor(cursor)});`
  )
}

/** Synced mail and chat frames stay out, as search already left them out. */
const TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS frames_fts_ai AFTER INSERT ON frames
  WHEN new.text IS NOT NULL AND COALESCE(new.source, '') != 'connector' BEGIN
    INSERT INTO frame_fts(rowid, text) VALUES (new.id, offgrid_fts_text(new.text));
  END;
  CREATE TRIGGER IF NOT EXISTS frames_fts_ad AFTER DELETE ON frames BEGIN
    DELETE FROM frame_fts WHERE rowid = old.id;
  END;
  CREATE TRIGGER IF NOT EXISTS frames_fts_au AFTER UPDATE OF text, source ON frames BEGIN
    DELETE FROM frame_fts WHERE rowid = old.id;
    INSERT INTO frame_fts(rowid, text)
      SELECT new.id, offgrid_fts_text(new.text)
       WHERE new.text IS NOT NULL AND COALESCE(new.source, '') != 'connector';
  END;
`

/** Create the index and its triggers on a database that has the frames table. Idempotent. */
export function ensureFrameTextIndex(db: IndexDatabase): void {
  // The app's connection has the triggers' function already; another handle may not.
  try {
    db.prepare("SELECT offgrid_fts_text('')").get()
  } catch {
    registerFtsFunctions(db)
  }
  // An earlier build of this branch rebuilt the index beside itself; that copy goes.
  db.exec(`
    DROP TRIGGER IF EXISTS frames_fts_next_ai;
    DROP TRIGGER IF EXISTS frames_fts_next_ad;
    DROP TRIGGER IF EXISTS frames_fts_next_au;
    DROP TABLE IF EXISTS frame_fts_next;
    DROP TABLE IF EXISTS frame_fts_next_state;
  `)
  if (!tableExists(db, 'frame_fts')) {
    db.exec(
      `CREATE VIRTUAL TABLE frame_fts USING fts5(
         text, content='', contentless_delete=1, tokenize = "${FTS_TOKENIZE}"
       )`
    )
    enableFtsSecureDelete(db, 'frame_fts')
    markFtsIndexCurrent(db, 'frame_fts')
    writeState(db, startCursor(db))
  }
  // An index made before the cursor moved beside it kept it in app settings; carry it over once,
  // or start again from the top (re-indexing a frame is safe).
  if (!tableExists(db, 'frame_fts_state')) {
    let cursor: number | null = null
    try {
      const row = db
        .prepare("SELECT value FROM app_settings WHERE key = 'search:frame-fts-cursor'")
        .get() as { value: string } | undefined
      if (row) cursor = Number(JSON.parse(row.value))
    } catch {
      /* no settings table here */
    }
    writeState(db, cursor === null || !Number.isFinite(cursor) ? startCursor(db) : cursor)
  }
  // Older triggers indexed the raw text; these normalise it. Deletes are by rowid (contentless),
  // so replacing them is safe on an index of either kind.
  const insertTrigger = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'frames_fts_ai'")
    .get() as { sql: string } | undefined
  if (insertTrigger && !insertTrigger.sql.includes('offgrid_fts_text')) {
    db.exec(`
      DROP TRIGGER IF EXISTS frames_fts_ai;
      DROP TRIGGER IF EXISTS frames_fts_au;
    `)
  }
  db.exec(TRIGGERS)
}

/** The lowest frame id the backfill has reached; 0 once every older frame is indexed. */
function readCursor(): number {
  try {
    const row = getDB().prepare('SELECT cursor FROM frame_fts_state WHERE id = 1').get() as
      | { cursor: number }
      | undefined
    return row?.cursor ?? 0
  } catch {
    return 0 // no index yet
  }
}

function writeCursor(cursor: number): void {
  getDB().prepare('UPDATE frame_fts_state SET cursor = ? WHERE id = 1').run(cursor)
}

/** True while frames captured before the index still wait to be indexed. */
export function frameTextIndexBackfilling(): boolean {
  return readCursor() > 1
}

/** Index a slice of older frames, newest first: up to `batch` frames, stopping early once
 *  `budgetMs` is spent. Returns whether more remain. */
export function indexFrameTextBatch(batch = BACKFILL_BATCH, budgetMs = SLICE_BUDGET_MS): boolean {
  const cursor = readCursor()
  if (cursor <= 1) return false
  const db = getDB()
  const rows = db
    .prepare('SELECT id, text, source FROM frames WHERE id < ? ORDER BY id DESC LIMIT ?')
    .all(cursor, batch) as { id: number; text: string | null; source: string | null }[]
  if (!rows.length) {
    writeCursor(0)
    return false
  }
  const drop = db.prepare('DELETE FROM frame_fts WHERE rowid = ?')
  const add = db.prepare('INSERT INTO frame_fts(rowid, text) VALUES (?, ?)')
  const started = Date.now()
  let lowest = cursor
  db.transaction(() => {
    for (const row of rows) {
      // An edit since the index existed may already have indexed this frame.
      drop.run(row.id)
      if (row.text && row.source !== 'connector') add.run(row.id, normaliseForIndex(row.text))
      lowest = row.id
      if (Date.now() - started >= budgetMs) break
    }
  })()
  writeCursor(lowest)
  return true
}

let running = false

/** Index older frames in the background until none are left, or until `signal` aborts (app
 *  shutdown). Safe to call more than once. */
export function startFrameTextIndexBackfill(signal?: AbortSignal): void {
  if (running || !frameTextIndexBackfilling()) return
  running = true
  const step = (): void => {
    if (signal?.aborted) {
      running = false
      return
    }
    let more = false
    try {
      more = indexFrameTextBatch()
    } catch (error) {
      console.error('[search] frame text index backfill failed:', error)
    }
    if (more) setTimeout(step, BACKFILL_PAUSE_MS)
    else running = false
  }
  setTimeout(step, BACKFILL_PAUSE_MS)
}
