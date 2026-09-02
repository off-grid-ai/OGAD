import fs from 'node:fs'
import path from 'node:path'
import {
  CATALOG,
  createModelArtifactManifest,
  decodeDownloadLifecyclePhase,
  type DownloadLifecyclePhase,
  type ModelEntry,
  type PersistedModelDownload
} from '@offgrid/models'

export interface DownloadRecoveryHealth {
  status: 'healthy' | 'degraded'
  error?: string
}

export interface DownloadRecoveryFilePort {
  readFileSync(file: string, encoding: BufferEncoding): string
  mkdirSync(dir: string, options: { recursive: true }): unknown
  writeFileSync(file: string, data: string, options: { encoding: 'utf8'; mode: number }): void
  renameSync(from: string, to: string): void
  rmSync(file: string, options: { force: true }): void
}

const nodeFiles: DownloadRecoveryFilePort = fs

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isPersistedDownload(value: unknown): value is PersistedModelDownload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedModelDownload>
  const manifest = candidate.manifest
  if (!manifest || typeof manifest !== 'object') return false
  return (
    typeof manifest.id === 'string' &&
    typeof manifest.modelId === 'string' &&
    Array.isArray(manifest.artifacts) &&
    typeof candidate.phase === 'string' &&
    Array.isArray(candidate.artifacts) &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    typeof candidate.attempt === 'number'
  )
}

interface LegacyDownloadProgress {
  modelId: string
  status: string
  currentFile?: string
  fileIndex?: number
  downloadedBytes?: number
  error?: string
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isLegacyDownloadProgress(value: unknown): value is LegacyDownloadProgress {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.modelId === 'string' &&
    decodeDownloadLifecyclePhase(candidate.status) !== null &&
    (candidate.currentFile === undefined || typeof candidate.currentFile === 'string') &&
    optionalFiniteNumber(candidate.fileIndex) &&
    optionalFiniteNumber(candidate.downloadedBytes) &&
    (candidate.error === undefined || typeof candidate.error === 'string')
  )
}

function legacyPhase(record: LegacyDownloadProgress): DownloadLifecyclePhase {
  if (record.error?.toLowerCase().includes('interrupted')) return 'interrupted'
  return decodeDownloadLifecyclePhase(record.status) ?? 'failed'
}

function legacyCatalogEntry(record: LegacyDownloadProgress): ModelEntry | undefined {
  const direct = CATALOG.find((entry) => entry.id === record.modelId)
  if (direct) return direct
  if (!record.currentFile) return undefined
  const matches = CATALOG.filter((entry) =>
    entry.files.some((file) => file.name === record.currentFile)
  )
  return matches.length === 1 ? matches[0] : undefined
}

function migrateLegacyDownload(
  record: LegacyDownloadProgress,
  timestamp: number
): PersistedModelDownload {
  const entry = legacyCatalogEntry(record)
  if (!entry) {
    throw new Error(
      `legacy model ${record.modelId} is no longer identifiable; keep the file and retry or clear this item from Storage`
    )
  }
  const manifest = createModelArtifactManifest(entry)
  const indexedCurrent = Math.max(0, Math.trunc(record.fileIndex ?? 1) - 1)
  const namedCurrent = record.currentFile
    ? manifest.artifacts.findIndex((artifact) => artifact.localName === record.currentFile)
    : -1
  const currentIndex =
    namedCurrent >= 0 ? namedCurrent : Math.min(indexedCurrent, manifest.artifacts.length - 1)
  const completedBefore = manifest.artifacts
    .slice(0, currentIndex)
    .reduce((sum, artifact) => sum + (artifact.sizeBytes ?? 0), 0)
  const currentBytes = Math.max(0, (record.downloadedBytes ?? 0) - completedBefore)
  const phase = legacyPhase(record)

  return {
    manifest,
    phase,
    artifacts: manifest.artifacts.map((artifact, index) => {
      const totalBytes = artifact.sizeBytes ?? 0
      if (index < currentIndex) {
        return {
          artifactId: artifact.id,
          phase: 'completed',
          bytesDownloaded: totalBytes,
          totalBytes
        }
      }
      if (index === currentIndex) {
        return {
          artifactId: artifact.id,
          phase,
          bytesDownloaded: Math.min(currentBytes, totalBytes || currentBytes),
          totalBytes,
          error: record.error
        }
      }
      return {
        artifactId: artifact.id,
        phase: 'queued',
        bytesDownloaded: 0,
        totalBytes
      }
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
    attempt: 0
  }
}

function decodeRecoveryData(value: unknown): PersistedModelDownload[] {
  if (!Array.isArray(value)) throw new Error('recovery root must be an array')
  if (value.every(isPersistedDownload)) return value
  if (value.every(isLegacyDownloadProgress)) {
    const timestamp = Date.now()
    return value.map((record) => migrateLegacyDownload(record, timestamp))
  }
  throw new Error('recovery records are neither canonical nor a supported legacy shape')
}

/** Atomic Desktop persistence adapter for Shared's download coordinator. */
export class DownloadRecoveryStore {
  private health: DownloadRecoveryHealth = { status: 'healthy' }
  private readFailed = false
  private writeSequence = 0

  constructor(
    private readonly file: string,
    private readonly report: (event: 'read.failed' | 'write.failed', error: string) => void,
    private readonly files: DownloadRecoveryFilePort = nodeFiles
  ) {}

  read(): PersistedModelDownload[] {
    let source: string
    try {
      source = this.files.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (isMissing(error)) {
        this.readFailed = false
        this.health = { status: 'healthy' }
        return []
      }
      return this.failRead('Download recovery data could not be read.', error)
    }

    try {
      const parsed: unknown = JSON.parse(source)
      const records = decodeRecoveryData(parsed)
      this.health = { status: 'healthy' }
      this.readFailed = false
      return records
    } catch (error) {
      return this.failRead(
        `Download recovery data could not be migrated. The original file was kept at ${this.file}. Move it aside to start with empty recovery data.`,
        error
      )
    }
  }

  write(records: readonly PersistedModelDownload[]): void {
    if (this.readFailed) return
    const temporary = `${this.file}.tmp-${process.pid}-${++this.writeSequence}`
    try {
      this.files.mkdirSync(path.dirname(this.file), { recursive: true })
      this.files.writeFileSync(temporary, JSON.stringify(records), {
        encoding: 'utf8',
        mode: 0o600
      })
      this.files.renameSync(temporary, this.file)
      this.health = { status: 'healthy' }
    } catch (error) {
      try {
        this.files.rmSync(temporary, { force: true })
      } catch {
        // The existing recovery file remains authoritative.
      }
      const message = 'Download recovery data could not be saved.'
      this.health = { status: 'degraded', error: message }
      this.report('write.failed', error instanceof Error ? error.message : String(error))
      // A live download remains valid. The health projection reports restart risk.
    }
  }

  snapshot(): DownloadRecoveryHealth {
    return { ...this.health }
  }

  private failRead(message: string, cause: unknown): [] {
    this.readFailed = true
    this.health = { status: 'degraded', error: message }
    this.report('read.failed', cause instanceof Error ? cause.message : String(cause))
    return []
  }
}
