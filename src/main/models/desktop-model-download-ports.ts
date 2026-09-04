import path from 'node:path'
import {
  CATALOG,
  downloadModelType,
  once,
  resolveHuggingFaceModel,
  type ModelEntry,
  type ModelMetadataRepairCommandPorts,
  type PublicDownloadRequest,
  type PublicDownloadSources
} from '@offgrid/models'
import {
  createDownloadMetadataRepairCommand,
  type DownloadMetadataRepairCommand,
  type ModelsDownloadPorts
} from '@offgrid/application'
import type { AsyncDownloadedModelRegistryPort } from '@offgrid/models'
import { platformFetch } from '@offgrid/models/fetch'
import { llm } from '../llm'
import { desktopAsyncDownloadedRegistryPorts } from '../downloaded-models'
import { writeDiagnosticLog } from '../diagnostics-log'
import { DownloadRecoveryStore } from './download-recovery-store'
import { createNodeModelDownloadPorts } from './node-artifact-download-adapter'
import { createDesktopModelDownloadFinalizer } from './desktop-model-download-finalizer'

interface ResolvedDownloadSource {
  entry: ModelEntry
  catalogEntry: boolean
}

/** The metadata a Desktop projector repair rewrites: the active text model's file pair. */
export interface DesktopProjectorRepair {
  id: string
  primary: string
  mmproj: string
}

let metadataRepairPorts: ModelMetadataRepairCommandPorts<DesktopProjectorRepair> | null = null

/** Register Desktop I/O once. Shared still owns the portable resolve/persist/reload sequence. */
export function registerDesktopDownloadMetadataRepairPorts(
  ports: ModelMetadataRepairCommandPorts<DesktopProjectorRepair>
): void {
  if (metadataRepairPorts) {
    throw new Error('Desktop download metadata-repair ports are already registered.')
  }
  metadataRepairPorts = ports
}

function requireMetadataRepairPorts(): ModelMetadataRepairCommandPorts<DesktopProjectorRepair> {
  if (!metadataRepairPorts) {
    throw new Error('Desktop download metadata-repair ports are not registered.')
  }
  return metadataRepairPorts
}

/**
 * The ONE projector-repair command on this device, built by Shared from the registered Desktop I/O.
 * Both the download owner's post-install repair and the on-demand reconcile run through this single
 * instance, so the app holds no `@offgrid/models` repair service and no second repair owner.
 */
export const desktopDownloadMetadataRepair = once(
  (): DownloadMetadataRepairCommand =>
    createDownloadMetadataRepairCommand<DesktopProjectorRepair>({
      resolve: () => requireMetadataRepairPorts().resolve(),
      persist: (repair) => requireMetadataRepairPorts().persist(repair),
      reload: () => requireMetadataRepairPorts().reload(),
      refresh: async () => {
        await requireMetadataRepairPorts().refresh?.()
      }
    })
)

function primaryFile(entry: ModelEntry): ModelEntry['files'][number] {
  const primary =
    entry.files.find((file) => file.role === 'primary') ??
    entry.files.find((file) => file.role !== 'mmproj')
  if (!primary) throw new Error(`Model ${entry.id} has no primary artifact.`)
  return primary
}

function publicModelType(entry: ModelEntry): NonNullable<PublicDownloadRequest['modelType']> {
  const modelType = downloadModelType(entry.kind)
  if (!modelType) throw new Error(`Model ${entry.id} does not use the artifact download owner.`)
  return modelType
}

class DesktopDownloadSources {
  private readonly resolutions = new Map<string, Promise<ResolvedDownloadSource>>()

  private resolveModel(modelId: string): Promise<ResolvedDownloadSource> {
    const active = this.resolutions.get(modelId)
    if (active) return active
    const resolution = (async () => {
      const catalog = CATALOG.find((model) => model.id === modelId)
      const entry =
        catalog ?? (await resolveHuggingFaceModel(modelId, { fetchImpl: platformFetch }))
      if (!entry) throw new Error(`Unknown model: ${modelId}`)
      return { entry, catalogEntry: Boolean(catalog) }
    })().catch((error) => {
      this.resolutions.delete(modelId)
      throw error
    })
    this.resolutions.set(modelId, resolution)
    return resolution
  }

  async request(modelId: string): Promise<PublicDownloadRequest> {
    const { entry } = await this.resolveModel(modelId)
    const primary = primaryFile(entry)
    return {
      modelId: entry.id,
      modelType: publicModelType(entry),
      fileName: primary.name,
      url: primary.url,
      totalBytes: primary.sizeBytes,
      sha256: primary.sha256
    }
  }

  async resolve(request: PublicDownloadRequest): Promise<PublicDownloadSources> {
    const { entry, catalogEntry } = await this.resolveModel(request.modelId)
    return {
      revision: 'desktop-v1',
      displayName: entry.name,
      catalogEntry,
      availability:
        entry.availability === 'coming_soon'
          ? 'coming_soon'
          : entry.artifactDelivery === 'runtime'
            ? 'runtime'
            : 'available',
      unavailableReason: entry.availabilityNote,
      artifacts: entry.files.map((file) => ({
        fileName: file.name,
        url: file.url,
        totalBytes: file.sizeBytes,
        sha256: file.sha256,
        role: file.role
      }))
    }
  }
}

export interface DesktopModelDownloadAdapter {
  ports: ModelsDownloadPorts
  request(modelId: string): Promise<PublicDownloadRequest>
}

export function createDesktopModelDownloadAdapter(input: {
  modelsDir: string
  downloadedRegistry?: AsyncDownloadedModelRegistryPort
  metadataRepair?: DownloadMetadataRepairCommand | null
}): DesktopModelDownloadAdapter {
  const recovery = new DownloadRecoveryStore(
    path.join(input.modelsDir, 'downloads.json'),
    (event, error) => writeDiagnosticLog('models.download-recovery', event, { error }, 'error')
  )
  const nodePorts = createNodeModelDownloadPorts(input.modelsDir)
  const sources = new DesktopDownloadSources()
  return {
    request: (modelId) => sources.request(modelId),
    ports: {
      sources,
      downloadedRegistry:
        input.downloadedRegistry ?? desktopAsyncDownloadedRegistryPorts(input.modelsDir),
      ...(input.metadataRepair === null
        ? {}
        : { metadataRepair: input.metadataRepair ?? desktopDownloadMetadataRepair() }),
      ports: {
        ...nodePorts,
        persistence: {
          read: async () => recovery.read(),
          write: async (records) => recovery.write(records),
          health: async () => {
            const health = recovery.snapshot()
            return health.status === 'healthy'
              ? { status: 'healthy' }
              : { status: 'degraded', reason: health.error }
          }
        },
        finalizer: createDesktopModelDownloadFinalizer({
          modelsDir: input.modelsDir,
          pathFor: nodePorts.files.pathFor
        })
      }
    }
  }
}

export const desktopModelDownloads = createDesktopModelDownloadAdapter({
  modelsDir: llm.getModelsDir()
})
