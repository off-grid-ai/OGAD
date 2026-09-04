import { randomUUID } from 'crypto'
import os from 'node:os'
import {
  decodeModelRouteId,
  localCatalogRuntimeModels,
  runtimeModelRouteId,
  type ModelInventoryAdapter,
  type GenerationAdapter,
  type ModelModality,
  type ModelSelectionStore,
  type ModelWorkspacePorts,
  type RuntimeModel
} from '@offgrid/models'
import {
  DesktopModelSelectionPersistence,
  desktopModelSelectionPersistence
} from './model-selection-persistence'
import { getRemoteVisionServer, desktopRemoteServerPorts } from './vision/remote-vision-server'
import { peekRemoteReasoningMetadata, remoteReasoningMetadata } from './llm/remote-chat'
import {
  DesktopLocalGenerationAdapter,
  desktopGenerationObservations,
  DesktopRemoteGenerationAdapter,
  DesktopImageGenerationAdapter,
  DesktopVoiceGenerationAdapter,
  DesktopTranscriptionGenerationAdapter,
  DesktopRemoteImageGenerationAdapter,
  DesktopRemoteVoiceGenerationAdapter,
  DesktopRemoteTranscriptionGenerationAdapter,
  DesktopRemoteEmbeddingGenerationAdapter,
  DesktopEmbeddingGenerationAdapter
} from './model-generation-adapters'
import { desktopToolExecutor } from './desktop-tool-executor'
import { getResidencyMode } from './runtime-residency'
import './models-manager'
import { desktopModelManagerPorts } from './model-manager-ports'
import { desktopModelLifecyclePorts } from './composition/model-lifecycle'
import { refreshDesktopModels } from './composition/application-access'
import {
  desktopAdapterId,
  type DesktopInventoryModel,
  type DesktopModelWorkspacePorts
} from './model-selection-adapter'

export { desktopAdapterId }

export class LegacyDesktopModelIdCodec {
  private readonly canonicalByStored = new Map<string, string>()

  index(models: readonly DesktopInventoryModel[]): void {
    this.canonicalByStored.clear()
    const familyCounts = new Map<string, number>()
    for (const model of models) {
      if (model.familyId) {
        familyCounts.set(model.familyId, (familyCounts.get(model.familyId) ?? 0) + 1)
      }
    }
    for (const model of models) {
      this.canonicalByStored.set(model.id, model.id)
      if (model.familyId && familyCounts.get(model.familyId) === 1) {
        this.canonicalByStored.set(model.familyId, model.id)
      }
      const primary = model.files?.find((file) => file.role !== 'mmproj')?.name
      if (primary) this.canonicalByStored.set(primary, model.id)
    }
  }

  canonical(stored: string | null): string | null {
    return stored ? (this.canonicalByStored.get(stored) ?? stored) : null
  }
}

export class DesktopModelSelectionStore implements ModelSelectionStore {
  private readonly routeBySelection = new Map<string, string>()

  constructor(
    private readonly ids: LegacyDesktopModelIdCodec,
    private readonly routes: DesktopModelSelectionPersistence = desktopModelSelectionPersistence,
    private readonly projectTextSelection?: (
      modelId: string
    ) => Promise<{ success: boolean; error?: string }>
  ) {}

  read(modality: ModelModality): string | null {
    const stored = this.routes.readCanonical(modality)
    if (stored && decodeModelRouteId(stored)) return stored
    const candidate = this.ids.canonical(stored ?? this.routes.projectedModelId(modality))
    if (!candidate) return null
    const canonicalRoute = this.routeBySelection.get(`${modality}:${candidate}`)
    if (canonicalRoute) {
      this.routes.write(modality, canonicalRoute)
      return canonicalRoute
    }
    return candidate
  }

  indexRoutes(models: readonly RuntimeModel[]): void {
    this.routeBySelection.clear()
    for (const model of models) {
      this.routeBySelection.set(
        `${model.modality}:${model.id}`,
        model.routeId ?? runtimeModelRouteId(model)
      )
    }
  }

  async write(modality: ModelModality, modelId: string | null): Promise<void> {
    const route = modelId ? decodeModelRouteId(modelId) : null
    const nativeModelId = route?.modelId ?? modelId
    if (modality === 'text') {
      if (!nativeModelId) this.routes.clearLegacyTextConfig()
      else if (!route?.serverId && this.projectTextSelection) {
        const result = await this.projectTextSelection(nativeModelId)
        if (!result.success) throw new Error(result.error ?? 'The model could not be selected.')
      }
      this.routes.write(modality, modelId)
      return
    }
    this.routes.projectLegacyModality(modality, nativeModelId)
    this.routes.write(modality, modelId)
  }
}

class DesktopInventorySource {
  private inFlight: Promise<RuntimeModel[]> | null = null
  constructor(
    private readonly ports: DesktopModelWorkspacePorts,
    private readonly ids: LegacyDesktopModelIdCodec,
    private readonly selections: DesktopModelSelectionStore
  ) {}

  listModels(): Promise<RuntimeModel[]> {
    if (!this.inFlight) {
      this.inFlight = this.readModels().finally(() => {
        this.inFlight = null
      })
    }
    return this.inFlight
  }

  private async readModels(): Promise<RuntimeModel[]> {
    const [catalog, installedIds, localTextState, localVoiceState] = await Promise.all([
      this.ports.listCatalog(),
      this.ports.listInstalled(),
      this.ports.localTextRuntimeState(),
      this.ports.localVoiceRuntimeState?.() ?? Promise.resolve({ installed: false, ready: false })
    ])
    this.ids.index(catalog)
    // Shared owns the local inventory projection (installed, ready, loaded, memory, residency,
    // derived text routes); this root hands in facts and names the executors.
    const catalogRoutes = localCatalogRuntimeModels({
      catalog,
      installedIds,
      activeText: this.selections.read('text'),
      textRuntime: localTextState,
      voiceRuntime: localVoiceState,
      adapterId: (modality) => desktopAdapterId('local', modality),
      residencyPreference: (modality) => this.ports.residencySetting?.(modality)
    })

    const embeddingRoute: RuntimeModel = {
      id: 'all-MiniLM-L6-v2',
      name: 'MiniLM embeddings',
      kind: 'embedding',
      modality: 'embedding',
      source: 'local',
      adapterId: 'desktop.embedding',
      providerId: 'transformers.js',
      capabilities: { embeddings: true },
      installed: true,
      ready: true,
      loaded: false,
      residentSizeMB: 96,
      peakSizeMB: 160,
      residencyLifecycle: 'persistent'
    }
    const routes = [...catalogRoutes, embeddingRoute]
    this.selections.indexRoutes(routes)
    return routes
  }
}

class DesktopModelInventoryAdapter implements ModelInventoryAdapter {
  constructor(
    readonly id: string,
    private readonly source: DesktopInventorySource
  ) {}

  async listModels(): Promise<RuntimeModel[]> {
    return (await this.source.listModels()).filter((model) => model.adapterId === this.id)
  }
}

/**
 * The workspace's own I/O plus the adapters this device can run. Nothing here is an owner: shared's
 * composition root composes the ONE `ModelWorkspace` from these ports and registers these adapters
 * into it, which is why desktop no longer builds or holds an instance of its own.
 */
export type DesktopModelPlatformPorts = ModelWorkspacePorts & {
  readonly inventoryAdapters: readonly ModelInventoryAdapter[]
  readonly generationAdapters: readonly GenerationAdapter[]
}

export function createDesktopModelWorkspacePorts(
  ports: DesktopModelWorkspacePorts,
  selectionPersistence: DesktopModelSelectionPersistence = desktopModelSelectionPersistence
): DesktopModelPlatformPorts {
  const ids = new LegacyDesktopModelIdCodec()
  const selections = new DesktopModelSelectionStore(
    ids,
    selectionPersistence,
    ports.projectTextSelection
  )
  const lifecycleAdapters = new Map<string, GenerationAdapter>()
  const workspacePorts: ModelWorkspacePorts = {
    selection: selections,
    memory: {
      current: () => ({
        totalMB: os.totalmem() / (1024 * 1024),
        availableMB: os.freemem() / (1024 * 1024),
        platform: 'desktop'
      })
    },
    // No deadline: a generation runs until it finishes or the user stops it.
    generation: { tools: desktopToolExecutor },
    remote: desktopRemoteServerPorts,
    remoteServerId: randomUUID,
    localFallback: (modality) => {
      if (modality !== 'text') return undefined
      const id = selectionPersistence.readLegacyTextConfig().id
      return typeof id === 'string' ? id : undefined
    },
    // Shared composes these on demand. The lifecycle ports reach routing through the Models facade,
    // so building them needs no workspace - and the residency reads shared offers this factory are
    // not needed here, because every capability these ports use is routing.
    lifecycle: () => desktopModelLifecyclePorts(lifecycleAdapters),
    remoteInventory: {
      adapterId: (modality) => desktopAdapterId('remote', modality),
      // Inventory never waits on the network: answer from the cache, probe in the background, and
      // refresh inventory when the dialect is known.
      reasoning: (server) => {
        const connection = getRemoteVisionServer(server.id)
        if (!connection) return undefined
        const known = peekRemoteReasoningMetadata(connection)
        if (!known) {
          void remoteReasoningMetadata(connection)
            .then(refreshDesktopModels)
            .catch((cause) => {
              console.error('[models] Failed to refresh remote reasoning metadata:', cause)
            })
        }
        return known
      }
    }
  }
  // Adapters are DECLARED here and registered by shared's root into the workspace it composes.
  // Registering them ourselves would mean holding a workspace to register them through, which is
  // the exact instance this app must not hold.
  const inventoryAdapters: ModelInventoryAdapter[] = []
  const generationAdapters: GenerationAdapter[] = []
  const source = new DesktopInventorySource(ports, ids, selections)
  for (const adapterId of [
    'desktop.llama',
    'desktop.llama.classifier',
    'desktop.llama.tool-selection',
    'desktop.llama.computer-use',
    'desktop.remote-chat',
    'desktop.remote-chat.classifier',
    'desktop.remote-chat.tool-selection',
    'desktop.remote-chat.computer-use',
    'desktop.image',
    'desktop.remote-image',
    'desktop.tts',
    'desktop.remote-voice',
    'desktop.transcription',
    'desktop.remote-transcription',
    'desktop.embedding',
    'desktop.remote-embedding'
  ]) {
    inventoryAdapters.push(new DesktopModelInventoryAdapter(adapterId, source))
  }
  const generationObservations = desktopGenerationObservations
  for (const adapterId of [
    'desktop.llama',
    'desktop.llama.classifier',
    'desktop.llama.tool-selection',
    'desktop.llama.computer-use'
  ]) {
    const adapter = new DesktopLocalGenerationAdapter(
      generationObservations,
      adapterId,
      ports.localTextLifecycle
    )
    lifecycleAdapters.set(adapterId, adapter)
    generationAdapters.push(adapter)
  }
  const imageAdapter = new DesktopImageGenerationAdapter()
  const voiceAdapter = new DesktopVoiceGenerationAdapter()
  const transcriptionAdapter = new DesktopTranscriptionGenerationAdapter()
  const embeddingAdapter = new DesktopEmbeddingGenerationAdapter()
  for (const adapter of [imageAdapter, voiceAdapter, transcriptionAdapter, embeddingAdapter]) {
    lifecycleAdapters.set(adapter.id, adapter)
    generationAdapters.push(adapter)
  }
  generationAdapters.push(new DesktopRemoteImageGenerationAdapter())
  generationAdapters.push(new DesktopRemoteVoiceGenerationAdapter())
  generationAdapters.push(new DesktopRemoteTranscriptionGenerationAdapter())
  generationAdapters.push(new DesktopRemoteEmbeddingGenerationAdapter())
  for (const adapterId of [
    'desktop.remote-chat',
    'desktop.remote-chat.classifier',
    'desktop.remote-chat.tool-selection',
    'desktop.remote-chat.computer-use'
  ]) {
    generationAdapters.push(new DesktopRemoteGenerationAdapter(generationObservations, adapterId))
  }

  return { ...workspacePorts, inventoryAdapters, generationAdapters }
}

export const desktopModelWorkspacePorts = createDesktopModelWorkspacePorts({
  listCatalog: async () => {
    const catalog = await desktopModelManagerPorts.getCatalog()
    return catalog.models as DesktopInventoryModel[]
  },
  listInstalled: () => desktopModelManagerPorts.listInstalled(),
  localTextRuntimeState: async () => {
    const { llm } = await import('./llm')
    return {
      ready: llm.isReady(),
      loaded: llm.isReady(),
      reasoning: llm.getReasoningMetadata(),
      contextLength: llm.effectiveContextSize()
    }
  },
  localVoiceRuntimeState: async () => {
    const { inspectTtsRuntimeState } = await import('./tts')
    return inspectTtsRuntimeState()
  },
  projectTextSelection: (modelId) =>
    desktopModelManagerPorts.projectActiveTextModelSelection(modelId),
  residencySetting: (modality) => {
    try {
      return getResidencyMode(modality)
    } catch {
      return 'on-demand'
    }
  }
})
