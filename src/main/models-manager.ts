// Central model management — the single source of truth for catalog, install
// listing, download (pull), delete, and activation. Used by BOTH the desktop IPC
// handlers (UI) AND the headless gateway HTTP admin endpoints, so the full
// repertoire (pull / delete / activate / list) works with or without a UI.
import fs from 'fs'
import path from 'path'
import { llm } from './llm'
import { verifyArtifactFile } from './models/gguf'
import {
  recordDownloaded,
  removeDownloaded,
  findDownloaded,
  installedDownloadedIds,
  downloadedProtectedNames,
  reconcileDownloadedModelRegistry,
  type DownloadedModel
} from './downloaded-models'
import { modelPackageIdentity, type TransferredModelManifest } from '@offgrid/sync'
import {
  artifactVerificationError,
  type LocalModelImportService,
  type ModelLibraryRemovalService,
  type ModelTransferRegistrationService,
  type ModelMetadataRepairCommandService,
  type ModelLibraryRemovalTarget,
  type LocalModelImportProgress,
  mergeCatalog,
  workspaceRouteId,
  catalogEntryForIdentifier,
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
  type ModelCapabilities,
  type ModelModality,
  type Modality,
  type VisionStatus,
  isLocalLibraryModelId
} from '@offgrid/models'
import type { ModelControlCatalogModel } from '@offgrid/application'
import type { RemoteVisionInventoryModel } from '../shared/remote-vision-server'
import { registerDesktopModelManagerPorts } from './model-manager-ports'
import { desktopModelSelectionPersistence } from './model-selection-persistence'
import {
  activeProjectorRepairService,
  localModelImportService,
  modelLibraryRemovalService,
  modelTransferRegistration,
  registerDesktopModelLibraryPorts,
  type DesktopProjectorRepair
} from './composition/model-library'
import { platformFetch } from '@offgrid/models/fetch'
import { desktopImageRuntimeIdentity } from './models/image-runtime-identity'
import { modelSearchKind } from './models/model-search-kind'
import { registerDesktopDownloadMetadataRepairPorts } from './models/desktop-model-download-ports'
import { LocalModelRegistry, type LocalModelRegistryEntry } from './models/local-model-registry'
import { MODEL_FILE_EXTENSION, isGgufFile } from '@offgrid/models'
import {
  desktopActiveModalities,
  desktopModels,
  modelsFailureMessage,
  refreshDesktopModels,
  selectDesktopModel
} from './composition/application-access'

export type DesktopModelControlCatalogModel = Omit<ModelControlCatalogModel, 'artifacts'> & {
  files?: Array<{
    name: string
    role?: 'primary' | 'mmproj' | 'tokenizer' | 'aux'
    sizeBytes?: number
    url?: string
    sha256?: string
  }>
  remoteModelId?: string
  capabilities?: ModelCapabilities
}

function isModelControlCatalogModel(value: unknown): value is DesktopModelControlCatalogModel {
  if (!value || typeof value !== 'object') return false
  if (
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('kind' in value) ||
    typeof value.kind !== 'string' ||
    !['text', 'vision', 'image', 'voice', 'transcription', 'computer_use'].includes(value.kind)
  ) {
    return false
  }
  const files = 'files' in value ? value.files : undefined
  return (
    files === undefined ||
    (Array.isArray(files) &&
      files.every(
        (file) =>
          Boolean(file) &&
          typeof file === 'object' &&
          'name' in file &&
          typeof file.name === 'string' &&
          (!('url' in file) || typeof file.url === 'string') &&
          (!('sizeBytes' in file) || typeof file.sizeBytes === 'number') &&
          (!('sha256' in file) || typeof file.sha256 === 'string') &&
          (!('role' in file) ||
            file.role === 'primary' ||
            file.role === 'mmproj' ||
            file.role === 'tokenizer' ||
            file.role === 'aux')
      ))
  )
}

export function requireModelControlCatalogModels(
  values: readonly unknown[]
): DesktopModelControlCatalogModel[] {
  return values.map((value, index) => {
    if (!isModelControlCatalogModel(value)) {
      throw new Error(`Model-control catalog entry ${String(index)} is invalid.`)
    }
    return value
  })
}

function activeModelFile(): string {
  return path.join(llm.getModelsDir(), 'active-model.json')
}

/** Size (bytes) of a file in the models dir; 0 only when absent. The single
 *  FS probe injected into the pure catalog logic. */
export class ModelFilesystemProbeError extends Error {
  readonly code = 'MODEL_FILESYSTEM_PROBE_FAILED'
  readonly filePath: string

  constructor(filePath: string, cause: unknown) {
    super(`Could not inspect the model artifact at ${filePath}.`, { cause })
    this.name = 'ModelFilesystemProbeError'
    this.filePath = filePath
  }
}

function fileSizeOf(dir: string, name: string): number {
  const filePath = path.join(dir, name)
  try {
    return fs.statSync(filePath).size
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return 0
    console.error('[models] Failed to inspect model artifact:', filePath, cause)
    throw new ModelFilesystemProbeError(filePath, cause)
  }
}

export class ModelIdentityResolutionError extends Error {
  readonly code = 'MODEL_IDENTITY_RESOLUTION_FAILED'
  readonly modelId: string

  constructor(modelId: string, cause: unknown) {
    super(`Could not resolve the catalog identity for model ${modelId}.`, { cause })
    this.name = 'ModelIdentityResolutionError'
    this.modelId = modelId
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

/** A route id, or any id that names a remote route, is already canonical (the workspace decides). */
function isCanonicalSelectionId(modelId: string): boolean {
  const model = desktopModels.lookup(modelId)
  return Boolean(model && (model.source === 'remote' || workspaceRouteId(model) === modelId))
}

/** Resolve a stale family alias at the model-library adapter boundary. */
export async function resolveCanonicalModelSelectionId(modelId: string): Promise<string> {
  if (isLocalLibraryModelId(modelId) || isCanonicalSelectionId(modelId)) return modelId
  const { CATALOG } = await import('@offgrid/models')
  const downloaded = reconcileDownloadedModelRegistry(llm.getModelsDir(), CATALOG)
  return downloadedVariant(downloaded, modelId)?.id ?? modelId
}

function localArtifactName(value: unknown): string | null {
  if (typeof value !== 'string' || !value || path.basename(value) !== value) return null
  return value
}

export class ActiveModelMetadataError extends Error {
  readonly code = 'ACTIVE_MODEL_METADATA_CORRUPT'

  constructor(
    readonly filePath: string,
    message: string
  ) {
    super(message)
    this.name = 'ActiveModelMetadataError'
  }
}

interface ActiveModelArtifactConfig {
  id: string
  primary: string
  mmproj: string | null
}

/** Read and validate the legacy native text-runtime projection.
 *  An absent file means there is no local selection. A present partial or unsafe
 *  projection is damaged state and must stop storage cleanup and runtime repair. */
function readActiveModelArtifactConfig(): ActiveModelArtifactConfig | null {
  const value = desktopModelSelectionPersistence.readLegacyTextConfigIfPresent()
  if (!value) return null
  const hasState =
    value.id !== undefined || value.primary !== undefined || value.mmproj !== undefined
  const id = typeof value.id === 'string' && value.id.trim() ? value.id : null
  const primary = localArtifactName(value.primary)
  const mmproj = value.mmproj == null ? null : localArtifactName(value.mmproj)
  if (!hasState || !id || !primary || (value.mmproj != null && !mmproj)) {
    throw new ActiveModelMetadataError(
      activeModelFile(),
      'The active model metadata is damaged. Repair it before changing model files.'
    )
  }
  return { id, primary, mmproj }
}

/**
 * Read-only migration projection for profiles created before local/downloaded inventory was
 * authoritative. The legacy selection files contribute artifact facts only; Shared inventory
 * remains the sole owner of readiness and canonical route selection.
 */
function legacySelectedLocalInventory(dir: string): CatalogEntry[] {
  const projected: CatalogEntry[] = []
  const text = desktopModelSelectionPersistence.readLegacyTextConfig()
  const textId = typeof text.id === 'string' && text.id ? text.id : null
  const primary = localArtifactName(text.primary)
  const projector = localArtifactName(text.mmproj)
  if (textId && primary && fileSizeOf(dir, primary) > 0) {
    const files = [
      { name: primary, sizeBytes: fileSizeOf(dir, primary), role: 'primary' as const },
      ...(projector && fileSizeOf(dir, projector) > 0
        ? [{ name: projector, sizeBytes: fileSizeOf(dir, projector), role: 'mmproj' as const }]
        : [])
    ]
    projected.push({
      id: textId,
      name: textId,
      kind: projector ? 'vision' : 'text',
      files
    } as CatalogEntry)
  }

  const imageId = desktopModelSelectionPersistence.projectedModelId('image')
  const imageArtifact = localArtifactName(imageId)
  if (imageId && imageArtifact && fileSizeOf(dir, imageArtifact) > 0) {
    projected.push({
      id: imageId,
      name: imageId,
      kind: 'image',
      files: [{ name: imageArtifact, sizeBytes: fileSizeOf(dir, imageArtifact), role: 'primary' }]
    } as CatalogEntry)
  }
  return projected
}

function uniqueLegacySelectedInventory(
  dir: string,
  knownModels: readonly CatalogEntry[]
): CatalogEntry[] {
  const knownIds = new Set(knownModels.map((model) => model.id))
  const knownArtifacts = new Set(
    knownModels.flatMap((model) => model.files.map((file) => file.name))
  )
  return legacySelectedLocalInventory(dir).filter(
    (model) => !knownIds.has(model.id) && !model.files.some((file) => knownArtifacts.has(file.name))
  )
}

/** Remote rows for the catalog surfaces: the workspace's rows plus Desktop presentation. */
function remoteCatalogEntries(): RemoteVisionInventoryModel[] {
  return desktopModels.remoteCatalogRows().map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    org: row.serverName,
    description: `Runs through ${row.serverName}.`,
    files: [],
    tags: ['Remote'],
    remoteServerId: row.remoteServerId,
    remoteModelId: row.remoteModelId,
    remoteCapabilities: row.remoteCapabilities
  }))
}

export async function getCatalog(): Promise<{ kinds: readonly string[]; models: unknown[] }> {
  const { CATALOG, MODEL_KINDS } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  // Merge the three model sources (imported locals, tagged "Imported"; free-form
  // HF downloads whose files are all present, tagged "Downloaded"; then the
  // catalog) in that exact order - decision in catalog-logic, filesystem probe
  // injected as a closure so it stays pure.
  const present = (name: string): boolean => fileSizeOf(dir, name) > 0
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG)
  const models = mergeCatalog({
    locals: getLocalModels(),
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG,
    present
  })
  const remoteModels = remoteCatalogEntries()
  const legacySelected = uniqueLegacySelectedInventory(dir, [...models, ...remoteModels])
  return { kinds: MODEL_KINDS, models: [...models, ...legacySelected, ...remoteModels] }
}

/** Read Desktop catalog facts without reaching into Computer Use composition. */
export async function getModelControlCatalogFacts(): Promise<{
  catalog: Awaited<ReturnType<typeof getCatalog>>
  installed: string[]
}> {
  await refreshDesktopModels()
  const [catalog, installed] = await Promise.all([getCatalog(), listInstalled()])
  return { catalog, installed }
}

export interface ModelIdentity {
  modelId: string
  modelName: string
}

interface ModelIdentityCatalogEntry {
  id: string
  name?: string
  remoteServerId?: string
  remoteModelId?: string
}

/** Resolve one canonical selection against its exact local or server-owned catalog identity. */
export function projectModelIdentity(
  modelId: string,
  catalog: readonly ModelIdentityCatalogEntry[]
): ModelIdentity | null {
  // Pure projection over the catalog rows; shared owns how an identifier names a row.
  const model = catalogEntryForIdentifier(modelId, catalog)
  const modelName = model?.name?.trim()
  return model && modelName ? { modelId, modelName } : null
}

/** Resolve a captured model ID to its display name without consulting which
 * model is active now. Task runs use this once, then persist the result. */
export async function resolveModelIdentity(modelId: string): Promise<ModelIdentity> {
  try {
    const catalog = (await getCatalog()).models as ModelIdentityCatalogEntry[]
    const identity = projectModelIdentity(modelId, catalog)
    if (!identity) throw new Error('The selected model is absent from the model-control catalog.')
    return identity
  } catch (cause) {
    console.error('[models] Failed to resolve model identity:', modelId, cause)
    throw new ModelIdentityResolutionError(modelId, cause)
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
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG)
  const merged = mergeCatalog({
    locals: getLocalModels(),
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG,
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

/** Canonical ids installed through file-backed stores or their owning native runtime. */
export async function listInstalled(): Promise<string[]> {
  const { CATALOG } = await import('@offgrid/models')
  const { isMfluxModelCached } = await import('./mflux')
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG)
  const localInstalled = installedIds({
    locals: getLocalModels(),
    installedDownloadedIds: installedDownloadedIds(dir),
    downloaded,
    catalog: CATALOG,
    present: (name) => fileSizeOf(dir, name) > 0,
    mfluxCached: (id) => isMfluxModelCached(id)
  })
  const remoteInstalled = remoteCatalogEntries().map((model) => model.id)
  const { inspectTtsRuntimeState } = await import('./tts')
  const runtimeInstalled = inspectTtsRuntimeState().installed
    ? CATALOG.filter(
        (model) =>
          model.kind === 'voice' &&
          model.runtime === 'executorch' &&
          model.artifactDelivery === 'runtime'
      ).map((model) => model.id)
    : []
  const knownModels = mergeCatalog({
    locals: getLocalModels(),
    downloaded,
    installedDownloadedIds: installedDownloadedIds(dir),
    catalog: CATALOG,
    present: (name) => fileSizeOf(dir, name) > 0
  })
  const legacyInstalled = uniqueLegacySelectedInventory(dir, knownModels).map((model) => model.id)
  return [
    ...new Set([...localInstalled, ...legacyInstalled, ...remoteInstalled, ...runtimeInstalled])
  ]
}

export async function searchModels(query: string, kind?: string): Promise<unknown[]> {
  try {
    const { searchHuggingFace } = await import('@offgrid/models')
    return await searchHuggingFace(query, {
      limit: 30,
      kind: modelSearchKind(kind),
      fetchImpl: platformFetch
    })
  } catch (err) {
    console.error('[models] HF search failed:', err)
    return []
  }
}

export class ActiveModelProjectorFinalizationError extends Error {
  readonly code = 'ACTIVE_MODEL_PROJECTOR_FINALIZATION_FAILED'

  constructor(cause: unknown) {
    super(
      'Model files are ready, but the active vision model could not be updated. Retry to finish setup.',
      { cause }
    )
    this.name = 'ActiveModelProjectorFinalizationError'
  }
}

async function finalizeInstalledModelArtifacts(): Promise<void> {
  try {
    await reconcileActiveModelProjector()
  } catch (cause) {
    throw new ActiveModelProjectorFinalizationError(cause)
  }
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
  const active = desktopActiveModalities()
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
  if (isLocalLibraryModelId(modelId)) {
    const local = getLocalModels().find((model) => model.id === modelId)
    return local
      ? {
          source: 'local',
          modelId,
          requestedId: modelId,
          primaryFile: local.primary,
          files: [local.primary, local.mmproj].filter((name): name is string => Boolean(name))
        }
      : null
  }
  const { CATALOG, resolveHuggingFaceModel } = await import('@offgrid/models')
  const catalog = CATALOG
  const downloaded = reconcileDownloadedModelRegistry(dir, catalog)
  const transferred = downloadedVariant(downloaded, modelId)
  if (transferred) {
    return {
      source: 'downloaded',
      modelId: transferred.id,
      requestedId: modelId,
      primaryFile: downloadedPrimary(transferred),
      files: transferred.files,
      retainedFiles: retainedTransferredFileNames({
        target: transferred,
        downloaded,
        catalog,
        dir
      }),
      strictFileRemoval: true
    }
  }
  const entry =
    CATALOG.find((m) => m.id === modelId) ??
    (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
  if (entry?.artifactDelivery === 'runtime') return null
  return entry
    ? {
        source: 'catalog',
        modelId,
        requestedId: modelId,
        primaryFile:
          entry.kind === 'image'
            ? desktopImageRuntimeIdentity.resolve(modelId, entry)
            : primaryFileName(entry),
        files: entry.files.map((file) => file.name),
        runtimeManaged: entry.runtime === 'mflux'
      }
    : null
}

/** Desktop file, runtime, and registry I/O for model removal. Shared owns the transaction. */
export function desktopModelLibraryRemovalPorts(): ConstructorParameters<
  typeof ModelLibraryRemovalService
>[0] {
  return {
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
        saveLocalModels(getLocalModels().filter((model) => model.id !== target.modelId))
      } else if (
        desktop.source === 'downloaded' ||
        findDownloaded(llm.getModelsDir(), target.modelId)
      ) {
        removeDownloaded(llm.getModelsDir(), target.modelId)
      }
    },
    clearSelection: (modality) => selectDesktopModel(modality, null)
  }
}

const modelLibraryRemoval = (): ModelLibraryRemovalService => modelLibraryRemovalService()

/** Delete a model package through the Shared removal and selection-cleanup transaction. */
export function deleteModel(modelId: string): Promise<DeleteModelResult> {
  return modelLibraryRemoval().remove(modelId)
}

async function setActiveLlamaModel(
  modelId: string,
  allowedKinds: readonly string[],
  expectedKind: string
): Promise<{ success: boolean; error?: string }> {
  // Imported local model: resolve from the local registry (not the catalog).
  if (isLocalLibraryModelId(modelId)) {
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
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG)
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
  const primary = primaryFileName(entry)
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
  return selectDesktopModel('text', modelId)
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
/**
 * `signal` is checked at the ONE safe point: after the reads, before the first persisted change.
 *
 * The two writes below are an atomic pair - migrating the model to its real modality and clearing
 * it out of the text slot. Abandoning the repair between them would leave a specialist both
 * migrated AND still selected as the chat model, which is worse than a repair that ran slightly
 * late. So the guard refuses to BEGIN the pair when its caller has already given up on it, and
 * never interrupts it once begun.
 */
export async function reconcileActiveModelClassification(signal?: AbortSignal): Promise<boolean> {
  const activeId = getActiveModel()
  if (!activeId) return false

  const { CATALOG } = await import('@offgrid/models')
  const entry = CATALOG.find((model) => model.id === activeId)
  if (!entry || isChatLoadable(entry.kind)) return false

  const modality = specialistReclassificationModality(entry.kind)
  if (!modality) return false
  if (signal?.aborted === true) return false
  // selectedModelRoutes owns the modality-to-slot mapping; a modality this desktop has no
  // slot for reads as unselected and the migration proceeds through the same selection port.
  const activeForModality = selectedModelRoutes()[modality]
  if (!activeForModality) {
    const migrated = await setActiveModalChoice(modality, activeId)
    if (!migrated.success) return false
  }
  const cleared = await selectDesktopModel('text', null)
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
  const cfg = readActiveModelArtifactConfig()
  if (!cfg) return null
  const { CATALOG } = await import('@offgrid/models')
  const dir = llm.getModelsDir()
  const downloaded = reconcileDownloadedModelRegistry(dir, CATALOG)
  const active = cfg
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
  const entry = CATALOG.find((m) => m.id === active.id)
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

export function desktopActiveProjectorRepairPorts(): ConstructorParameters<
  typeof ModelMetadataRepairCommandService<DesktopProjectorRepair>
>[0] {
  return {
    resolve: resolveActiveModelProjectorRepair,
    persist: (repair) => desktopModelSelectionPersistence.projectLegacyTextConfig(repair),
    reload: () => llm.reloadModel(),
    refresh: refreshDesktopModels
  }
}

const activeProjectorRepair = (): ModelMetadataRepairCommandService<DesktopProjectorRepair> =>
  activeProjectorRepairService()

export function reconcileActiveModelProjector(): Promise<boolean> {
  return activeProjectorRepair().execute()
}

/**
 * The active model id for EVERY modality (chat LLM + image/voice/transcription),
 * as catalog/local ids. The single "what's active" truth the UI consults so it
 * can mark any model active without re-deriving per-kind rules. Reuses the
 * per-entry active computation in getStorageInfo (one definition of "active").
 */
export async function getActiveModelIds(): Promise<string[]> {
  return [...desktopModels.activeModelIds()]
}

/**
 * Make ANY installed model the active one for its type — the single seam the UI
 * calls. Routes by kind internally: text/vision load the chat LLM; image/voice/
 * transcription set that modality's default pick. Callers pass only the id and
 * never branch on kind. Adding a new modality needs zero caller changes.
 */
export async function resolveDesktopActivation(
  modelId: string,
  requestedKind?: string
): Promise<{ kind?: string; remote?: boolean; supportsRequestedKind?: boolean } | null> {
  const known = desktopModels.lookup(modelId)
  if (known?.source === 'remote') {
    // A remote route's modality is an inventory fact; without it a caller that names no kind would
    // be routed to text and an image pick would silently fail.
    return { remote: true, kind: known.kind }
  }
  let kind: string | undefined
  let supportsRequestedKind = false
  if (isLocalLibraryModelId(modelId)) {
    kind = getLocalModels().find((m) => m.id === modelId)?.kind
  } else {
    const { CATALOG, modelSupportsKind, resolveHuggingFaceModel } = await import('@offgrid/models')
    const downloaded = reconcileDownloadedModelRegistry(llm.getModelsDir(), CATALOG)
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

export async function activateModel(
  modelId: string,
  requestedKind?: string
): Promise<{ success: boolean; error?: string }> {
  const outcome = await desktopModels.activate({ modelId, requestedKind })
  return outcome.ok
    ? { success: true }
    : { success: false, error: modelsFailureMessage(outcome.failure) }
}

export async function setActiveModalChoice(
  kind: string,
  modelId: string | null
): Promise<{ success: boolean; error?: string }> {
  const outcome = await desktopModels.activate({ modelId, requestedKind: kind })
  return outcome.ok
    ? { success: true }
    : { success: false, error: modelsFailureMessage(outcome.failure) }
}

export function getActiveModalities(): { text: string | null } & Record<Modality, string | null> {
  return desktopActiveModalities()
}

// ---------------------------------------------------------------------------
// Local model import: a registry of user-imported .gguf files (not in the
// catalog), wired through list/activate/delete/storage so they behave like any
// other installed model — and are protected from orphan cleanup.
// ---------------------------------------------------------------------------

export type LocalModel = LocalModelRegistryEntry

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

export function getLocalModels(dir = llm.getModelsDir()): LocalModel[] {
  return new LocalModelRegistry(dir).read()
}
function saveLocalModels(list: LocalModel[], dir = llm.getModelsDir()): void {
  new LocalModelRegistry(dir).write(list)
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
    if (!verification.valid)
      return {
        error: artifactVerificationError(
          {
            path: filePath,
            name: file.name,
            origin: 'transfer',
            expectedBytes: file.sizeBytes,
            removeInvalid: false
          },
          verification
        )
      }
    resolved.push({ ...file, path: filePath })
  }
  return { files: resolved }
}

/** Registry and filesystem I/O for a transferred model, scoped to one models directory. */
export function desktopModelTransferRegistrationPorts(
  dir: () => string,
  afterRegistered?: () => Promise<void>
): ConstructorParameters<typeof ModelTransferRegistrationService>[0] {
  return {
    validateFiles: async (manifest) =>
      (
        await transferredFilesOnDisk(
          dir(),
          manifest.files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes }))
        )
      ).error ?? null,
    async catalogFiles(modelId) {
      const { CATALOG } = await import('@offgrid/models')
      return CATALOG.find((model) => model.id === modelId)?.files.map((file) => file.name) ?? null
    },
    readLocalModels: () => getLocalModels(dir()),
    writeLocalModels: (models) => saveLocalModels([...models], dir()),
    recordDownloaded: (model) => recordDownloaded(dir(), model),
    hasDownloaded: (id) => Boolean(findDownloaded(dir(), id)),
    packageIdentity: (manifest) => modelPackageIdentity(manifest as TransferredModelManifest),
    ...(afterRegistered ? { afterRegistered } : {})
  }
}

const transferredModelRegistration = (): ModelTransferRegistrationService =>
  modelTransferRegistration(() => llm.getModelsDir(), finalizeInstalledModelArtifacts)

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
  const downloaded = downloadedVariant(reconcileDownloadedModelRegistry(dir, CATALOG), modelId)

  const source: TransferableModelSource | null = local
    ? 'local'
    : downloaded
      ? 'downloaded'
      : catalog && catalog.runtime !== 'mflux' && catalog.artifactDelivery !== 'runtime'
        ? 'catalog'
        : null
  if (!source) return null

  const names = local
    ? [local.primary, local.mmproj].filter((name): name is string => Boolean(name))
    : downloaded
      ? downloaded.files
      : (catalog?.files.map((file) => file.name) ?? [])
  const files = (
    await transferredFilesOnDisk(
      dir,
      names.map((name) => ({ name, sizeBytes: fileSizeOf(dir, name) }))
    )
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
  if (dir === llm.getModelsDir()) {
    try {
      return await transferredModelRegistration().register(manifest)
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Model files are ready, but active model setup could not be completed.'
      }
    }
  }
  const scoped = modelTransferRegistration(() => dir)
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

export function desktopLocalModelImportPorts(): ConstructorParameters<
  typeof LocalModelImportService
>[0] {
  return {
    async inspect(source) {
      if (!source || !isGgufFile(source)) {
        return {
          fileName: '',
          sizeBytes: 0,
          valid: false,
          error: `Not a ${MODEL_FILE_EXTENSION.gguf} file`
        }
      }
      if (!(await verifyArtifactFile(source, fs, 'import')).valid) {
        return {
          fileName: path.basename(source),
          sizeBytes: 0,
          valid: false,
          error: 'File is not a valid GGUF model (corrupt or wrong format)'
        }
      }
      return { fileName: path.basename(source), sizeBytes: fs.statSync(source).size, valid: true }
    },
    async destinationHasSize(fileName, sizeBytes) {
      const destination = path.join(llm.getModelsDir(), fileName)
      try {
        return fs.statSync(destination).size === sizeBytes
      } catch {
        return false
      }
    },
    async copy({ source, fileName, onBytes }) {
      const dir = llm.getModelsDir()
      fs.mkdirSync(dir, { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(source)
        const output = fs.createWriteStream(path.join(dir, fileName))
        let copied = 0
        input.on('data', (chunk) => {
          copied += chunk.length
          onBytes(copied)
        })
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
    writeLocalModels: (models) => saveLocalModels([...models])
  }
}

const activeProjectorRepairPorts = desktopActiveProjectorRepairPorts()

registerDesktopModelLibraryPorts({
  removal: desktopModelLibraryRemovalPorts,
  repair: () => activeProjectorRepairPorts,
  localImport: desktopLocalModelImportPorts,
  transfer: desktopModelTransferRegistrationPorts
})
registerDesktopDownloadMetadataRepairPorts(activeProjectorRepairPorts)

const localModelImports = (): LocalModelImportService => localModelImportService()

/** Import and register one local GGUF through the Shared model-library transaction. */
export function importLocalModel(
  source: string,
  onProgress?: (progress: LocalModelImportProgress) => void
): Promise<{ success: boolean; error?: string; id?: string }> {
  return localModelImports().import(source, onProgress)
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
  const catalog = CATALOG
  const reconciledDownloaded = reconcileDownloadedModelRegistry(dir, catalog)
  // Protect catalog + imported-local + free-form-download files, plus the active
  // chat selection's files, from being flagged/deleted as orphans.
  let activePrimary: string | null = null
  let activeMmproj: string | null = null
  const activeConfig = readActiveModelArtifactConfig()
  if (activeConfig) {
    activePrimary = activeConfig.primary
    activeMmproj = activeConfig.mmproj
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
  const selected = desktopActiveModalities()
  const modals: Record<Modality, string | null> = {
    computer_use: selected.computer_use,
    image: selected.image,
    speech: selected.speech,
    transcription: selected.transcription
  }
  const locals = getLocalModels()
  const remoteIds = new Set(remoteCatalogEntries().map((model) => model.id))
  const installed = (await listInstalled()).filter((id) => !remoteIds.has(id))
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
  retainedBytes: number
  failures: Array<{ name: string; bytes: number; error: string }>
}> {
  const info = await getStorageInfo()
  const dir = llm.getModelsDir()
  let freedBytes = 0,
    count = 0
  const failures: Array<{ name: string; bytes: number; error: string }> = []
  for (const o of info.orphans) {
    try {
      fs.rmSync(path.join(dir, o.name), { force: true })
      freedBytes += o.bytes
      count++
    } catch (error) {
      failures.push({
        name: o.name,
        bytes: o.bytes,
        error: error instanceof Error ? error.message : `Could not delete ${o.name}`
      })
    }
  }
  return {
    success: failures.length === 0,
    count,
    freedBytes,
    retainedBytes: failures.reduce((total, failure) => total + failure.bytes, 0),
    failures
  }
}

registerDesktopModelManagerPorts({
  getCatalog,
  listInstalled,
  resolveCanonicalModelSelectionId,
  projectActiveTextModelSelection
})
