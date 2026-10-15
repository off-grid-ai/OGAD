// Record vectors: float32 BLOBs in record_vectors (the encrypted database), searched through an
// in-memory int8 index (@offgrid/rag Int8Index: per-dimension calibration, ×4 oversample, exact
// float rescore of the shortlist). The index is built on the first meaning search, a chunk at a
// time so the main thread keeps breathing, and released after a few idle minutes; the floats
// never leave SQLite except for a shortlist being rescored.
//
// The embed queue (record_queue, filled by triggers) is drained in the background: each batch
// reads the records' text, skips those whose text and model are unchanged (hash), embeds the rest
// in one call and writes them in one transaction.

import crypto from 'crypto'
import {
  calibrate,
  Int8Index,
  type RecordHit,
  type RecordVectorPort,
  type TimeWindow
} from '@offgrid/rag/records'
import { getDB } from '../database'
import { RECORD_EMBEDDER } from '../embedding-models'
import { embeddableRecords, hydrateRecords } from './sources'

/** The index is dropped after this long without a meaning search. */
const IDLE_RELEASE_MS = 5 * 60_000
/** Vectors the int8 ranges are calibrated on (the newest stored). */
const CALIBRATION_SAMPLE = 2_000
/** Rows read per slice while the index loads. */
const LOAD_CHUNK = 2_000
/** Records embedded per call; one forward pass each. Small, because a search that arrives while a
 *  batch runs waits for it. On the CPU a long record costs about 0.37 s whatever the batch size
 *  (measured 2026-10-15, 32 and 8 the same), so a small batch costs no throughput. */
const EMBED_BATCH = 4

interface Meta {
  kind: string
  ts: number
}

interface LoadedIndex {
  vectors: Int8Index
  meta: Map<string, Meta>
}

let index: LoadedIndex | null = null
let loading: Promise<LoadedIndex | null> | null = null
/** Bumped on release, so a load that finishes after it is thrown away. */
let generation = 0
/** Writes made while the index loads, applied once it has (null: removed). */
const pendingWrites = new Map<string, { meta: Meta; vector: Float32Array } | null>()
let idleTimer: ReturnType<typeof setTimeout> | null = null

function toBlob(vector: ArrayLike<number>): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

function fromBlob(blob: Buffer): Float32Array {
  // Copy: a Buffer may share a pooled ArrayBuffer at an offset that is not 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

function textHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** Drop the in-memory index (idle, or the data behind it was deleted). The next search reloads it. */
export function releaseRecordIndex(): void {
  generation++
  index = null
  loading = null
  pendingWrites.clear()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function touch(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(releaseRecordIndex, IDLE_RELEASE_MS)
  idleTimer.unref()
}

async function loadIndex(started: number): Promise<LoadedIndex | null> {
  const db = getDB()
  const model = RECORD_EMBEDDER.model
  const read = db.prepare(
    `SELECT rowid, key, kind, ts, vector FROM record_vectors
      WHERE model = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?`
  )
  const count = (
    db.prepare('SELECT COUNT(*) AS c FROM record_vectors WHERE model = ?').get(model) as {
      c: number
    }
  ).c
  let built: LoadedIndex | null = null
  let cursor = Number.MAX_SAFE_INTEGER
  for (;;) {
    if (generation !== started) return null
    const rows = read.all(model, cursor, LOAD_CHUNK) as {
      rowid: number
      key: string
      kind: string
      ts: number
      vector: Buffer
    }[]
    if (!rows.length) break
    cursor = rows[rows.length - 1]!.rowid
    const vectors = rows.map((row) => fromBlob(row.vector))
    if (!built) {
      const dimensions = vectors[0]!.length
      built = {
        vectors: new Int8Index(
          dimensions,
          calibrate(vectors.slice(0, CALIBRATION_SAMPLE), dimensions),
          Math.max(1024, count)
        ),
        meta: new Map()
      }
    }
    rows.forEach((row, i) => {
      built!.vectors.add(row.key, vectors[i]!)
      built!.meta.set(row.key, { kind: row.kind, ts: row.ts })
    })
    // Let the window and IPC run between slices.
    await new Promise((resolve) => setImmediate(resolve))
  }
  if (generation !== started || !built) return null
  for (const [key, write] of pendingWrites) {
    if (write) {
      built.vectors.add(key, write.vector)
      built.meta.set(key, write.meta)
    } else {
      built.vectors.remove(key)
      built.meta.delete(key)
    }
  }
  pendingWrites.clear()
  return built
}

async function loadedIndex(): Promise<LoadedIndex | null> {
  touch()
  if (index) return index
  if (!loading) {
    const started = generation
    loading = loadIndex(started)
      .then((loaded) => {
        if (generation === started) index = loaded
        return loaded
      })
      .finally(() => {
        if (generation === started) loading = null
      })
  }
  return loading
}

function noteWrite(key: string, meta: Meta, vector: Float32Array): void {
  if (index) {
    index.vectors.add(key, vector)
    index.meta.set(key, meta)
  } else if (loading) pendingWrites.set(key, { meta, vector })
}

function noteRemoval(key: string): void {
  if (index) {
    index.vectors.remove(key)
    index.meta.delete(key)
  } else if (loading) pendingWrites.set(key, null)
}

/** Exact float vectors for a shortlist of keys. */
function readVectors(keys: string[]): Map<string, Float32Array> {
  const rows = getDB()
    .prepare(
      `SELECT key, vector FROM record_vectors
        WHERE key IN (SELECT value FROM json_each(?)) AND model = ?`
    )
    .all(JSON.stringify(keys), RECORD_EMBEDDER.model) as { key: string; vector: Buffer }[]
  return new Map(rows.map((row) => [row.key, fromBlob(row.vector)]))
}

function inWindow(ts: number, window: TimeWindow | null | undefined): boolean {
  return !window || (ts >= window.start && ts < window.end)
}

/** The engine's meaning search over record_vectors. */
export const recordVectors: RecordVectorPort = {
  async search(query, limit, filter) {
    const loaded = await loadedIndex()
    if (!loaded) return []
    return loaded.vectors.search(query, limit, {
      accept: (key) => {
        const meta = loaded.meta.get(key)
        return (
          !!meta &&
          (!filter.kinds || filter.kinds.has(meta.kind)) &&
          inWindow(meta.ts, filter.window)
        )
      },
      rescore: readVectors,
      oversample: 4
    })
  },
  hydrate(keys) {
    const hits: RecordHit[] = hydrateRecords(keys)
    // A key with no row was deleted since the index loaded; it leaves the index too.
    if (index && hits.length < keys.length) {
      const found = new Set(hits.map((hit) => hit.key))
      const stored = new Set(
        (
          getDB()
            .prepare('SELECT key FROM record_vectors WHERE key IN (SELECT value FROM json_each(?))')
            .all(JSON.stringify(keys.filter((key) => !found.has(key)))) as { key: string }[]
        ).map((row) => row.key)
      )
      for (const key of keys) if (!found.has(key) && !stored.has(key)) noteRemoval(key)
    }
    return hits
  }
}

/** Whether any record has a vector from the current embedder (one index probe). Until one does,
 *  a meaning search has nothing to compare the question with, so the question is not embedded. */
export function hasRecordVectors(): boolean {
  if (index) return true
  return !!getDB()
    .prepare('SELECT 1 FROM record_vectors WHERE model = ? LIMIT 1')
    .get(RECORD_EMBEDDER.model)
}

/** Stored vectors (current model) and records waiting to be embedded. */
export function recordVectorStatus(): { vectors: number; pending: number } {
  const db = getDB()
  const vectors = (
    db
      .prepare('SELECT COUNT(*) AS c FROM record_vectors WHERE model = ?')
      .get(RECORD_EMBEDDER.model) as {
      c: number
    }
  ).c
  const pending = (db.prepare('SELECT COUNT(*) AS c FROM record_queue').get() as { c: number }).c
  return { vectors, pending }
}

/**
 * Embed one batch from the queue, newest first. Returns how many were embedded, how many left the
 * queue (embedded, unchanged or empty) and how many wait.
 * A record that was deleted, or edited, while it was being embedded is not written: the delete
 * trigger already removed it from the queue, and an edit is embedded again from the queue.
 */
export async function embedQueuedRecords(
  embed: (texts: string[]) => Promise<number[][]>,
  limit = EMBED_BATCH
): Promise<{ embedded: number; processed: number; remaining: number }> {
  const db = getDB()
  const model = RECORD_EMBEDDER.model
  const keys = db
    .prepare('SELECT key FROM record_queue ORDER BY rowid DESC LIMIT ?')
    .pluck()
    .all(limit) as string[]
  if (!keys.length) return { embedded: 0, processed: 0, remaining: 0 }

  const records = embeddableRecords(keys)
  const stored = new Map(
    (
      db
        .prepare(
          'SELECT key, hash, model FROM record_vectors WHERE key IN (SELECT value FROM json_each(?))'
        )
        .all(JSON.stringify(keys)) as { key: string; hash: string; model: string }[]
    ).map((row) => [row.key, row])
  )
  const unchanged: string[] = []
  const empty: string[] = []
  const work: { key: string; hash: string }[] = []
  for (const key of keys) {
    const record = records.get(key)
    if (!record?.text) {
      empty.push(key)
      continue
    }
    const hash = textHash(record.text)
    const previous = stored.get(key)
    if (previous?.hash === hash && previous.model === model) unchanged.push(key)
    else work.push({ key, hash })
  }

  const vectors = work.length
    ? await embed(work.map(({ key }) => RECORD_EMBEDDER.passagePrefix + records.get(key)!.text))
    : []

  const dequeue = db.prepare('DELETE FROM record_queue WHERE key = ?')
  const forget = db.prepare('DELETE FROM record_vectors WHERE key = ?')
  const write = db.prepare(
    `INSERT INTO record_vectors (key, kind, ref_id, ts, hash, model, vector)
     VALUES (@key, @kind, @refId, @ts, @hash, @model, @vector)
     ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, ref_id = excluded.ref_id,
       ts = excluded.ts, hash = excluded.hash, model = excluded.model, vector = excluded.vector`
  )
  const written: { key: string; meta: Meta; vector: Float32Array }[] = []
  const removed: string[] = []
  db.transaction(() => {
    for (const key of unchanged) dequeue.run(key)
    for (const key of empty) {
      dequeue.run(key)
      if (forget.run(key).changes) removed.push(key)
    }
    // Read the text again inside the transaction: only what is still there, unchanged, is written.
    const current = embeddableRecords(work.map(({ key }) => key))
    work.forEach(({ key, hash }, i) => {
      const vector = vectors[i]
      const record = current.get(key)
      if (!vector?.length || !record || textHash(record.text) !== hash) return
      if (!dequeue.run(key).changes) return
      const floats = new Float32Array(vector)
      write.run({
        key,
        kind: record.kind,
        refId: record.refId,
        ts: record.ts,
        hash,
        model,
        vector: toBlob(floats)
      })
      written.push({ key, meta: { kind: record.kind, ts: record.ts }, vector: floats })
    })
  })()
  for (const { key, meta, vector } of written) noteWrite(key, meta, vector)
  for (const key of removed) noteRemoval(key)

  const remaining = (db.prepare('SELECT COUNT(*) AS c FROM record_queue').get() as { c: number }).c
  return {
    embedded: written.length,
    processed: unchanged.length + empty.length + written.length,
    remaining
  }
}
