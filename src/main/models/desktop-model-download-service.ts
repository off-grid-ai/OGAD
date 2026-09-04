import fs from 'fs'
import path from 'path'
import {
  DOWNLOAD_INTERRUPTED_ERROR,
  aggregateDownloadProgress,
  isActiveDownloadStatus,
  type ModelDownloadCoordinator,
  type ModelEntry,
  type ModelArtifactManifest,
  type ModelModality,
  type PersistedModelDownload
} from '@offgrid/models'
import { platformFetch } from '@offgrid/models/fetch'
import { recordDownloaded } from '../downloaded-models'
import { writeDiagnosticLog } from '../diagnostics-log'
import { createNodeModelDownloadPorts } from './node-artifact-download-adapter'
import { modelDownloadCoordinator } from '../composition/model-downloads'
import { DownloadRecoveryStore, type DownloadRecoveryHealth } from './download-recovery-store'

export interface DownloadProgress {
  modelId: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  currentFile?: string
  fileIndex?: number
  fileCount?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  error?: string
}

export type ProgressCb = (progress: DownloadProgress) => void

interface DesktopModelDownloadServiceOptions {
  modelsDir: () => string
  onArtifactsFinalized: () => Promise<unknown>
}

function manifestForDesktopDownload(
  entry: ModelEntry,
  catalogEntry: boolean
): ModelArtifactManifest {
  return {
    id: entry.id,
    modelId: entry.id,
    kind: entry.kind as ModelModality,
    revision: 'main',
    artifacts: entry.files.map((file) => ({
      name: file.name,
      id: `${entry.id}:${file.name}`,
      url: file.url,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      role:
        file.role === 'primary' ||
        file.role === 'mmproj' ||
        file.role === 'tokenizer' ||
        file.role === 'aux'
          ? file.role
          : undefined,
      localName: file.name,
      required: true
    })),
    metadata: { catalogEntry, name: entry.name }
  }
}

function projectDownload(record: PersistedModelDownload): DownloadProgress {
  const aggregate = aggregateDownloadProgress(record.artifacts)
  const currentIndex = record.artifacts.findIndex((artifact) => artifact.phase === 'downloading')
  const current = currentIndex >= 0 ? record.artifacts[currentIndex] : undefined
  const status: DownloadProgress['status'] =
    record.phase === 'completed' ||
    record.phase === 'failed' ||
    record.phase === 'cancelled' ||
    record.phase === 'queued'
      ? record.phase
      : record.phase === 'interrupted'
        ? 'failed'
        : 'downloading'
  const error = record.artifacts.find((artifact) => artifact.error)?.error
  return {
    modelId: record.manifest.modelId,
    status,
    percent: Math.round(aggregate.fraction * 100),
    currentFile: current
      ? record.manifest.artifacts.find((artifact) => artifact.id === current.artifactId)?.localName
      : undefined,
    fileIndex: current ? currentIndex + 1 : undefined,
    fileCount: record.artifacts.length,
    downloadedMB: (aggregate.bytesDownloaded / 1048576).toFixed(1),
    totalMB: aggregate.totalBytes ? (aggregate.totalBytes / 1048576).toFixed(1) : '?',
    downloadedBytes: aggregate.bytesDownloaded,
    totalBytes: aggregate.totalBytes || undefined,
    error: record.phase === 'interrupted' ? DOWNLOAD_INTERRUPTED_ERROR : error
  }
}

export class DesktopModelDownloadService {
  private readonly coordinator: ModelDownloadCoordinator
  private readonly recovery: DownloadRecoveryStore
  private readonly ready: Promise<PersistedModelDownload[]>

  constructor(private readonly options: DesktopModelDownloadServiceOptions) {
    this.recovery = new DownloadRecoveryStore(this.downloadsFile(), (event, error) =>
      writeDiagnosticLog('models.download-recovery', event, { error }, 'error')
    )
    this.coordinator = modelDownloadCoordinator({
      persistence: {
        read: () => this.readPersistedDownloads(),
        write: (records) => this.writePersistedDownloads(records)
      },
      ...createNodeModelDownloadPorts(this.options.modelsDir(), (destination) => {
        const localName = path.basename(destination)
        return this.coordinator
          .list()
          .flatMap((record) => record.manifest.artifacts)
          .find((artifact) => artifact.localName === localName)?.sha256
      }),
      finalizer: { finalize: (record) => this.finalize(record) }
    })
    this.ready = this.coordinator.hydrate()
  }

  status(modelId: string): DownloadProgress | null {
    const record = this.coordinator.get(modelId)
    return record ? projectDownload(record) : null
  }

  list(): DownloadProgress[] {
    return this.coordinator.list().map(projectDownload)
  }

  async recoveryHealth(): Promise<DownloadRecoveryHealth> {
    await this.ready
    return this.recovery.snapshot()
  }

  cancel(modelId: string): boolean {
    const record = this.coordinator.get(modelId)
    const cancelled = Boolean(record && isActiveDownloadStatus(record.phase))
    if (cancelled) void this.coordinator.cancel(modelId)
    writeDiagnosticLog('models.download', 'cancel.requested', { modelId, cancelled })
    return cancelled
  }

  shutdown(): Promise<void> {
    return this.coordinator.shutdown()
  }

  async download(
    modelId: string,
    onProgress?: ProgressCb
  ): Promise<{ success: boolean; error?: string }> {
    await this.ready
    const active = this.coordinator.get(modelId)
    if (active && isActiveDownloadStatus(active.phase)) {
      return this.waitForActive(modelId, onProgress)
    }
    if (active?.phase === 'completed') {
      const unsubscribe = this.coordinator.subscribe(() => {
        const current = this.coordinator.get(modelId)
        if (current) onProgress?.(projectDownload(current))
      })
      try {
        return await this.coordinator.repair(modelId)
      } finally {
        unsubscribe()
      }
    }
    if (
      active?.phase === 'failed' ||
      active?.phase === 'interrupted' ||
      active?.phase === 'cancelled'
    ) {
      return this.retry(modelId, onProgress)
    }
    const resolved = await this.resolve(modelId)
    if (!resolved) return { success: false, error: 'unknown model' }
    if (resolved.entry.availability === 'coming_soon') {
      return {
        success: false,
        error: resolved.entry.availabilityNote ?? 'This model is coming soon.'
      }
    }
    if (resolved.entry.artifactDelivery === 'runtime') {
      return { success: false, error: 'This model is installed and updated by its native runtime.' }
    }
    const manifest = manifestForDesktopDownload(resolved.entry, resolved.catalogEntry)
    if (manifest.artifacts.some((artifact) => !artifact.url)) {
      return { success: false, error: 'model artifact has no download URL' }
    }
    fs.mkdirSync(this.options.modelsDir(), { recursive: true })
    writeDiagnosticLog('models.download', 'request.accepted', {
      modelId,
      kind: resolved.entry.kind,
      files: resolved.entry.files.length
    })
    const handle = this.coordinator.enqueueWithHandle(manifest)
    const unsubscribe = handle.subscribe(() => {
      const record = this.coordinator.get(modelId)
      if (record) onProgress?.(projectDownload(record))
    })
    try {
      const result = await handle.completion
      const record = this.coordinator.get(modelId)
      if (record) onProgress?.(projectDownload(record))
      return result
    } finally {
      unsubscribe()
    }
  }

  private waitForActive(
    modelId: string,
    onProgress?: ProgressCb
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false
      let unsubscribe = (): void => undefined
      const inspect = (): void => {
        if (settled) return
        const record = this.coordinator.get(modelId)
        if (!record) {
          settled = true
          unsubscribe()
          resolve({ success: false, error: 'download state is unavailable' })
          return
        }
        onProgress?.(projectDownload(record))
        if (isActiveDownloadStatus(record.phase)) return
        settled = true
        unsubscribe()
        if (record.phase === 'completed') {
          resolve({ success: true })
          return
        }
        const error = record.artifacts.find((artifact) => artifact.error)?.error
        resolve({
          success: false,
          error:
            record.phase === 'interrupted' ? DOWNLOAD_INTERRUPTED_ERROR : (error ?? record.phase)
        })
      }
      unsubscribe = this.coordinator.subscribe(inspect)
      inspect()
    })
  }

  async retry(
    modelId: string,
    onProgress?: ProgressCb
  ): Promise<{ success: boolean; error?: string }> {
    await this.ready
    if (!this.coordinator.get(modelId)) return this.download(modelId, onProgress)
    const unsubscribe = this.coordinator.subscribe(() => {
      const current = this.coordinator.get(modelId)
      if (current) onProgress?.(projectDownload(current))
    })
    try {
      return await this.coordinator.retry(modelId)
    } finally {
      unsubscribe()
    }
  }

  async clear(modelId: string): Promise<{ success: boolean; freedBytes: number }> {
    await this.ready
    const record = this.coordinator.get(modelId)
    if (!record) return { success: true, freedBytes: 0 }
    let freedBytes = 0
    for (const artifact of record.manifest.artifacts) {
      const partialPath = path.join(this.options.modelsDir(), `${artifact.localName}.part`)
      try {
        freedBytes += fs.statSync(partialPath).size
      } catch {
        // The partial is absent.
      }
      fs.rmSync(partialPath, { force: true })
    }
    await this.coordinator.cancel(modelId)
    await this.coordinator.remove(modelId)
    return { success: true, freedBytes }
  }

  async clearInactive(): Promise<{ success: boolean; count: number; freedBytes: number }> {
    await this.ready
    const inactive = this.coordinator
      .list()
      .filter(
        (record) =>
          record.phase === 'failed' ||
          record.phase === 'cancelled' ||
          record.phase === 'interrupted'
      )
    let freedBytes = 0
    for (const record of inactive) {
      freedBytes += (await this.clear(record.manifest.id)).freedBytes
    }
    return { success: true, count: inactive.length, freedBytes }
  }

  private downloadsFile(): string {
    return path.join(this.options.modelsDir(), 'downloads.json')
  }

  private async readPersistedDownloads(): Promise<PersistedModelDownload[]> {
    return this.recovery.read()
  }

  private async writePersistedDownloads(records: readonly PersistedModelDownload[]): Promise<void> {
    this.recovery.write(records.filter((record) => record.phase !== 'completed'))
  }

  private async resolve(
    modelId: string
  ): Promise<{ entry: ModelEntry; catalogEntry: boolean } | null> {
    const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
    const inCatalog = CATALOG.find((model) => model.id === modelId)
    const entry =
      inCatalog ?? (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
    return entry
      ? { entry, catalogEntry: Boolean(inCatalog) }
      : null
  }

  private async finalize(record: PersistedModelDownload): Promise<void> {
    const metadata = record.manifest.metadata
    if (metadata?.catalogEntry !== true) {
      recordDownloaded(this.options.modelsDir(), {
        id: record.manifest.modelId,
        name: typeof metadata?.name === 'string' ? metadata.name : record.manifest.modelId,
        kind: record.manifest.kind,
        files: record.manifest.artifacts.map((artifact) => artifact.localName)
      })
    }
    await this.options.onArtifactsFinalized()
  }
}

export { DOWNLOAD_INTERRUPTED_ERROR }
