// Changing the search embedding model. Every stored record is embedded again with the chosen model
// beside the live vectors (records/store.ts staging), and the new vectors replace the old ones in
// one transaction. Until then search keeps using the old model; a cancel, a failure or an
// interrupted launch drops the staged vectors and restores the previous choice.

import fs from 'node:fs'
import path from 'node:path'
import { embeddings } from './embeddings'
import { embedderSpec } from './embedding-models'
import {
  getEmbeddingDimensions,
  getEmbeddingModelId,
  getIndexedEmbeddingModelId,
  saveEmbeddingModelId,
  saveIndexedEmbeddingModelId
} from './embedding-model-choice'
import { dataDir } from './runtime-env'
import { ensureRecordSchema } from './records/schema'
import {
  commitStagedRecordVectors,
  dropStagedRecordVectors,
  hasStagedRecordVectors,
  stageRecordVectors,
  stagedRecordTotal
} from './records/store'
import { setEmbeddingIndexRebuilding } from './embedding-rebuild-state'
import type { EmbeddingRebuildStatus } from '../shared/embedding-rebuild-contract'

const previousFile = (): string => path.join(dataDir(), 'embedding-rebuild-previous.json')

interface PreviousChoice {
  id: string
  dimensions: number
}
let status: EmbeddingRebuildStatus = { phase: 'idle', model: '', done: 0, total: 0 }
let listener: ((status: EmbeddingRebuildStatus) => void) | null = null
let rebuild: Promise<void> | null = null
let cancelRequested = false
/** Read through a call: cancellation arrives from another task while this one awaits. */
const isCancelRequested = (): boolean => cancelRequested

/** Approximate work shown before a person confirms a model switch. */
export function estimateEmbeddingRebuildItems(): number {
  ensureRecordSchema()
  return stagedRecordTotal()
}

/** Cancel at the next batch boundary and restore the previous choice. */
export async function cancelEmbeddingIndexRebuild(): Promise<boolean> {
  if (rebuild === null || !['preparing', 'rebuilding'].includes(status.phase)) return false
  cancelRequested = true
  await rebuild
  return status.phase === 'restored'
}

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

function readPrevious(): PreviousChoice | null {
  try {
    const value = JSON.parse(fs.readFileSync(previousFile(), 'utf8')) as PreviousChoice | null
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
    JSON.stringify({ id: getEmbeddingModelId(), dimensions: getEmbeddingDimensions() }),
    { mode: 0o600 }
  )
  setEmbeddingIndexRebuilding(true)
}

export function cancelPendingEmbeddingChoice(): void {
  fs.rmSync(previousFile(), { force: true })
  setEmbeddingIndexRebuilding(false)
}

/** Drop the staged vectors and select the previous model again. The live index never changed. */
function rollback(): void {
  dropStagedRecordVectors()
  const previous = readPrevious()
  if (previous) saveEmbeddingModelId(previous.id, previous.dimensions)
  fs.rmSync(previousFile(), { force: true })
  setEmbeddingIndexRebuilding(false)
}

/** Embed every record with the chosen model, then make those vectors the live index. */
async function rebuildIndex(): Promise<void> {
  const chosen = embedderSpec(getEmbeddingModelId())
  setEmbeddingIndexRebuilding(true)
  ensureRecordSchema()
  publish({ phase: 'rebuilding', model: chosen.model, done: 0, total: stagedRecordTotal() })
  await stageRecordVectors(
    chosen,
    (texts) => embeddings.embed(texts, { model: chosen.model, source: 'Memory index rebuild' }),
    (done, total) => publish({ phase: 'rebuilding', model: chosen.model, done, total }),
    isCancelRequested
  )
  if (isCancelRequested()) throw new Error('Embedding index rebuild canceled.')
  commitStagedRecordVectors(chosen.model)
  saveIndexedEmbeddingModelId(chosen.model)
  fs.rmSync(previousFile(), { force: true })
  setEmbeddingIndexRebuilding(false)
  publish({ phase: 'done', model: chosen.model, done: status.total, total: status.total })
}

export function startEmbeddingIndexRebuild(): Promise<void> {
  if (rebuild !== null) return rebuild
  cancelRequested = false
  publish({ phase: 'preparing', model: getEmbeddingModelId(), done: 0, total: 0 })
  rebuild = Promise.resolve().then(async () => {
    try {
      ensureRecordSchema()
      // A launch after an interrupted change restores the previous model; the person chooses again.
      if (readPrevious() && hasStagedRecordVectors()) {
        rollback()
        publish({ phase: 'restored', model: getEmbeddingModelId(), done: 0, total: 0 })
        return
      }
      if (getEmbeddingModelId() === getIndexedEmbeddingModelId()) {
        fs.rmSync(previousFile(), { force: true })
        setEmbeddingIndexRebuilding(false)
        publish({ phase: 'done', model: getEmbeddingModelId(), done: 0, total: 0 })
        return
      }
      await rebuildIndex()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        rollback()
      } catch (rollbackError) {
        console.error('[embeddings] rollback failed', rollbackError)
        const restoreMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        publish({
          phase: 'error',
          model: getEmbeddingModelId(),
          done: status.done,
          total: status.total,
          error: `Could not restore the previous model: ${restoreMessage}`
        })
        throw rollbackError
      }
      if (isCancelRequested()) {
        publish({ phase: 'restored', model: getEmbeddingModelId(), done: 0, total: 0 })
        return
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
