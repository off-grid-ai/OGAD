import fs from 'node:fs'
import path from 'node:path'
import { getDB } from './database'
import { embeddings } from './embeddings'
import {
  DEFAULT_EMBEDDING_MODEL,
  getEmbeddingDimensions,
  getEmbeddingModelId
} from './embedding-model-choice'
import { dataDir } from './runtime-env'
import { ensureRagStoreSchema } from './rag/store'
import {
  abortVectorRebuild,
  beginVectorRebuild,
  commitVectorRebuild,
  finishVectorRebuild
} from './vectors'
import { runBackfill } from './search'
import { setEmbeddingIndexRebuilding } from './embedding-rebuild-state'
import type { EmbeddingRebuildStatus } from '../shared/embedding-rebuild-contract'

const markerFile = (): string => path.join(dataDir(), 'embedding-index-model.json')
const previousFile = (): string => path.join(dataDir(), 'embedding-rebuild-previous.json')
const BACKUP_TABLES = [
  'embedding_backup_memories',
  'embedding_backup_chunks',
  'embedding_backup_indexed'
] as const

interface PreviousChoice {
  id: string
  dimensions: number
}
let status: EmbeddingRebuildStatus = { phase: 'idle', model: '', done: 0, total: 0 }
let listener: ((status: EmbeddingRebuildStatus) => void) | null = null
let rebuild: Promise<void> | null = null

export function getEmbeddingRebuildStatus(): EmbeddingRebuildStatus {
  return status
}
export function onEmbeddingRebuildStatus(callback: (value: EmbeddingRebuildStatus) => void): void {
  listener = callback
}
function publish(next: EmbeddingRebuildStatus): void {
  status = next
  listener?.(next)
}

function indexedModel(): string {
  try {
    return JSON.parse(fs.readFileSync(markerFile(), 'utf8')) as string
  } catch {
    return DEFAULT_EMBEDDING_MODEL
  }
}

function readPrevious(): PreviousChoice | null {
  try {
    const value = JSON.parse(fs.readFileSync(previousFile(), 'utf8')) as PreviousChoice
    return value && typeof value.id === 'string' && Number.isInteger(value.dimensions)
      ? value
      : null
  } catch {
    return null
  }
}

/** Record the working choice before the new model is selected. */
export function savePreviousEmbeddingChoice(): void {
  fs.writeFileSync(
    previousFile(),
    JSON.stringify({
      id: getEmbeddingModelId(),
      dimensions: getEmbeddingDimensions()
    }),
    { mode: 0o600 }
  )
  setEmbeddingIndexRebuilding(true)
}

export function cancelPendingEmbeddingChoice(): void {
  fs.rmSync(previousFile(), { force: true })
  setEmbeddingIndexRebuilding(false)
}

function hasBackups(): boolean {
  const row = getDB()
    .prepare("SELECT name FROM sqlite_master WHERE name = 'embedding_backup_memories'")
    .get()
  return Boolean(row)
}

function dropBackups(): void {
  getDB().transaction(() => {
    for (const name of BACKUP_TABLES) getDB().exec(`DROP TABLE IF EXISTS ${name}`)
  })()
}

function restoreBackups(): void {
  if (!hasBackups()) return
  const db = getDB()
  db.transaction(() => {
    db.exec('UPDATE memories SET embedding = NULL')
    db.exec(
      'UPDATE memories SET embedding = (SELECT b.embedding FROM embedding_backup_memories b WHERE b.id = memories.id) WHERE id IN (SELECT id FROM embedding_backup_memories)'
    )
    db.exec('UPDATE rag_chunks SET embedding = NULL')
    db.exec(
      'UPDATE rag_chunks SET embedding = (SELECT b.embedding FROM embedding_backup_chunks b WHERE b.id = rag_chunks.id) WHERE id IN (SELECT id FROM embedding_backup_chunks)'
    )
    db.exec('DELETE FROM vec_indexed')
    db.exec('INSERT INTO vec_indexed (key) SELECT key FROM embedding_backup_indexed')
    for (const name of BACKUP_TABLES) db.exec(`DROP TABLE ${name}`)
  })()
}

/** Restore the old selection and indexes after a failure or interrupted launch. */
async function rollback(): Promise<void> {
  await abortVectorRebuild()
  restoreBackups()
  const previous = readPrevious()
  if (previous) {
    await embeddings.switchModel(previous.id, previous.dimensions)
    fs.writeFileSync(markerFile(), JSON.stringify(previous.id), { mode: 0o600 })
    fs.rmSync(previousFile(), { force: true })
  }
  setEmbeddingIndexRebuilding(false)
}

/** Save old SQLite vectors, then clear only the working columns. */
export async function prepareEmbeddingIndexRebuild(): Promise<boolean> {
  const selected = getEmbeddingModelId()
  const indexed = indexedModel()
  if (selected === indexed) {
    if (!fs.existsSync(markerFile())) fs.writeFileSync(markerFile(), JSON.stringify(selected))
    return false
  }
  setEmbeddingIndexRebuilding(true)
  if (!readPrevious())
    fs.writeFileSync(previousFile(), JSON.stringify({ id: indexed, dimensions: 384 }), {
      mode: 0o600
    })
  fs.writeFileSync(markerFile(), JSON.stringify('pending'), { mode: 0o600 })
  ensureRagStoreSchema()
  const db = getDB()
  db.exec('CREATE TABLE IF NOT EXISTS vec_indexed (key TEXT PRIMARY KEY)')
  db.transaction(() => {
    for (const name of BACKUP_TABLES) db.exec(`DROP TABLE IF EXISTS ${name}`)
    db.exec('CREATE TABLE embedding_backup_memories AS SELECT id, embedding FROM memories')
    db.exec('CREATE TABLE embedding_backup_chunks AS SELECT id, embedding FROM rag_chunks')
    db.exec('CREATE TABLE embedding_backup_indexed AS SELECT key FROM vec_indexed')
    db.exec('DELETE FROM vec_indexed')
    db.exec('UPDATE rag_chunks SET embedding = NULL')
    db.exec('UPDATE memories SET embedding = NULL')
  })()
  await beginVectorRebuild()
  return true
}

/** Re-embed saved text in small batches, then rebuild the universal search index. */
export async function rebuildEmbeddingIndexes(): Promise<void> {
  const db = getDB()
  const sources = [
    { table: 'memories', field: 'content' },
    { table: 'rag_chunks', field: 'content' }
  ] as const
  const count = sources.reduce(
    (sum, source) =>
      sum +
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${source.table} WHERE ${source.field} IS NOT NULL`
          )
          .get() as { count: number }
      ).count,
    0
  )
  let done = 0
  publish({ phase: 'rebuilding', model: getEmbeddingModelId(), done, total: count })
  for (const source of sources) {
    let cursor = 0
    for (;;) {
      const rows = db
        .prepare(
          `SELECT id, ${source.field} AS text FROM ${source.table} WHERE id > ? AND ${source.field} IS NOT NULL ORDER BY id LIMIT 32`
        )
        .all(cursor) as Array<{ id: number; text: string }>
      if (!rows.length) break
      for (const row of rows) {
        const vector = await embeddings.generateEmbedding(row.text)
        db.prepare(`UPDATE ${source.table} SET embedding = ? WHERE id = ?`).run(
          JSON.stringify(vector),
          row.id
        )
        done++
        publish({ phase: 'rebuilding', model: getEmbeddingModelId(), done, total: count })
      }
      cursor = rows[rows.length - 1]!.id
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  await runBackfill(({ done: indexed, remaining }) => {
    publish({
      phase: 'rebuilding',
      model: getEmbeddingModelId(),
      done: count + indexed,
      total: count + indexed + remaining
    })
  })
  await commitVectorRebuild()
  fs.writeFileSync(markerFile(), JSON.stringify(getEmbeddingModelId()), { mode: 0o600 })
  setEmbeddingIndexRebuilding(false)
  try {
    dropBackups()
    fs.rmSync(previousFile(), { force: true })
    await finishVectorRebuild()
  } catch (error) {
    // The new marker and table are committed. Cleanup can finish on next launch.
    console.warn('[embeddings] old index cleanup deferred', error)
  }
  publish({ phase: 'done', model: getEmbeddingModelId(), done: status.total, total: status.total })
}

export function startEmbeddingIndexRebuild(): Promise<void> {
  if (rebuild) return rebuild
  publish({ phase: 'preparing', model: getEmbeddingModelId(), done: 0, total: 0 })
  rebuild = Promise.resolve().then(async () => {
    try {
      // A crash after promotion but before cleanup keeps the new marker and vectors.
      if (readPrevious() && indexedModel() === getEmbeddingModelId()) {
        dropBackups()
        fs.rmSync(previousFile(), { force: true })
        await finishVectorRebuild()
      } else if (readPrevious() && hasBackups()) {
        await rollback()
        publish({
          phase: 'error',
          model: getEmbeddingModelId(),
          done: 0,
          total: 0,
          error: 'The previous embedding model was restored after an interrupted rebuild.'
        })
        return
      }
      if (await prepareEmbeddingIndexRebuild()) await rebuildEmbeddingIndexes()
      else {
        await finishVectorRebuild().catch(() => undefined)
        publish({ phase: 'done', model: getEmbeddingModelId(), done: 0, total: 0 })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await rollback()
      } catch (rollbackError) {
        console.error('[embeddings] rollback failed', rollbackError)
      }
      publish({
        phase: 'error',
        model: getEmbeddingModelId(),
        done: status.done,
        total: status.total,
        error: message
      })
      throw error
    } finally {
      rebuild = null
    }
  })
  return rebuild
}
