import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  EMBEDDING_CACHE_FILES,
  EMBEDDING_MODELS,
  getEmbeddingModelId
} from './embedding-model-choice'
import { modelsDir, requireModelStorage } from './runtime-env'

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

/** Prefetch curated ONNX files into the exact cache used by Transformers.js. */
export async function downloadEmbeddingModel(
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
