// Central model management — the single source of truth for catalog, install
// listing, download (pull), delete, and activation. Used by BOTH the desktop IPC
// handlers (UI) AND the headless gateway HTTP admin endpoints, so the full
// repertoire (pull / delete / activate / list) works with or without a UI.
import fs from 'fs'
import path from 'path'
import { llm } from './llm'
import { isValidGgufFile } from './models/gguf'
import { createNodeArtifactDownloadPorts } from './models/node-artifact-download-adapter'
import {
  DOWNLOAD_INTERRUPTED_ERROR,
  modelDownloadQueue,
  shutdownModelDownloads
} from './models/download-queue'
import {
  recordDownloaded,
  removeDownloaded,
  findDownloaded,
  installedDownloadedIds,
  downloadedProtectedNames,
  reconcileDownloadedModelRegistry,
  type DownloadedModel
} from './downloaded-models'
import { writeDiagnosticLog } from './diagnostics-log'
import { modelPackageIdentity, type TransferredModelManifest } from '@offgrid/sync'
import { sampleProgressRate, type ProgressRateSample } from '@offgrid/ui'
import {
  decodeModelRouteId,
  DownloadStatusLedger,
  modelDownloadFailureMessage,
  runSequentialArtifactDownload,
  mergeCatalog,
  installedIds,
  buildDiskEntry,
  primaryFileName,
  protectedNames,
  scanModelDir,
  isChatLoadable,
  visionStatus,
  projectorToHeal,
  isProjectorFileName,
  deletedModelSelectionModalities,
  modelSelectionRefusal,
  runtimeModalityForModelKind,
  specialistReclassificationModality,
  transferredProjectorRepair,
  type CatalogEntry,
  type ModelModality,
  type Modality,
  type VisionStatus,
  type DownloadLedgerStorage
} from '@offgrid/models'
import {
  parseRemoteVisionModelId,
  remoteVisionInventoryModels
} from '../shared/remote-vision-server'
import { getRemoteVisionServerSettings } from './vision/remote-vision-server'
import { desktopModelServices } from './model-services'
import { desktopModelSelectionPersistence } from './model-selection-persistence'
import { platformFetch } from '@offgrid/models/fetch'

export interface DownloadProgress {
  modelId: string
  percent?: number
  status?: 'queued' | 'downloading' | 'completed' | 'failed' | 'cancelled'
  currentFile?: string
  /** Which file of the job is in flight, 1-based, and how many the job has. percent/downloadedMB
   *  measure the WHOLE job, so these exist to say what the named file is a part of. */
  fileIndex?: number
  fileCount?: number
  downloadedMB?: string
  totalMB?: string
  downloadedBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
  error?: string
}
export type ProgressCb = (p: DownloadProgress) => void

const downloadQueue = modelDownloadQueue

function downloadsFile(): string {
  return path.join(llm.getModelsDir(), 'downloads.json')
}

const downloadLedgerStorage: DownloadLedgerStorage<DownloadProgress> = {
  read: () => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(downloadsFile(), 'utf-8'))
      return Array.isArray(parsed) ? (parsed as DownloadProgress[]) : []
    } catch {
      return []
    }
  },
  write: (records) => {
    try {
      if (records.length > 0) fs.writeFileSync(downloadsFile(), JSON.stringify(records))
      else fs.rmSync(downloadsFile(), { force: true })
    } catch {
      /* best effort: download execution must not fail because status persistence failed */
    }
  }
}

const downloadLedger = new DownloadStatusLedger(downloadLedgerStorage, {
  interruptedError: DOWNLOAD_INTERRUPTED_ERROR
})

export { DOWNLOAD_INTERRUPTED_ERROR, shutdownModelDownloads }

function activeModelFile(): string {
  return path.join(llm.getModelsDir(), 'active-model.json')
}

/** Size (bytes) of a file in the models dir; 0 when absent/unreadable. The single
 *  FS probe injected into the pure catalog logic. */
function fileSizeOf(dir: string, name: string): number {
  try {
    return fs.statSync(path.join(dir, name)).size
  } catch {
    return 0
  }
}

function downloadedPrimary(model: DownloadedModel): string | undefined {
  return model.files.find((name) => !isProjectorFileName(name)) ?? model.files[0]
}

function downloadedProjector(model: DownloadedModel): string | undefined {
  return model.files.find(isProjectorFileName)
}

/** Exact id first; a unique family match keeps a stale pre-migration selection working. */
function downloadedVariant(models: DownloadedModel[], id: string): DownloadedModel | undefined {
  const exact = models.find((model) => model.id === id)
  if (exact) return exact
  const family = models.filter((model) => model.familyId === id)
  return family.length === 1 ? family[0] : undefined
}

/** Resolve a stale family alias at the model-library adapter boundary. */
export async function resolveCanonicalModelSelectionId(modelId: string): Promise<string> {
  if (
    modelId.startsWith('local:') ||
    decodeModelRouteId(modelId) ||
    parseRemoteVisionModelId(modelId)
  ) {
    return modelId
  }
  const { CATALOG } = await import('@offgrid/models')
  const downloaded = reconcileDownloadedModelRegistry(
    llm.getModelsDir(),
    CATALOG as unknown as CatalogEntry[]
  )
  return downloadedVariant(downloaded, modelId)?.id ?? modelId
}

export async function getCatalog(): Promise<{ kinds: readonly string[]; models: unknown[] }> {
  const { CATALOG, MODEL_KINDS } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  // Merge the three model sources (imported locals, tagged "Imported"; free-form
  // HF downloads whose files are all present, tagged "Downloaded"; then the
  // catalog) in that exact order - decision in catalog-logic, filesystem probe
  // injected as a closure so it stays pure.
  const present = (name: string): boolean => fileSizeOf(dir, name) > 0
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const models = mergeCatalog({
    locals: getLocalModels(),
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present
  })
  const remoteModels = remoteVisionInventoryModels(getRemoteVisionServerSettings().servers)
  return { kinds: MODEL_KINDS, models: [...models, ...remoteModels] }
}

export interface ModelIdentity {
  modelId: string
  modelName: string
}

/** Resolve a captured model ID to its display name without consulting which
 * model is active now. Task runs use this once, then persist the result. */
export async function resolveModelIdentity(modelId: string): Promise<ModelIdentity> {
  try {
    const catalog = (await getCatalog()).models as Array<{ id: string; name?: string }>
    return {
      modelId,
      modelName: catalog.find((model) => model.id === modelId)?.name?.trim() || modelId
    }
  } catch {
    return { modelId, modelName: modelId }
  }
}

/** Per-model vision status for every vision-CAPABLE model, keyed by id. supportsVision
 *  is derived from files (a projector), projectorInstalled from disk. The renderer uses
 *  this to offer "download vision support" for an installed vision model whose projector
 *  isn't present yet (the Gemma 4 E2B case, where the entry gained a projector after the
 *  user had already downloaded the weights). */
export async function getVisionStatuses(): Promise<Record<string, VisionStatus>> {
  const { CATALOG } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  const present = (name: string): boolean => fileSizeOf(dir, name) > 0
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const merged = mergeCatalog({
    locals: getLocalModels(),
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG as unknown as CatalogEntry[],
    present
  }) as CatalogEntry[]
  const out: Record<string, VisionStatus> = {}
  for (const m of merged) {
    const st = visionStatus(m, present)
    if (st.supportsVision) {
      out[m.id] = st
    }
  }
  return out
}

/** Catalog ids (plus imported local ids) whose files are fully present on disk. */
export async function listInstalled(): Promise<string[]> {
  const { CATALOG } = await import('@offgrid/models')
  const { isMfluxModelCached } = await import('./mflux')
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const localInstalled = installedIds({
    locals: getLocalModels(),
    installedDownloadedIds: installedDownloadedIds(dir),
    downloaded,
    catalog: CATALOG as unknown as CatalogEntry[],
    present: (name) => fileSizeOf(dir, name) > 0,
    mfluxCached: (id) => isMfluxModelCached(id)
  })
  const remoteInstalled = remoteVisionInventoryModels(getRemoteVisionServerSettings().servers).map(
    (model) => model.id
  )
  return [...localInstalled, ...remoteInstalled]
}

export async function searchModels(query: string, kind?: string): Promise<unknown[]> {
  try {
    const { searchHuggingFace } = await import('@offgrid/models')
    return await searchHuggingFace(query, {
      limit: 30,
      kind: kind as never,
      fetchImpl: platformFetch
    })
  } catch (err) {
    console.error('[models] HF search failed:', err)
    return []
  }
}

export function downloadStatus(modelId: string): DownloadProgress | null {
  return downloadLedger.get(modelId) ?? null
}

export function cancelDownload(modelId: string): boolean {
  const cancelled = downloadQueue.cancel(modelId)
  writeDiagnosticLog('models.download', 'cancel.requested', { modelId, cancelled })
  return cancelled
}

/** A download refused before it ever reached the queue is still an OUTCOME the watchers must see.
 *  The refusal used to be returned to the caller only, so the status registry kept whatever the UI
 *  had assumed and the card sat on a spinner forever. Publishing 'failed' the same way a mid-transfer
 *  failure does means every client — the screen, a headless poller, the registry — learns the same
 *  thing from one place, whether the download died at byte zero or at the last one. */
function publishRefusal(
  modelId: string,
  error: string,
  onProgress?: ProgressCb
): { success: false; error: string } {
  const p = downloadLedger.update(
    modelId,
    { status: 'failed', percent: 0, error },
    { persist: false }
  )
  onProgress?.(p)
  return { success: false, error }
}

/** Download a catalog entry or any Hugging Face repo id. Progress via callback
 *  AND a status registry (so a headless poller can read it). */
export async function downloadModel(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  if (!downloadQueue.isAccepting()) {
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'application_shutdown'
    })
    return publishRefusal(modelId, DOWNLOAD_INTERRUPTED_ERROR, onProgress)
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const inCatalog = CATALOG.find((m) => m.id === modelId)
  const entry = inCatalog ?? (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
  if (!entry) {
    writeDiagnosticLog('models.download', 'request.rejected', { modelId, reason: 'unknown_model' })
    return publishRefusal(modelId, 'unknown model', onProgress)
  }
  if (inCatalog?.availability === 'coming_soon') {
    const error = inCatalog.availabilityNote ?? 'This model is coming soon.'
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'runtime_adapter_unavailable'
    })
    return publishRefusal(modelId, error, onProgress)
  }
  writeDiagnosticLog('models.download', 'request.accepted', {
    modelId,
    kind: entry.kind,
    files: entry.files.length
  })

  const dir = llm.getModelsDir()
  fs.mkdirSync(dir, { recursive: true })
  downloadLedger.list()
  // Re-entrancy guard (before any status emit / queue registration): a second
  // download of the same id would write into the SAME .part (interleaved writes →
  // corrupt file). The queue tracks both waiting and active ids, so double-clicking
  // a queued card cannot enqueue it twice either.
  if (downloadQueue.has(modelId)) {
    writeDiagnosticLog('models.download', 'request.rejected', {
      modelId,
      reason: 'already_downloading'
    })
    return { success: false, error: 'already downloading' }
  }
  let loggedStatus: DownloadProgress['status'] | undefined
  const send = (data: Partial<DownloadProgress>): void => {
    const p = downloadLedger.update(modelId, data)
    onProgress?.(p)
    if (p.status && p.status !== loggedStatus) {
      loggedStatus = p.status
      writeDiagnosticLog(
        'models.download',
        `status.${p.status}`,
        { modelId, error: p.error, percent: p.percent },
        p.status === 'failed' ? 'error' : 'info'
      )
    }
    // The shared ledger persists status transitions and skips high-frequency byte ticks.
  }
  return downloadQueue.enqueue(
    modelId,
    async (signal) => {
      if (entry.runtime === 'mflux') {
        try {
          const { downloadMfluxModel } = await import('./mflux')
          await downloadMfluxModel(modelId, (pct: number) =>
            send({ percent: pct, status: 'downloading' })
          )
          send({ percent: 100, status: 'completed' })
          return { success: true }
        } catch (err) {
          const error = modelDownloadFailureMessage(err)
          send({ status: 'failed', error })
          return { success: false, error }
        }
      }

      let rateSample: ProgressRateSample | undefined
      const result = await runSequentialArtifactDownload({
        artifacts: entry.files.map((file) => ({ ...file, id: `${modelId}:${file.name}` })),
        signal,
        ports: createNodeArtifactDownloadPorts(dir),
        interruptedError: DOWNLOAD_INTERRUPTED_ERROR,
        hooks: {
          skipped: (file) =>
            writeDiagnosticLog('models.download', 'file.skipped', {
              modelId,
              file: file.name,
              reason: 'already_present'
            }),
          started: (file, resumeBytes) =>
            writeDiagnosticLog('models.download', 'file.started', {
              modelId,
              file: file.name,
              resumeBytes
            }),
          progress: (progress) => {
            const rate = sampleProgressRate(rateSample, {
              currentBytes: progress.downloadedBytes,
              sampledAtMs: Date.now()
            })
            rateSample = rate.sample
            send({
              currentFile: progress.artifact.name,
              fileIndex: progress.fileIndex,
              fileCount: progress.fileCount,
              percent: Math.round(progress.fraction * 100),
              downloadedMB: (progress.downloadedBytes / 1048576).toFixed(1),
              totalMB: progress.totalBytes ? (progress.totalBytes / 1048576).toFixed(1) : '?',
              downloadedBytes: progress.downloadedBytes,
              totalBytes: progress.totalBytes || undefined,
              bytesPerSecond: rate.bytesPerSecond,
              status: 'downloading'
            })
          },
          completed: (file, writtenBytes) =>
            writeDiagnosticLog('models.download', 'file.completed', {
              modelId,
              file: file.name,
              bytes: writtenBytes
            })
        }
      })
      if (result.success) {
        // Register a free-form Hugging Face download (not a catalog entry) so it counts
        // as installed + activatable and its files aren't flagged as "unused". Catalog
        // models are recognized by CATALOG membership already, so skip them.
        if (!inCatalog) {
          recordDownloaded(dir, {
            id: modelId,
            name: entry.name,
            kind: entry.kind,
            files: entry.files.map((f) => f.name)
          })
        }
        // If this download added the projector for the active chat model, turn its
        // vision on now (main-side, so it works even when no Models screen is open).
        await reconcileActiveModelProjector().catch(() => false)
        send({ percent: 100, status: 'completed' })
        return { success: true }
      }
      const error = result.error ?? 'Model download failed.'
      send(error === 'cancelled' ? { status: 'cancelled', error } : { status: 'failed', error })
      return { success: false, error }
    },
    (state) => {
      if (state === 'interrupted') {
        send({ status: 'failed', error: DOWNLOAD_INTERRUPTED_ERROR, percent: 0 })
      } else {
        send({ status: state, percent: 0 })
      }
    }
  )
}

interface DeleteModelResult {
  success: boolean
  error?: string
  freedFiles?: number
}

interface TransferredDeletionContext {
  dir: string
  requestedId: string
  target: DownloadedModel
  downloaded: DownloadedModel[]
  catalog: CatalogEntry[]
}

function retainedTransferredFileNames(context: TransferredDeletionContext): Set<string> {
  const { target, downloaded, catalog, dir } = context
  const retained = new Set<string>()
  catalog.forEach((model) => model.files.forEach((file) => retained.add(file.name)))
  getLocalModels(dir).forEach((model) => {
    retained.add(model.primary)
    if (model.mmproj) retained.add(model.mmproj)
  })
  downloaded
    .filter((model) => model.id !== target.id)
    .forEach((model) => model.files.forEach((name) => retained.add(name)))
  return retained
}

async function clearDeletedModelSelections(
  modelId: string,
  requestedId: string,
  primary: string | null | undefined
): Promise<void> {
  const active = desktopModelServices.activeModalities()
  const selected: Partial<Record<ModelModality, string | null>> = {
    text: active.text,
    computer_use: active.computer_use,
    image: active.image,
    voice: active.speech,
    transcription: active.transcription
  }
  for (const modality of deletedModelSelectionModalities({
    selected,
    modelId,
    requestedId,
    primaryFile: primary
  })) {
    const cleared = await desktopModelServices.select(modality, null)
    if (!cleared.success) {
      throw new Error(cleared.error ?? 'The model selection could not be cleared.')
    }
  }
}

async function deleteTransferredModel(
  context: TransferredDeletionContext
): Promise<DeleteModelResult> {
  const { dir, requestedId, target } = context
  // A projector can be shared by two installed quants. Delete only files that no other installed
  // model owns, then remove this exact package from the registry projection.
  const retainedNames = retainedTransferredFileNames(context)
  let freedFiles = 0
  for (const name of target.files) {
    if (!retainedNames.has(name)) {
      try {
        const filePath = path.join(dir, name)
        if (fs.existsSync(filePath)) {
          fs.rmSync(filePath, { force: true })
          freedFiles++
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : `could not delete ${name}`,
          freedFiles
        }
      }
    }
    try {
      fs.rmSync(path.join(dir, `${name}.part`), { force: true })
    } catch {
      /* the installed package remains authoritative */
    }
  }
  removeDownloaded(dir, target.id)
  await clearDeletedModelSelections(target.id, requestedId, downloadedPrimary(target))
  return { success: true, freedFiles }
}

/** Delete a model's files from disk. Clears it as active if it was selected. */
export async function deleteModel(modelId: string): Promise<DeleteModelResult> {
  const dir = llm.getModelsDir()
  // Imported local model: remove its files + registry entry, clear if active.
  if (modelId.startsWith('local:')) {
    const list = getLocalModels()
    const lm = list.find((m) => m.id === modelId)
    if (!lm) return { success: false, error: 'unknown local model' }
    let freedLocal = 0
    for (const name of [lm.primary, lm.mmproj].filter(Boolean) as string[]) {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
        freedLocal++
      } catch {
        /* ignore */
      }
    }
    saveLocalModels(list.filter((m) => m.id !== modelId))
    await clearDeletedModelSelections(modelId, modelId, lm.primary)
    return { success: true, freedFiles: freedLocal }
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const catalog = CATALOG as unknown as CatalogEntry[]
  const downloaded = reconcileDownloadedModelRegistry(dir, catalog)
  const transferred = downloadedVariant(downloaded, modelId)
  if (transferred) {
    return deleteTransferredModel({
      dir,
      requestedId: modelId,
      target: transferred,
      downloaded,
      catalog
    })
  }

  const entry =
    CATALOG.find((m) => m.id === modelId) ??
    (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
  if (!entry) return { success: false, error: 'unknown model' }
  let freed = 0

  if (entry.runtime === 'mflux') {
    try {
      const mod = await import('./mflux')
      const del = (mod as Record<string, unknown>).deleteMfluxModel
      if (typeof del === 'function') await (del as (id: string) => Promise<void>)(modelId)
    } catch (e) {
      console.warn('[models] mflux delete', e)
    }
  } else {
    for (const f of entry.files) {
      try {
        fs.rmSync(path.join(dir, f.name), { force: true })
        freed++
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(path.join(dir, `${f.name}.part`), { force: true })
      } catch {
        /* ignore */
      }
    }
    // Drop it from the downloaded registry too (no-op for a catalog model).
    if (findDownloaded(dir, modelId)) removeDownloaded(dir, modelId)
  }

  // If this was the active chat model, clear the selection so we don't point at gone files.
  // Clear any per-modality selection pointing at it — matching the id AND the
  // primary filename, because image picks are stored by filename (D6: without the
  // filename match, deleting the active image model left a dangling pointer).
  const primaryFile =
    entry.runtime === 'mflux' ? null : primaryFileName(entry as unknown as CatalogEntry)
  await clearDeletedModelSelections(modelId, modelId, primaryFile)
  return { success: true, freedFiles: freed }
}

async function setActiveLlamaModel(
  modelId: string,
  allowedKinds: readonly string[],
  expectedKind: string
): Promise<{ success: boolean; error?: string }> {
  // Imported local model: resolve from the local registry (not the catalog).
  if (modelId.startsWith('local:')) {
    const lm = getLocalModels().find((m) => m.id === modelId)
    if (!lm) return { success: false, error: 'unknown local model' }
    const refusal = modelSelectionRefusal({
      kind: lm.kind,
      allowedKinds,
      expectedKind,
      hasPrimary: Boolean(lm.primary)
    })
    if (refusal) return { success: false, error: refusal }
    desktopModelSelectionPersistence.projectLegacyTextConfig({
      id: modelId,
      primary: lm.primary,
      mmproj: lm.mmproj ?? null
    })
    llm.reloadModel()
    return { success: true }
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const catalogEntry = CATALOG.find((model) => model.id === modelId)
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const transferred = downloadedVariant(downloaded, modelId)
  if (transferred) {
    const primary = downloadedPrimary(transferred)
    const refusal = modelSelectionRefusal({
      kind: transferred.kind,
      allowedKinds,
      expectedKind,
      availability: catalogEntry?.availability,
      availabilityNote: catalogEntry?.availabilityNote,
      hasPrimary: Boolean(primary),
      transferred: true
    })
    if (refusal) return { success: false, error: refusal }
    const mmproj = downloadedProjector(transferred) ?? null
    desktopModelSelectionPersistence.projectLegacyTextConfig({
      id: transferred.id,
      primary: primary!,
      mmproj
    })
    llm.reloadModel()
    return { success: true }
  }
  const entry =
    catalogEntry ?? (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
  if (!entry) return { success: false, error: 'unknown model' }
  const primary = primaryFileName(entry as unknown as CatalogEntry)
  const refusal = modelSelectionRefusal({
    kind: entry.kind,
    allowedKinds,
    expectedKind,
    availability: entry.availability,
    availabilityNote: entry.availabilityNote,
    hasPrimary: Boolean(primary)
  })
  if (refusal) return { success: false, error: refusal }
  const mmproj = entry.files.find((f) => f.role === 'mmproj')?.name ?? null
  desktopModelSelectionPersistence.projectLegacyTextConfig({
    id: modelId,
    primary: primary!,
    mmproj
  })
  llm.reloadModel()
  return { success: true }
}

/** Raw native-runtime projection for the shared text selection store. */
export function projectActiveTextModelSelection(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  return setActiveLlamaModel(modelId, ['text', 'vision'], 'the chat LLM')
}

/** Set the chat LLM through the shared selection owner. */
export function setActiveModel(modelId: string): Promise<{ success: boolean; error?: string }> {
  return desktopModelServices.select('text', modelId)
}

/** Load the selected Computer Use policy into the shared llama.cpp runtime for one supervised run. */
export function loadComputerUseModel(
  modelId: string
): Promise<{ success: boolean; error?: string }> {
  return setActiveLlamaModel(modelId, ['computer_use'], 'Computer Use')
}

export function getActiveModel(): string | null {
  return desktopModelSelectionPersistence.projectedModelId('text')
}

/**
 * Move a legacy chat selection into its canonical specialist slot.
 *
 * Older catalogs exposed some specialist models as chat/vision models. After a catalog
 * correction, their old active-model.json entry must not keep routing normal chat to the
 * specialist. Preserve the user's choice in the proper modality, then remove the invalid
 * chat selection before llama-server starts.
 */
export async function reconcileActiveModelClassification(): Promise<boolean> {
  const activeId = getActiveModel()
  if (!activeId) return false

  const { CATALOG } = await import('@offgrid/models')
  const entry = CATALOG.find((model) => model.id === activeId)
  if (!entry || isChatLoadable(entry.kind)) return false

  const modality = specialistReclassificationModality(entry.kind)
  if (!modality) return false
  const active = desktopModelServices.activeModalities()
  const activeForModality = modality === 'voice' ? active.speech : active[modality]
  if (!activeForModality) {
    const migrated = await setActiveModalChoice(modality, activeId)
    if (!migrated.success) return false
  }
  const cleared = await desktopModelServices.select('text', null)
  if (!cleared.success) return false
  return true
}

/** Heal a stale active-model.json that predates its model gaining a vision projector.
 *  A model activated BEFORE its catalog entry had an mmproj (e.g. Gemma 4 E2B) stored
 *  `mmproj: null`; once the projector is downloaded, hasVision() still reads that null
 *  and the model stays text-only forever. This re-derives the projector from the
 *  catalog and, if the file is now present on disk, writes it into active-model.json and
 *  reloads — so vision turns on without a manual re-activate. Runs at startup and after
 *  every download completes, independent of which screen (if any) is open. Returns true
 *  when it healed something. */
export async function reconcileActiveModelProjector(): Promise<boolean> {
  let cfg: { id?: string; primary?: string; mmproj?: string | null } | null = null
  try {
    cfg = JSON.parse(fs.readFileSync(activeModelFile(), 'utf-8'))
  } catch {
    return false // no active selection yet
  }
  const { CATALOG } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[])
  const active = cfg!
  const transferred = active.id ? downloadedVariant(downloaded, active.id) : undefined
  if (transferred) {
    const repair = transferredProjectorRepair({
      active,
      transferred: {
        id: transferred.id,
        primary: downloadedPrimary(transferred),
        projector: downloadedProjector(transferred)
      },
      present: (name) => fileSizeOf(dir, name) > 0
    })
    if (repair) {
      desktopModelSelectionPersistence.projectLegacyTextConfig(repair)
      llm.reloadModel()
      return true
    }
  }
  const entry = (CATALOG as unknown as CatalogEntry[]).find((m) => m.id === active.id)
  const projector = projectorToHeal(active, entry, (name) => fileSizeOf(dir, name) > 0)
  if (!projector) {
    return false // already has one / no projector / not downloaded yet — leave as is
  }
  desktopModelSelectionPersistence.projectLegacyTextConfig({
    id: String(active.id),
    primary: String(active.primary),
    mmproj: projector
  })
  llm.reloadModel()
  return true
}

/**
 * The active model id for EVERY modality (chat LLM + image/voice/transcription),
 * as catalog/local ids. The single "what's active" truth the UI consults so it
 * can mark any model active without re-deriving per-kind rules. Reuses the
 * per-entry active computation in getStorageInfo (one definition of "active").
 */
export async function getActiveModelIds(): Promise<string[]> {
  return desktopModelServices.activeModelIds()
}

/**
 * Make ANY installed model the active one for its type — the single seam the UI
 * calls. Routes by kind internally: text/vision load the chat LLM; image/voice/
 * transcription set that modality's default pick. Callers pass only the id and
 * never branch on kind. Adding a new modality needs zero caller changes.
 */
export async function activateModel(
  modelId: string,
  requestedKind?: string
): Promise<{ success: boolean; error?: string }> {
  const route = decodeModelRouteId(modelId)
  const remote = route?.serverId
    ? { serverId: route.serverId, modelId: route.modelId }
    : parseRemoteVisionModelId(modelId)
  if (remote) {
    const remoteModality =
      requestedKind === 'image' ||
      requestedKind === 'transcription' ||
      requestedKind === 'embedding' ||
      requestedKind === 'computer_use'
        ? requestedKind
        : requestedKind === 'voice' || requestedKind === 'speech'
          ? 'voice'
          : 'text'
    return desktopModelServices.select(remoteModality, modelId)
  }
  let kind: string | undefined
  let requestedModal: ModelModality | null = null
  if (modelId.startsWith('local:')) {
    kind = getLocalModels().find((m) => m.id === modelId)?.kind
  } else {
    const { CATALOG, modelSupportsKind, resolveHuggingFaceModel } = await import('@offgrid/models')
    const downloaded = reconcileDownloadedModelRegistry(
      llm.getModelsDir(),
      CATALOG as unknown as CatalogEntry[]
    )
    const catalogEntry = CATALOG.find((m) => m.id === modelId)
    kind =
      downloadedVariant(downloaded, modelId)?.kind ??
      (catalogEntry ?? (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch })))?.kind
    const requested = requestedKind as Parameters<typeof modelSupportsKind>[1]
    if (catalogEntry && requestedKind && modelSupportsKind(catalogEntry, requested)) {
      requestedModal = runtimeModalityForModelKind(requestedKind)
    }
  }
  const modal = requestedModal ?? runtimeModalityForModelKind(kind)
  return modal ? desktopModelServices.select(modal, modelId) : setActiveModel(modelId)
}

export async function setActiveModalChoice(
  kind: string,
  modelId: string | null
): Promise<{ success: boolean; error?: string }> {
  // Normalize to the storage modality so BOTH vocabularies work — the setup path
  // passes 'voice', the UI/dispatch pass 'speech'. Before this, the guard only
  // accepted 'speech', so "Configure for me" (which passes 'voice') silently failed
  // to activate TTS (D26). One normalizer is the single source of truth.
  const modality = runtimeModalityForModelKind(kind)
  if (modality && modality !== 'text') {
    return desktopModelServices.select(modality, modelId)
  }
  return { success: false, error: 'use setActiveModel for the chat LLM (text/vision)' }
}

export function getActiveModalities(): { text: string | null } & Record<Modality, string | null> {
  return desktopModelServices.activeModalities()
}

// ---------------------------------------------------------------------------
// Local model import: a registry of user-imported .gguf files (not in the
// catalog), wired through list/activate/delete/storage so they behave like any
// other installed model — and are protected from orphan cleanup.
// ---------------------------------------------------------------------------

export interface LocalModel {
  id: string
  name: string
  primary: string
  mmproj?: string
  kind: 'text' | 'vision'
  params?: number
  sizeBytes: number
}

export type TransferableModelSource = 'catalog' | 'downloaded' | 'local'

export interface TransferableModelFile {
  name: string
  sizeBytes: number
  path: string
}

export interface TransferableModel {
  id: string
  familyId: string
  packageIdentity?: string
  name: string
  kind: string
  source: TransferableModelSource
  files: TransferableModelFile[]
}

function localRegistryFile(dir = llm.getModelsDir()): string {
  return path.join(dir, 'local-models.json')
}

export function getLocalModels(dir = llm.getModelsDir()): LocalModel[] {
  try {
    const arr = JSON.parse(fs.readFileSync(localRegistryFile(dir), 'utf-8'))
    return Array.isArray(arr) ? (arr as LocalModel[]) : []
  } catch {
    return []
  }
}
function saveLocalModels(list: LocalModel[], dir = llm.getModelsDir()): void {
  try {
    fs.writeFileSync(localRegistryFile(dir), JSON.stringify(list, null, 2))
  } catch {
    /* best effort */
  }
}

function safeTransferredFileName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    path.basename(name) === name &&
    name !== '.' &&
    name !== '..'
  )
}

function transferredFilesOnDisk(
  dir: string,
  files: Array<{ name: string; sizeBytes: number }>
): { error?: string; files?: TransferableModelFile[] } {
  if (files.length === 0) return { error: 'model has no transferable files' }
  const names = new Set<string>()
  const resolved: TransferableModelFile[] = []
  for (const file of files) {
    if (
      !safeTransferredFileName(file.name) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes <= 0 ||
      names.has(file.name)
    ) {
      return { error: 'model manifest contains an invalid file' }
    }
    names.add(file.name)
    const filePath = path.join(dir, file.name)
    let actualSize = 0
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { error: `${file.name}: transferred file is not a regular file` }
      }
      actualSize = stat.size
    } catch {
      return { error: `${file.name}: transferred file is missing` }
    }
    if (actualSize !== file.sizeBytes) {
      return { error: `${file.name}: transferred file size does not match the manifest` }
    }
    if (/\.gguf$/i.test(file.name) && !isValidGgufFile(filePath, fs)) {
      return { error: `${file.name}: transferred file is not a valid GGUF model` }
    }
    resolved.push({ ...file, path: filePath })
  }
  return { files: resolved }
}

/**
 * Resolve one installed, file-backed model for device transfer. Runtime caches such as mflux are
 * intentionally excluded because they are directory trees, not portable model files.
 */
export async function getTransferableModel(
  modelId: string,
  dir = llm.getModelsDir()
): Promise<TransferableModel | null> {
  const local = getLocalModels(dir).find((model) => model.id === modelId)
  const { CATALOG } = await import('@offgrid/models')
  const catalog = CATALOG.find((model) => model.id === modelId)
  const downloaded = downloadedVariant(
    reconcileDownloadedModelRegistry(dir, CATALOG as unknown as CatalogEntry[]),
    modelId
  )

  const source: TransferableModelSource | null = local
    ? 'local'
    : downloaded
      ? 'downloaded'
      : catalog && catalog.runtime !== 'mflux'
        ? 'catalog'
        : null
  if (!source) return null

  const names = local
    ? [local.primary, local.mmproj].filter((name): name is string => Boolean(name))
    : downloaded
      ? downloaded.files
      : (catalog?.files.map((file) => file.name) ?? [])
  const files = transferredFilesOnDisk(
    dir,
    names.map((name) => ({ name, sizeBytes: fileSizeOf(dir, name) }))
  ).files
  if (!files) return null

  return {
    id: downloaded?.id ?? modelId,
    familyId: downloaded?.familyId ?? catalog?.id ?? local?.id ?? modelId,
    packageIdentity: downloaded?.packageIdentity,
    name: local?.name ?? downloaded?.name ?? catalog?.name ?? modelId,
    kind: local?.kind ?? downloaded?.kind ?? catalog?.kind ?? 'text',
    source,
    files
  }
}

/**
 * Register model files only after the transfer owner has checksum-verified and atomically promoted
 * every file into the models directory. The catalog remains the source of truth for known models;
 * free-form and local models are recorded in their existing registries.
 */
export async function registerTransferredModel(
  manifest: TransferredModelManifest,
  dir = llm.getModelsDir()
): Promise<{ success: boolean; error?: string; id?: string }> {
  if (
    !manifest.id ||
    manifest.id.length > 512 ||
    !manifest.name ||
    manifest.name.length > 512 ||
    !manifest.kind ||
    manifest.kind.length > 128
  ) {
    return { success: false, error: 'model manifest is invalid' }
  }

  const resolved = transferredFilesOnDisk(dir, manifest.files)
  if (!resolved.files) return { success: false, error: resolved.error }

  // Projector presence is the package capability SSOT. A caller can still label an older catalog
  // entry as text, but the installed package and its deterministic identity must be vision.
  const projectorPresent = manifest.files.some(
    (file) => file.role === 'projector' || isProjectorFileName(file.name)
  )
  const normalizedManifest: TransferredModelManifest =
    projectorPresent && (manifest.kind === 'text' || manifest.kind === 'vision')
      ? { ...manifest, kind: 'vision' }
      : manifest

  const { CATALOG } = await import('@offgrid/models')
  const catalog = CATALOG.find((model) => model.id === normalizedManifest.id)
  if (catalog) {
    const expected = new Set<string>(catalog.files.map((file) => file.name))
    const received = new Set(normalizedManifest.files.map((file) => file.name))
    if (expected.size === received.size && [...expected].every((name) => received.has(name))) {
      return { success: true, id: normalizedManifest.id }
    }
    // A catalog id can have several valid quantizations and projector variants. The sender's
    // manifest owns the exact installed files; the catalog owns only its download variant.
    // Register a verified alternate variant below so it remains installed and transferable.
  }

  if (normalizedManifest.source === 'local') {
    const primary =
      normalizedManifest.files.find(
        (file) => /\.gguf$/i.test(file.name) && !/mmproj|projector/i.test(file.name)
      ) ?? normalizedManifest.files.find((file) => /\.gguf$/i.test(file.name))
    if (!primary) return { success: false, error: 'local model transfer requires a GGUF file' }
    const mmproj = normalizedManifest.files.find(
      (file) => file.name !== primary.name && /\.gguf$/i.test(file.name)
    )
    const id = `local:${primary.name}`
    const list = getLocalModels(dir).filter((model) => model.id !== id)
    list.push({
      id,
      name: normalizedManifest.name,
      primary: primary.name,
      mmproj: mmproj?.name,
      kind: mmproj ? 'vision' : 'text',
      sizeBytes: primary.sizeBytes
    })
    saveLocalModels(list, dir)
    if (!getLocalModels(dir).some((model) => model.id === id)) {
      return { success: false, error: 'could not register the transferred local model' }
    }
    return { success: true, id }
  }

  const exactPackageId =
    normalizedManifest.packageIdentity ?? modelPackageIdentity(normalizedManifest)
  recordDownloaded(dir, {
    id: exactPackageId,
    familyId: normalizedManifest.id,
    packageIdentity: exactPackageId,
    name: normalizedManifest.name,
    kind: normalizedManifest.kind,
    files: normalizedManifest.files.map((file) => file.name)
  })
  if (!findDownloaded(dir, exactPackageId)) {
    return { success: false, error: 'could not register the transferred model' }
  }
  if (dir === llm.getModelsDir()) {
    await reconcileActiveModelProjector().catch(() => false)
  }
  return { success: true, id: exactPackageId }
}

/** Set of every filename referenced by the local registry (primary + mmproj), so
 *  storage/orphan logic never deletes an imported model. */
function localProtectedNames(): Set<string> {
  const s = new Set<string>()
  for (const m of getLocalModels()) {
    s.add(m.primary)
    if (m.mmproj) s.add(m.mmproj)
  }
  return s
}

/** A real GGUF starts with the "GGUF" magic and is more than a few bytes. */
/** Import a local .gguf: validate, stream-copy into the models dir (with progress),
 *  and register it so it shows up as an installed, activatable model. */
export async function importLocalModel(
  srcPath: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string; id?: string }> {
  if (!srcPath || !srcPath.toLowerCase().endsWith('.gguf'))
    return { success: false, error: 'Not a .gguf file' }
  if (!isValidGgufFile(srcPath, fs))
    return { success: false, error: 'File is not a valid GGUF model (corrupt or wrong format)' }

  const dir = llm.getModelsDir()
  fs.mkdirSync(dir, { recursive: true })
  const fileName = path.basename(srcPath)
  const dest = path.join(dir, fileName)
  const id = `local:${fileName}`
  const total = fs.statSync(srcPath).size
  const send = (data: Partial<DownloadProgress>): void => {
    onProgress?.({ modelId: id, ...data })
  }

  // Copy unless an identical-size file is already there.
  const already = fs.existsSync(dest) && fs.statSync(dest).size === total
  if (!already) {
    try {
      await new Promise<void>((resolve, reject) => {
        const rd = fs.createReadStream(srcPath)
        const wr = fs.createWriteStream(dest)
        let copied = 0
        rd.on('data', (c) => {
          copied += c.length
          send({
            status: 'downloading',
            percent: total ? Math.round((copied / total) * 100) : 0,
            currentFile: fileName
          })
        })
        rd.on('error', reject)
        wr.on('error', reject)
        wr.on('finish', () => resolve())
        rd.pipe(wr)
      })
    } catch (e) {
      try {
        fs.rmSync(dest, { force: true })
      } catch {
        /* ignore */
      }
      send({ status: 'failed', error: (e as Error).message })
      return { success: false, error: (e as Error).message }
    }
  }

  // Heuristic kind: a paired mmproj makes it vision; otherwise treat as text.
  const base = fileName.replace(/\.gguf$/i, '')
  const list = getLocalModels().filter((m) => m.id !== id)
  list.push({ id, name: base, primary: fileName, kind: 'text', sizeBytes: total })
  saveLocalModels(list)
  send({ status: 'completed', percent: 100 })
  return { success: true, id }
}

// ---------------------------------------------------------------------------
// Storage: disk usage, free space, orphan cleanup
// ---------------------------------------------------------------------------

export interface ModelDiskEntry {
  id: string
  name: string
  kind?: string
  bytes: number
  active: boolean
}
export interface StorageInfo {
  dir: string
  totalBytes: number // all model files (incl. orphans + .part) in the models dir
  freeBytes: number // free space on the volume
  models: ModelDiskEntry[]
  orphans: { name: string; bytes: number }[]
}

/** Disk usage for models: per installed model, total, free space, and orphan files
 *  (gguf/.part in the models dir that no catalog entry or active selection claims). */
export async function getStorageInfo(): Promise<StorageInfo> {
  const dir = llm.getModelsDir()
  const { CATALOG } = await import('@offgrid/models')
  const catalog = CATALOG as unknown as CatalogEntry[]
  const reconciledDownloaded = reconcileDownloadedModelRegistry(dir, catalog)
  // Protect catalog + imported-local + free-form-download files, plus the active
  // chat selection's files, from being flagged/deleted as orphans.
  let activePrimary: string | null = null
  let activeMmproj: string | null = null
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'active-model.json'), 'utf-8'))
    activePrimary = cfg?.primary ?? null
    activeMmproj = cfg?.mmproj ?? null
  } catch {
    /* none */
  }
  const known = protectedNames({
    catalog,
    localNames: localProtectedNames(),
    downloadedNames: downloadedProtectedNames(dir),
    activePrimary,
    activeMmproj
  })

  const active = getActiveModel()
  // Per-modality active picks (image/speech/transcription) are stored as the
  // chosen FILENAME, not the catalog id — so an image/voice/STT model is "active"
  // when its primary file matches. Without this, only the chat LLM ever shows
  // active and image models can't be activated from the UI.
  const selected = desktopModelServices.activeModalities()
  const modals: Record<Modality, string | null> = {
    computer_use: selected.computer_use,
    image: selected.image,
    speech: selected.speech,
    transcription: selected.transcription
  }
  const locals = getLocalModels()
  const installed = (await listInstalled()).filter((id) => !parseRemoteVisionModelId(id))
  const sizeOf = (name: string): number => fileSizeOf(dir, name)
  const downloaded = reconciledDownloaded
  const catalogIds = new Set(catalog.map((m) => m.id))
  const catalogById = (id: string): CatalogEntry | undefined => catalog.find((m) => m.id === id)
  const models: ModelDiskEntry[] = installed.map((id) =>
    buildDiskEntry({
      id,
      locals,
      downloaded,
      catalogById,
      isCatalogId: (x) => catalogIds.has(x),
      activeChatId: active,
      modals,
      sizeOf
    })
  )

  let entries: string[] = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    /* no dir yet */
  }
  const statFile = (name: string): { isFile: boolean; size: number } | null => {
    try {
      const st = fs.statSync(path.join(dir, name))
      return { isFile: st.isFile(), size: st.size }
    } catch {
      return null
    }
  }
  const { totalBytes, orphans } = scanModelDir({ entries, known, statFile })

  let freeBytes = 0
  try {
    const s = fs.statfsSync(dir)
    freeBytes = s.bavail * s.bsize
  } catch {
    /* unknown */
  }
  return { dir, totalBytes, freeBytes, models, orphans }
}

/** Delete every orphan file (unreferenced gguf/.part). Recomputes the orphan set so
 *  it can never touch a catalog model or the active selection. */
export async function deleteOrphans(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  const info = await getStorageInfo()
  const dir = llm.getModelsDir()
  let freedBytes = 0,
    count = 0
  for (const o of info.orphans) {
    try {
      fs.rmSync(path.join(dir, o.name), { force: true })
      freedBytes += o.bytes
      count++
    } catch {
      /* ignore */
    }
  }
  return { success: true, count, freedBytes }
}

// ---------------------------------------------------------------------------
// Download registry: surface active/failed/completed downloads + retry, and
// survive an app restart (an interrupted download becomes resumable).
// ---------------------------------------------------------------------------

/** All known downloads (active, failed, interrupted) for a download-manager view. */
export function listDownloads(): DownloadProgress[] {
  return downloadLedger.list()
}

/** Retry (resumes from the partial .part) a failed/interrupted download. */
export async function retryDownload(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  return downloadModel(modelId, onProgress)
}

/** Dismiss a download-manager entry: abort it if still running, delete its partial
 *  .part files, and drop it from the registry so it leaves the Downloads list. */
export async function clearDownload(
  modelId: string
): Promise<{ success: boolean; freedBytes: number }> {
  cancelDownload(modelId) // no-op if not currently downloading
  let freedBytes = 0
  try {
    const dir = llm.getModelsDir()
    const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
    const entry =
      CATALOG.find((m) => m.id === modelId) ??
      (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }).catch(() => null))
    for (const f of entry?.files ?? []) {
      const part = path.join(dir, `${f.name}.part`)
      try {
        freedBytes += fs.statSync(part).size
      } catch {
        /* none */
      }
      try {
        fs.rmSync(part, { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best effort */
  }
  downloadLedger.remove(modelId)
  return { success: true, freedBytes }
}

/** Clear every failed/cancelled/interrupted download (entry + .part). */
export async function clearInactiveDownloads(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  const ids = downloadLedger.inactiveIds()
  let freedBytes = 0
  for (const id of ids) {
    const r = await clearDownload(id)
    freedBytes += r.freedBytes
  }
  return { success: true, count: ids.length, freedBytes }
}
