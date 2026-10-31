import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  EMBEDDING_CACHE_FILES,
  EMBEDDING_MODELS,
  getEmbeddingModelId,
  getIndexedEmbeddingModelId
} from './embedding-model-choice'
import { modelsDir, requireModelStorage } from './runtime-env'
import { modelDownloadQueue, type DownloadResult } from './models/download-queue'

export interface EmbeddingSetupFile {
  name: string
  sizeBytes: number
}
export interface EmbeddingSetupModel {
  id: string
  name: string
  files: EmbeddingSetupFile[]
  totalBytes: number
  remainingBytes: number
  installed: boolean
}
export interface EmbeddingDownloadProgress {
  downloadedBytes: number
  totalBytes: number
  currentFile: string
}

function cachedPath(id: string, file: string): string {
  return path.join(modelsDir(), '.cache', id, file)
}

function filesFor(id: string): EmbeddingSetupFile[] | null {
  const entry = EMBEDDING_MODELS.find((model) => model.id === id)
  if (!entry) return null
  return EMBEDDING_CACHE_FILES.map((name, index) => ({ name, sizeBytes: entry.files[index]! }))
}

function cached(id: string, file: EmbeddingSetupFile): boolean {
  try {
    return fs.statSync(cachedPath(id, file.name)).size === file.sizeBytes
  } catch {
    return false
  }
}

/** Null for a custom Hub choice whose download size is not in the curated catalog. */
export function getEmbeddingSetupModel(): EmbeddingSetupModel | null {
  const id = getEmbeddingModelId()
  const entry = EMBEDDING_MODELS.find((model) => model.id === id)
  const files = filesFor(id)
  if (!entry || !files) return null
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  const remainingBytes = files
    .filter((file) => !cached(id, file))
    .reduce((sum, file) => sum + file.sizeBytes, 0)
  return {
    id,
    name: entry.name,
    files,
    totalBytes,
    remainingBytes,
    installed: remainingBytes === 0
  }
}

/** Fetch the missing curated ONNX files into the exact cache used by Transformers.js. */
async function fetchEmbeddingFiles(
  id: string,
  onProgress?: (progress: EmbeddingDownloadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  requireModelStorage()
  const files = filesFor(id)
  if (!files) throw new Error('This embedding model is not in the setup catalog.')
  const missing = files.filter((file) => !cached(id, file))
  const totalBytes = missing.reduce((sum, file) => sum + file.sizeBytes, 0)
  let done = 0
  for (const file of missing) {
    if (signal?.aborted)
      throw Object.assign(new Error('Download canceled.'), { name: 'AbortError' })
    const target = cachedPath(id, file.name)
    const temp = `${target}.part-${randomUUID()}`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    try {
      const url = `https://huggingface.co/${id}/resolve/main/${file.name}`
      const response = await fetch(url, { signal })
      if (!response.ok || !response.body)
        throw new Error(`Model download failed: HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length'))
      if (length > 0 && length !== file.sizeBytes)
        throw new Error('Model file size changed. Refresh the catalog.')
      let received = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          onProgress?.({ downloadedBytes: done + received, totalBytes, currentFile: file.name })
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        counter,
        fs.createWriteStream(temp),
        { signal }
      )
      if (received !== file.sizeBytes) throw new Error('Model download was incomplete.')
      await fs.promises.rm(target, { force: true })
      await fs.promises.rename(temp, target)
      done += received
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    }
  }
}

/** A curated embedding model: the Models screen, retry and setup download it through the queue. */
export function isEmbeddingDownloadId(id: string): boolean {
  return EMBEDDING_MODELS.some((model) => model.id === id)
}

/** Progress in the shape the shared download UI reads (Storage, Models, retry). */
export interface EmbeddingQueueProgress {
  modelId: string
  modelName: string
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  percent?: number
  currentFile?: string
  downloadedBytes?: number
  totalBytes?: number
  downloadedMB?: string
  totalMB?: string
  bytesPerSecond?: number
  error?: string
}

const PROGRESS_INTERVAL_MS = 250
const mb = (bytes: number): string => (bytes / 1e6).toFixed(1)

/**
 * Download a curated embedding model through the shared model download queue, so it gets the
 * same concurrency limit, cancel (`cancelDownload(id)`) and retry as every other model.
 */
export function queueEmbeddingDownload(
  id: string,
  onProgress?: (progress: EmbeddingQueueProgress) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const entry = EMBEDDING_MODELS.find((model) => model.id === id)
  if (!entry) return Promise.resolve({ success: false, error: 'Unknown embedding model.' })
  let last: EmbeddingQueueProgress = { modelId: id, modelName: entry.name }
  const send = (update: Partial<EmbeddingQueueProgress>): void => {
    last = { ...last, ...update }
    onProgress?.(last)
  }
  const onAbort = (): void => void modelDownloadQueue.cancel(id)
  signal?.addEventListener('abort', onAbort, { once: true })
  let sentAt = 0
  let startedAt = 0
  return modelDownloadQueue
    .enqueue(
      id,
      async (queueSignal) => {
        startedAt = Date.now()
        try {
          await fetchEmbeddingFiles(
            id,
            (p) => {
              const now = Date.now()
              if (now - sentAt < PROGRESS_INTERVAL_MS && p.downloadedBytes < p.totalBytes) return
              sentAt = now
              const seconds = (now - startedAt) / 1000
              send({
                status: 'downloading',
                currentFile: p.currentFile,
                downloadedBytes: p.downloadedBytes,
                totalBytes: p.totalBytes,
                downloadedMB: mb(p.downloadedBytes),
                totalMB: mb(p.totalBytes),
                percent: p.totalBytes > 0 ? Math.round((p.downloadedBytes / p.totalBytes) * 100) : 0,
                ...(seconds > 0 ? { bytesPerSecond: p.downloadedBytes / seconds } : {})
              })
            },
            queueSignal
          )
          send({ status: 'completed', percent: 100, error: undefined })
          return { success: true }
        } catch (error) {
          if (queueSignal.aborted) {
            const interrupted = typeof queueSignal.reason === 'string'
            const reason = interrupted ? (queueSignal.reason as string) : 'cancelled'
            send(interrupted ? { status: 'failed', error: reason } : { status: 'cancelled' })
            return { success: false, error: reason }
          }
          const message = error instanceof Error ? error.message : String(error)
          send({ status: 'failed', error: message })
          return { success: false, error: message }
        }
      },
      (state) => {
        if (state === 'queued') send({ status: 'queued', error: undefined })
        else if (state === 'downloading') send({ status: 'downloading', percent: 0, error: undefined })
        else if (state === 'cancelled') send({ status: 'cancelled' })
        else send({ status: 'failed', error: 'interrupted - retry to resume' })
      }
    )
    .finally(() => signal?.removeEventListener('abort', onAbort))
}

/** Prefetch curated ONNX files. Runs in the shared download queue so the download UI shows it;
 *  `record` hands each queue update to the download registry, which the caller owns. */
export async function downloadEmbeddingModel(
  id: string,
  onProgress?: (progress: EmbeddingDownloadProgress) => void,
  signal?: AbortSignal,
  record?: (progress: EmbeddingQueueProgress) => void
): Promise<void> {
  requireModelStorage()
  if (!filesFor(id)) throw new Error('This embedding model is not in the setup catalog.')
  if (signal?.aborted) throw Object.assign(new Error('Download canceled.'), { name: 'AbortError' })
  const result = await queueEmbeddingDownload(
    id,
    (p) => {
      record?.(p)
      if (p.downloadedBytes !== undefined && p.totalBytes !== undefined)
        onProgress?.({
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
          currentFile: p.currentFile ?? ''
        })
    },
    signal
  )
  if (result.success) return
  if (result.error === 'cancelled' || signal?.aborted)
    throw Object.assign(new Error('Download canceled.'), { name: 'AbortError' })
  throw new Error(result.error ?? 'Model download failed.')
}

/** Bytes of a cached embedding model folder, or 0 when it is absent. */
function folderBytes(directory: string): number {
  let total = 0
  let names: string[] = []
  try {
    names = fs.readdirSync(directory)
  } catch {
    return 0
  }
  for (const name of names) {
    const full = path.join(directory, name)
    try {
      const stat = fs.statSync(full)
      total += stat.isDirectory() ? folderBytes(full) : stat.size
    } catch {
      /* skip */
    }
  }
  return total
}

export interface InstalledEmbeddingModel {
  id: string
  name: string
  kind: 'embedding'
  bytes: number
  active: boolean
}

/** Embedding models on disk: every complete curated model, plus the active custom one. */
export function installedEmbeddingModels(): InstalledEmbeddingModel[] {
  const active = getEmbeddingModelId()
  const installed: InstalledEmbeddingModel[] = EMBEDDING_MODELS.filter((model) =>
    (filesFor(model.id) ?? []).every((file) => cached(model.id, file))
  ).map((model) => ({
    id: model.id,
    name: model.name,
    kind: 'embedding',
    bytes: folderBytes(path.join(modelsDir(), '.cache', model.id)),
    active: model.id === active
  }))
  if (!installed.some((model) => model.id === active)) {
    const bytes = folderBytes(path.join(modelsDir(), '.cache', active))
    if (bytes > 0)
      installed.push({
        id: active,
        name: active.split('/').pop() ?? active,
        kind: 'embedding',
        bytes,
        active: true
      })
  }
  return installed
}

/** True when `id` is an embedding model on disk, so model deletion routes here. */
export function isInstalledEmbeddingModel(id: string): boolean {
  return installedEmbeddingModels().some((model) => model.id === id)
}

/** Delete an embedding model from disk. The model in use (or still indexed) is protected. */
export async function deleteEmbeddingModel(
  id: string
): Promise<{ success: boolean; error?: string; freedFiles?: number }> {
  if (id === getEmbeddingModelId() || id === getIndexedEmbeddingModelId())
    return { success: false, error: 'This search model is in use. Choose another one first.' }
  if (modelDownloadQueue.has(id)) return { success: false, error: 'This model is downloading.' }
  const root = path.join(modelsDir(), '.cache')
  const directory = path.resolve(root, id)
  if (!directory.startsWith(`${path.resolve(root)}${path.sep}`))
    return { success: false, error: 'Unknown embedding model.' }
  await fs.promises.rm(directory, { recursive: true, force: true })
  return { success: true, freedFiles: 1 }
}
