// LanceDB vector store (Apache-2.0, embedded/offline) — the semantic half of
// universal search. Lives in a Lance dataset under userData/lancedb, keyed by
// `${kind}:${refId}` back to the SQLite source of truth. MiniLM 384-dim vectors.
import * as lancedb from '@lancedb/lancedb'
import path from 'path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { kindsPredicate, olderThanPredicate } from './vectors-predicates'

export interface VecChunk {
  key: string // unique `${kind}:${refId}`
  kind: string // screen | meeting | memory | entity | fact
  refId: number
  vector: number[] // 384-dim, MiniLM (normalized)
  text: string // short snippet for display
  surface: string
  url: string
  ts: number // epoch ms (0 if unknown)
}

const TABLE = 'chunks'
interface VectorPointer {
  active: string
  pending?: string
  previous?: string
}
const pointerFile = (): string => path.join(app.getPath('userData'), 'vector-active-table.json')
function readPointer(): VectorPointer {
  try {
    const value = JSON.parse(fs.readFileSync(pointerFile(), 'utf8')) as VectorPointer
    return value && typeof value.active === 'string' ? value : { active: TABLE }
  } catch {
    return { active: TABLE }
  }
}
function writePointer(pointer: VectorPointer): void {
  const target = pointerFile()
  const temp = `${target}.tmp-${randomUUID()}`
  fs.writeFileSync(temp, JSON.stringify(pointer), { mode: 0o600 })
  fs.renameSync(temp, target)
}
let connPromise: Promise<lancedb.Connection> | null = null
let tablePromise: Promise<lancedb.Table | null> | null = null
let rebuildTablePromise: Promise<lancedb.Table | null> | null = null
let cachedTableName = TABLE
let cachedRebuildName = ''

function conn(): Promise<lancedb.Connection> {
  if (!connPromise) connPromise = lancedb.connect(path.join(app.getPath('userData'), 'lancedb'))
  return connPromise
}

async function loadTable(name: string): Promise<lancedb.Table | null> {
  const db = await conn()
  const names = await db.tableNames()
  return names.includes(name) ? db.openTable(name) : null
}

function table(): Promise<lancedb.Table | null> {
  const name = readPointer().active
  if (cachedTableName !== name) {
    tablePromise = null
    cachedTableName = name
  }
  if (!tablePromise) tablePromise = loadTable(name)
  return tablePromise
}

async function writeTable(): Promise<lancedb.Table | null> {
  const pending = readPointer().pending
  if (!pending) return table()
  if (cachedRebuildName !== pending) {
    rebuildTablePromise = null
    cachedRebuildName = pending
  }
  if (!rebuildTablePromise) rebuildTablePromise = loadTable(pending)
  return rebuildTablePromise
}

/** Keep the old search table readable while a replacement is built. */
export async function beginVectorRebuild(): Promise<void> {
  const pointer = readPointer()
  const db = await conn()
  if (pointer.pending && (await db.tableNames()).includes(pointer.pending))
    await db.dropTable(pointer.pending)
  const pending = `chunks_${randomUUID().replaceAll('-', '')}`
  writePointer({ active: pointer.active, pending })
  rebuildTablePromise = null
  cachedRebuildName = pending
}

/** Atomically point new search requests at the complete replacement table. */
export async function commitVectorRebuild(): Promise<void> {
  const pointer = readPointer()
  if (!pointer.pending) throw new Error('No replacement vector table is pending.')
  writePointer({ active: pointer.pending, previous: pointer.active })
  tablePromise = null
  rebuildTablePromise = null
}

export async function finishVectorRebuild(): Promise<void> {
  const pointer = readPointer()
  if (!pointer.previous) return
  const db = await conn()
  if ((await db.tableNames()).includes(pointer.previous)) await db.dropTable(pointer.previous)
  writePointer({ active: pointer.active })
}

/** Discard a failed replacement and point search back at the prior table. */
export async function abortVectorRebuild(): Promise<void> {
  const pointer = readPointer()
  const old = pointer.previous ?? pointer.active
  const replacement = pointer.pending ?? (pointer.previous ? pointer.active : null)
  writePointer({ active: old })
  const db = await conn()
  if (replacement && (await db.tableNames()).includes(replacement)) await db.dropTable(replacement)
  tablePromise = null
  rebuildTablePromise = null
}

/** Append chunks; lazily creates the table (inferring schema) on first batch. */
export async function addChunks(rows: VecChunk[]): Promise<void> {
  if (!rows.length) return
  const db = await conn()
  const data = rows as unknown as Record<string, unknown>[]
  const tbl = await writeTable()
  if (tbl) {
    await tbl.add(data)
    return
  }
  const pointer = readPointer()
  const created = await db.createTable(pointer.pending ?? pointer.active, data, {
    mode: 'create'
  })
  if (pointer.pending) rebuildTablePromise = Promise.resolve(created)
  else tablePromise = Promise.resolve(created)
}

/** k-NN over the store. Returns chunks with `_distance` (smaller = closer). */
export async function searchVectors(
  vector: number[],
  limit: number
): Promise<(VecChunk & { _distance: number })[]> {
  const tbl = await table()
  if (!tbl) return []
  return (await tbl.query().nearestTo(vector).limit(limit).toArray()) as unknown as (VecChunk & {
    _distance: number
  })[]
}

export async function vectorCount(): Promise<number> {
  const tbl = await table()
  return tbl ? tbl.countRows() : 0
}

/** Delete only the rows of the given kinds (screen | meeting | memory | entity |
 *  fact). Used by data-privacy "clear category" so wiping one category doesn't
 *  nuke the shared dataset — and operates through the live table handle so the
 *  cached connection stays valid (no stale/dangling handle). */
export async function deleteByKinds(kinds: string[]): Promise<void> {
  if (!kinds.length) return
  const tbl = await table()
  if (!tbl) return
  // Let failures propagate: the privacy path must not report success when the
  // semantic index wasn't actually cleared.
  await tbl.delete(kindsPredicate(kinds))
}

/** Like deleteByKinds, but only rows older than `cutoffMs` (epoch ms) — for
 *  age-based retention cleanup so pruned captures/meetings don't leave ghost
 *  vector hits behind. */
export async function deleteByKindsOlderThan(kinds: string[], cutoffMs: number): Promise<void> {
  if (!kinds.length) return
  const tbl = await table()
  if (!tbl) return
  await tbl.delete(olderThanPredicate(kinds, cutoffMs))
}

/** Drop the cached connection + table handles. Call after the lancedb dir is
 *  removed out-of-band (e.g. delete-all), so the next access reopens cleanly
 *  instead of using a dangling handle. */
export function resetVectors(): void {
  connPromise = null
  tablePromise = null
  rebuildTablePromise = null
  cachedTableName = TABLE
  cachedRebuildName = ''
}
