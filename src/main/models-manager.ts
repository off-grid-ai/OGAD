// Central model management — the single source of truth for catalog, install
// listing, download (pull), delete, and activation. Used by BOTH the desktop IPC
// handlers (UI) AND the headless gateway HTTP admin endpoints, so the full
// repertoire (pull / delete / activate / list) works with or without a UI.
import fs from 'fs'
import path from 'path'
import { llm } from './llm'
import { verifyArtifactFile } from './models/gguf'
import { createNodeArtifactDownloadPorts } from './models/node-artifact-download-adapter'
import {
  DOWNLOAD_INTERRUPTED_ERROR,
  modelDownloadQueue
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
  artifactVerificationError,
  DownloadStatusLedger,
  LocalModelImportService,
  ModelActivationService,
  ModelLibraryDownloadService,
  ModelLibraryRemovalService,
  ModelTransferRegistrationService,
  ModelMetadataRepairCommandService,
  type ModelLibraryRemovalTarget,
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
  modelSelectionRefusal,
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
import { desktopModelServices } from './model-service-access'
import { registerDesktopModelManagerPorts } from './model-manager-ports'
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

export { DOWNLOAD_INTERRUPTED_ERROR }

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
  return modelLibraryDownloads.status(modelId)
}

export function cancelDownload(modelId: string): boolean {
  const cancelled = modelLibraryDownloads.cancel(modelId)
  writeDiagnosticLog('models.download', 'cancel.requested', { modelId, cancelled })
  return cancelled
}

async function resolveDesktopDownload(modelId: string): Promise<{
  entry: CatalogEntry
  catalogEntry: boolean
} | null> {
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const inCatalog = CATALOG.find((m) => m.id === modelId)
  const entry = inCatalog ?? (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
  return entry
    ? { entry: entry as unknown as CatalogEntry, catalogEntry: Boolean(inCatalog) }
    : null
}

async function executeDesktopDownload(input: {
  entry: CatalogEntry
  catalogEntry: boolean
  signal: AbortSignal
  publish(patch: Partial<DownloadProgress>): void
}): Promise<{ success: boolean; error?: string }> {
  const { entry, signal, publish } = input
  const modelId = entry.id
  writeDiagnosticLog('models.download', 'request.accepted', {
    modelId,
    kind: entry.kind,
    files: entry.files.length
  })
  const dir = llm.getModelsDir()
  fs.mkdirSync(dir, { recursive: true })
  if (entry.runtime === 'mflux') {
    try {
      const { downloadMfluxModel } = await import('./mflux')
      await downloadMfluxModel(modelId, (percent: number) =>
        publish({ percent, status: 'downloading' })
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: modelDownloadFailureMessage(error) }
    }
  }
  let rateSample: ProgressRateSample | undefined
  const artifacts = entry.files.map(file => ({
    ...file,
    id: `${modelId}:${file.name}`,
    url: file.url ?? ''
  }))
  if (artifacts.some(artifact => !artifact.url)) {
    return { success: false, error: 'model artifact has no download URL' }
  }
  return runSequentialArtifactDownload({
    artifacts,
    signal,
    ports: createNodeArtifactDownloadPorts(dir),
    interruptedError: DOWNLOAD_INTERRUPTED_ERROR,
    hooks: {
      skipped: file => writeDiagnosticLog('models.download', 'file.skipped', {
        modelId, file: file.name, reason: 'already_present'
      }),
      started: (file, resumeBytes) => writeDiagnosticLog('models.download', 'file.started', {
        modelId, file: file.name, resumeBytes
      }),
      progress: progress => {
        const rate = sampleProgressRate(rateSample, {
          currentBytes: progress.downloadedBytes,
          sampledAtMs: Date.now()
        })
        rateSample = rate.sample
        publish({
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
      completed: (file, writtenBytes) => writeDiagnosticLog('models.download', 'file.completed', {
        modelId, file: file.name, bytes: writtenBytes
      })
    }
  })
}

async function clearDesktopPartials(entry: CatalogEntry): Promise<number> {
  const dir = llm.getModelsDir()
  let freedBytes = 0
  for (const file of entry.files) {
    const partial = path.join(dir, `${file.name}.part`)
    try { freedBytes += fs.statSync(partial).size } catch { /* absent */ }
    try { fs.rmSync(partial, { force: true }) } catch { /* best effort */ }
  }
  return freedBytes
}

const modelLibraryDownloads = new ModelLibraryDownloadService(
  downloadQueue,
  downloadLedger,
  {
    resolve: resolveDesktopDownload,
    execute: executeDesktopDownload,
    clearPartials: clearDesktopPartials,
    async afterInstalled(entry, catalogEntry) {
      if (!catalogEntry) {
        recordDownloaded(llm.getModelsDir(), {
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          files: entry.files.map(file => file.name)
        })
      }
      await reconcileActiveModelProjector().catch(() => false)
    },
    observe(event) {
      if (event.type === 'request-refused') {
        writeDiagnosticLog('models.download', 'request.rejected', {
          modelId: event.modelId, reason: event.reason
        })
      } else if (event.type === 'status') {
        writeDiagnosticLog(
          'models.download',
          `status.${event.status}`,
          { modelId: event.modelId, error: event.error, percent: event.percent },
          event.status === 'failed' ? 'error' : 'info'
        )
      }
    }
  }
)

export function shutdownModelDownloads(): Promise<void> {
  return modelLibraryDownloads.shutdown()
}

/** Download a catalog entry or any Hugging Face repo through Shared admission and recovery. */
export function downloadModel(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  return modelLibraryDownloads.download(modelId, onProgress)
}

interface DeleteModelResult {
  success: boolean
  error?: string
  freedFiles?: number
}

function retainedTransferredFileNames(input: {
  target: DownloadedModel
  downloaded: DownloadedModel[]
  catalog: CatalogEntry[]
  dir: string
}): Set<string> {
  const { target, downloaded, catalog, dir } = input
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

interface DesktopRemovalTarget extends ModelLibraryRemovalTarget {
  source: 'local' | 'downloaded' | 'catalog'
}

function selectedModelRoutes(): Partial<Record<ModelModality, string | null>> {
  const active = desktopModelServices.activeModalities()
  return {
    text: active.text,
    computer_use: active.computer_use,
    image: active.image,
    voice: active.speech,
    transcription: active.transcription
  }
}

async function resolveDesktopRemoval(modelId: string): Promise<DesktopRemovalTarget | null> {
  const dir = llm.getModelsDir()
  if (modelId.startsWith('local:')) {
    const local = getLocalModels().find(model => model.id === modelId)
    return local ? {
      source: 'local', modelId, requestedId: modelId, primaryFile: local.primary,
      files: [local.primary, local.mmproj].filter((name): name is string => Boolean(name))
    } : null
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const catalog = CATALOG as unknown as CatalogEntry[]
  const downloaded = reconcileDownloadedModelRegistry(dir, catalog)
  const transferred = downloadedVariant(downloaded, modelId)
  if (transferred) {
    return {
      source: 'downloaded', modelId: transferred.id, requestedId: modelId,
      primaryFile: downloadedPrimary(transferred), files: transferred.files,
      retainedFiles: retainedTransferredFileNames({ target: transferred, downloaded, catalog, dir }),
      strictFileRemoval: true
    }
  }
  const entry =
    CATALOG.find((m) => m.id === modelId) ??
    (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
  return entry ? {
    source: 'catalog', modelId, requestedId: modelId,
    primaryFile: entry.runtime === 'mflux'
      ? null
      : primaryFileName(entry as unknown as CatalogEntry),
    files: entry.files.map(file => file.name),
    runtimeManaged: entry.runtime === 'mflux'
  } : null
}

const modelLibraryRemoval = new ModelLibraryRemovalService({
  resolve: resolveDesktopRemoval,
  selected: selectedModelRoutes,
  async removeFile(fileName) {
    const filePath = path.join(llm.getModelsDir(), fileName)
    const existed = fs.existsSync(filePath)
    fs.rmSync(filePath, { force: true })
    return existed
  },
  async removePartial(fileName) {
    fs.rmSync(path.join(llm.getModelsDir(), `${fileName}.part`), { force: true })
  },
  async removeRuntime(target) {
    const mod = await import('./mflux')
    const remove = (mod as Record<string, unknown>).deleteMfluxModel
    if (typeof remove === 'function') {
      await (remove as (id: string) => Promise<void>)(target.modelId)
    }
  },
  async unregister(target) {
    const desktop = target as DesktopRemovalTarget
    if (desktop.source === 'local') {
      saveLocalModels(getLocalModels().filter(model => model.id !== target.modelId))
    } else if (desktop.source === 'downloaded' || findDownloaded(llm.getModelsDir(), target.modelId)) {
      removeDownloaded(llm.getModelsDir(), target.modelId)
    }
  },
  clearSelection: (modality) => desktopModelServices.select(modality, null)
})

/** Delete a model package through the Shared removal and selection-cleanup transaction. */
export function deleteModel(modelId: string): Promise<DeleteModelResult> {
  return modelLibraryRemoval.remove(modelId)
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
async function resolveActiveModelProjectorRepair(): Promise<{
  id: string
  primary: string
  mmproj: string
} | null> {
  let cfg: { id?: string; primary?: string; mmproj?: string | null } | null = null
  try {
    cfg = JSON.parse(fs.readFileSync(activeModelFile(), 'utf-8'))
  } catch {
    return null // no active selection yet
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
      return repair
    }
  }
  const entry = (CATALOG as unknown as CatalogEntry[]).find((m) => m.id === active.id)
  const projector = projectorToHeal(active, entry, (name) => fileSizeOf(dir, name) > 0)
  if (!projector) {
    return null // already has one / no projector / not downloaded yet — leave as is
  }
  return {
    id: String(active.id),
    primary: String(active.primary),
    mmproj: projector
  }
}

const activeProjectorRepair = new ModelMetadataRepairCommandService({
  resolve: resolveActiveModelProjectorRepair,
  persist: repair => desktopModelSelectionPersistence.projectLegacyTextConfig(repair),
  reload: () => llm.reloadModel(),
  refresh: () => desktopModelServices.refresh().then(() => undefined)
})

export function reconcileActiveModelProjector(): Promise<boolean> {
  return activeProjectorRepair.execute()
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
async function resolveDesktopActivation(
  modelId: string,
  requestedKind?: string
): Promise<{ kind?: string; remote?: boolean; supportsRequestedKind?: boolean } | null> {
  const route = decodeModelRouteId(modelId)
  if (route?.serverId || parseRemoteVisionModelId(modelId)) return { remote: true }
  let kind: string | undefined
  let supportsRequestedKind = false
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
    supportsRequestedKind = Boolean(
      catalogEntry && requestedKind && modelSupportsKind(catalogEntry, requested)
    )
  }
  return kind ? { kind, supportsRequestedKind } : null
}

const modelActivation = new ModelActivationService({
  resolve: resolveDesktopActivation,
  select: (modality, modelId) => desktopModelServices.select(modality, modelId)
})

export function activateModel(
  modelId: string,
  requestedKind?: string
): Promise<{ success: boolean; error?: string }> {
  return modelActivation.activate(modelId, requestedKind)
}

export function setActiveModalChoice(
  kind: string,
  modelId: string | null
): Promise<{ success: boolean; error?: string }> {
  return modelActivation.selectModal(kind, modelId)
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

async function transferredFilesOnDisk(
  dir: string,
  files: Array<{ name: string; sizeBytes: number }>
): Promise<{ error?: string; files?: TransferableModelFile[] }> {
  if (files.length === 0) return { error: 'model has no transferable files' }
  const resolved: TransferableModelFile[] = []
  for (const file of files) {
    const filePath = path.join(dir, file.name)
    const verification = await verifyArtifactFile(filePath, fs, 'transfer', false, file.sizeBytes)
    if (!verification.valid) return {
      error: artifactVerificationError({
        path: filePath,
        name: file.name,
        origin: 'transfer',
        expectedBytes: file.sizeBytes,
        removeInvalid: false
      }, verification)
    }
    resolved.push({ ...file, path: filePath })
  }
  return { files: resolved }
}

const transferredModelRegistration = new ModelTransferRegistrationService({
  validateFiles: async manifest => (await transferredFilesOnDisk(
    llm.getModelsDir(),
    manifest.files.map(file => ({ name: file.name, sizeBytes: file.sizeBytes }))
  )).error ?? null,
  async catalogFiles(modelId) {
    const { CATALOG } = await import('@offgrid/models')
    return CATALOG.find(model => model.id === modelId)?.files.map(file => file.name) ?? null
  },
  readLocalModels: () => getLocalModels(),
  writeLocalModels: models => saveLocalModels([...models]),
  recordDownloaded: model => recordDownloaded(llm.getModelsDir(), model),
  hasDownloaded: id => Boolean(findDownloaded(llm.getModelsDir(), id)),
  packageIdentity: manifest => modelPackageIdentity(manifest as TransferredModelManifest),
  afterRegistered: async () => { await reconcileActiveModelProjector().catch(() => false) }
})

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
  const files = (await transferredFilesOnDisk(
    dir,
    names.map((name) => ({ name, sizeBytes: fileSizeOf(dir, name) }))
  )).files
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
  if (dir === llm.getModelsDir()) return transferredModelRegistration.register(manifest)
  const scoped = new ModelTransferRegistrationService({
    validateFiles: async input => (await transferredFilesOnDisk(
      dir, input.files.map(file => ({ name: file.name, sizeBytes: file.sizeBytes }))
    )).error ?? null,
    async catalogFiles(modelId) {
      const { CATALOG } = await import('@offgrid/models')
      return CATALOG.find(model => model.id === modelId)?.files.map(file => file.name) ?? null
    },
    readLocalModels: () => getLocalModels(dir),
    writeLocalModels: models => saveLocalModels([...models], dir),
    recordDownloaded: model => recordDownloaded(dir, model),
    hasDownloaded: id => Boolean(findDownloaded(dir, id)),
    packageIdentity: input => modelPackageIdentity(input as TransferredModelManifest)
  })
  return scoped.register(manifest)
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

const localModelImports = new LocalModelImportService({
  async inspect(source) {
    if (!source || !source.toLowerCase().endsWith('.gguf')) {
      return { fileName: '', sizeBytes: 0, valid: false, error: 'Not a .gguf file' }
    }
    if (!(await verifyArtifactFile(source, fs, 'import')).valid) {
      return {
        fileName: path.basename(source), sizeBytes: 0, valid: false,
        error: 'File is not a valid GGUF model (corrupt or wrong format)'
      }
    }
    return { fileName: path.basename(source), sizeBytes: fs.statSync(source).size, valid: true }
  },
  async destinationHasSize(fileName, sizeBytes) {
    const destination = path.join(llm.getModelsDir(), fileName)
    try { return fs.statSync(destination).size === sizeBytes } catch { return false }
  },
  async copy({ source, fileName, onBytes }) {
    const dir = llm.getModelsDir()
    fs.mkdirSync(dir, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const input = fs.createReadStream(source)
      const output = fs.createWriteStream(path.join(dir, fileName))
      let copied = 0
      input.on('data', chunk => { copied += chunk.length; onBytes(copied) })
      input.on('error', reject)
      output.on('error', reject)
      output.on('finish', resolve)
      input.pipe(output)
    })
  },
  async removeDestination(fileName) {
    fs.rmSync(path.join(llm.getModelsDir(), fileName), { force: true })
  },
  readLocalModels: () => getLocalModels(),
  writeLocalModels: models => saveLocalModels([...models])
})

/** Import and register one local GGUF through the Shared model-library transaction. */
export function importLocalModel(
  source: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string; id?: string }> {
  return localModelImports.import(source, onProgress)
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
  return modelLibraryDownloads.list()
}

/** Retry (resumes from the partial .part) a failed/interrupted download. */
export async function retryDownload(
  modelId: string,
  onProgress?: ProgressCb
): Promise<{ success: boolean; error?: string }> {
  return modelLibraryDownloads.retry(modelId, onProgress)
}

/** Dismiss a download-manager entry: abort it if still running, delete its partial
 *  .part files, and drop it from the registry so it leaves the Downloads list. */
export async function clearDownload(
  modelId: string
): Promise<{ success: boolean; freedBytes: number }> {
  return modelLibraryDownloads.clear(modelId)
}

/** Clear every failed/cancelled/interrupted download (entry + .part). */
export async function clearInactiveDownloads(): Promise<{
  success: boolean
  count: number
  freedBytes: number
}> {
  return modelLibraryDownloads.clearInactive()
}

registerDesktopModelManagerPorts({
  getCatalog,
  listInstalled,
  resolveCanonicalModelSelectionId,
  projectActiveTextModelSelection
})
