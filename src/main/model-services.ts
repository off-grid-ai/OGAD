import { randomUUID } from 'crypto'
import os from 'node:os'
import {
  localCatalogRuntimeModels,
  createModelWorkspace,
  decodeModelRouteId,
  runtimeModelRouteId,
  ModelAdmissionError,
  type ModelInventoryAdapter,
  type ModelControlCatalogModel,
  type ModelCapabilities,
  type ModelModality,
  type ModelSelectionStore,
  type ModelReasoningMetadata,
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
  DesktopGenerationObservations,
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
import { registerDesktopModelServices, type DesktopModelServices } from './model-service-access'
import { desktopModelManagerPorts } from './model-manager-ports'
export type { DesktopModelServices } from './model-service-access'

interface DesktopInventoryModel {
  id: string
  familyId?: string
  name?: string
  kind?: string
  files?: Array<{ name?: string; sizeBytes?: number; role?: string }>
  availability?: 'ready' | 'coming_soon'
  runtime?: string
  engine?: string
  remoteServerId?: string
  remoteModelId?: string
  remoteCapabilities?: {
    supportsVision?: boolean
    supportsToolCalling?: boolean
    supportsThinking?: boolean
  }
  grounder?: boolean
  artifactDelivery?: 'catalog' | 'runtime'
}

export type DesktopModelControlCatalogModel = Omit<ModelControlCatalogModel, 'files'> & {
  files?: Array<{ name: string; role?: string }>
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
    typeof value.kind !== 'string'
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
          typeof file.name === 'string'
      ))
  )
}

function requireModelControlCatalogModels(
  values: readonly unknown[]
): DesktopModelControlCatalogModel[] {
  return values.map((value, index) => {
    if (!isModelControlCatalogModel(value)) {
      throw new Error(`Model-control catalog entry ${String(index)} is invalid.`)
    }
    return value
  })
}

interface DesktopModelServicesDependencies {
  listCatalog(): Promise<DesktopInventoryModel[]>
  modelControlCatalog?(): Promise<{
    kinds: readonly string[]
    models: DesktopModelControlCatalogModel[]
  }>
  listInstalled(): Promise<string[]>
  localTextRuntimeState(): Promise<{
    ready: boolean
    loaded: boolean
    reasoning?: ModelReasoningMetadata
    /** The window llama-server runs with; Shared bounds tool results to the room left in it. */
    contextLength?: number
  }>
  localVoiceRuntimeState?(): Promise<{ installed: boolean; ready: boolean; error?: string }>
  localTextLifecycle?: {
    load(): Promise<void>
    unload(): Promise<void>
  }
  resolveLegacyModelId?(modelId: string): Promise<string>
  projectTextSelection?(modelId: string): Promise<{ success: boolean; error?: string }>
  residencySetting?(modality: 'image' | 'stt'): 'resident' | 'on-demand'
}

const SHARED_MODALITIES: readonly ModelModality[] = [
  'text',
  'computer_use',
  'image',
  'voice',
  'transcription',
  'embedding'
]

export function desktopAdapterId(source: 'local' | 'remote', modality: ModelModality): string {
  const prefix = source === 'remote' ? 'desktop.remote-chat' : 'desktop.llama'
  // Vision is a capability of the text runtime, not a second residency or
  // selection authority. Keep legacy callers on the canonical text adapter.
  if (modality === 'text' || modality === 'vision') return prefix
  if (modality === 'computer_use') return `${prefix}.computer-use`
  if (modality === 'image') return source === 'remote' ? 'desktop.remote-image' : 'desktop.image'
  if (modality === 'voice') return source === 'remote' ? 'desktop.remote-voice' : 'desktop.tts'
  if (modality === 'transcription') {
    return source === 'remote' ? 'desktop.remote-transcription' : 'desktop.transcription'
  }
  if (modality === 'embedding') {
    return source === 'remote' ? 'desktop.remote-embedding' : 'desktop.embedding'
  }
  return `${prefix}.${modality.replace('_', '-')}`
}


/**
 * Older Desktop selections can contain a primary filename. This read codec keeps
 * that compatibility at the adapter boundary. New writes use canonical inventory
 * ids; runtime adapters resolve those ids to their platform files.
 */
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
      if (!primary) continue
      this.canonicalByStored.set(primary, model.id)
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
      const routeId = model.routeId ?? runtimeModelRouteId(model)
      this.routeBySelection.set(`${model.modality}:${model.id}`, routeId)
    }
  }

  /**
   * Two file writes and nothing else: the canonical route, and the native runtime's legacy
   * projection of it (active-model.json for the chat engine; active-modalities.json for the rest).
   * Which route is valid was decided by the workspace before this is called.
   */
  async write(modality: ModelModality, modelId: string | null): Promise<void> {
    const route = modelId ? decodeModelRouteId(modelId) : null
    const nativeModelId = route?.modelId ?? modelId
    if (modality === 'text') {
      if (!nativeModelId) this.routes.clearLegacyTextConfig()
      // A remote route leaves the legacy file alone: it remembers the last local model, which is
      // the route "Use remote server: off" returns to.
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
    private readonly dependencies: DesktopModelServicesDependencies,
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
      this.dependencies.listCatalog(),
      this.dependencies.listInstalled(),
      this.dependencies.localTextRuntimeState(),
      this.dependencies.localVoiceRuntimeState?.() ??
        Promise.resolve({ installed: false, ready: false })
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
      residencyPreference: (modality) => this.dependencies.residencySetting?.(modality)
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

export function createDesktopModelServices(
  dependencies: DesktopModelServicesDependencies,
  selectionPersistence: DesktopModelSelectionPersistence = desktopModelSelectionPersistence
): DesktopModelServices {
  const ids = new LegacyDesktopModelIdCodec()
  const selections = new DesktopModelSelectionStore(
    ids,
    selectionPersistence,
    dependencies.projectTextSelection
  )
  const workspace = createModelWorkspace({
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
            .then(() => desktopModelServices.refresh())
            .catch(() => undefined)
        }
        return known
      }
    }
  })
  const llm = workspace.llm
  const source = new DesktopInventorySource(dependencies, ids, selections)
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
    llm.registerAdapter(new DesktopModelInventoryAdapter(adapterId, source))
  }
  const memory = workspace.residency
  const generation = workspace.generation
  const generationObservations = new DesktopGenerationObservations()
  const localGenerationAdapters = new Map<string, DesktopLocalGenerationAdapter>()
  for (const adapterId of [
    'desktop.llama',
    'desktop.llama.classifier',
    'desktop.llama.tool-selection',
    'desktop.llama.computer-use'
  ]) {
    const adapter = new DesktopLocalGenerationAdapter(
      generationObservations,
      adapterId,
      dependencies.localTextLifecycle
    )
    localGenerationAdapters.set(adapterId, adapter)
    generation.registerAdapter(adapter)
  }
  generation.registerAdapter(new DesktopImageGenerationAdapter())
  generation.registerAdapter(new DesktopRemoteImageGenerationAdapter())
  generation.registerAdapter(new DesktopVoiceGenerationAdapter())
  generation.registerAdapter(new DesktopRemoteVoiceGenerationAdapter())
  generation.registerAdapter(new DesktopTranscriptionGenerationAdapter())
  generation.registerAdapter(new DesktopRemoteTranscriptionGenerationAdapter())
  generation.registerAdapter(new DesktopEmbeddingGenerationAdapter())
  generation.registerAdapter(new DesktopRemoteEmbeddingGenerationAdapter())
  for (const adapterId of [
    'desktop.remote-chat',
    'desktop.remote-chat.classifier',
    'desktop.remote-chat.tool-selection',
    'desktop.remote-chat.computer-use'
  ]) {
    generation.registerAdapter(
      new DesktopRemoteGenerationAdapter(generationObservations, adapterId)
    )
  }

  const projectedId = (modality: ModelModality): string | null => {
    const active = llm.active(modality)
    if (active.model?.source === 'remote' && active.model.serverId) {
      return active.model.routeId ?? runtimeModelRouteId(active.model)
    }
    const selectedRoute = active.selectedId ? decodeModelRouteId(active.selectedId) : null
    if (selectedRoute?.serverId) return active.selectedId
    return active.model?.id ?? selectedRoute?.modelId ?? ids.canonical(active.selectedId)
  }

  const activeModalities = (): ReturnType<DesktopModelServices['activeModalities']> => ({
    text: projectedId('text'),
    computer_use: projectedId('computer_use'),
    image: projectedId('image'),
    speech: projectedId('voice'),
    transcription: projectedId('transcription')
  })

  const unloadNative = async (modality: ModelModality): Promise<void> => {
    if (
      modality === 'text' ||
      modality === 'vision' ||
      modality === 'classifier' ||
      modality === 'tool_selection'
    ) {
      await (await import('./llm')).llm.unload()
      return
    }
    if (modality === 'image') {
      await (await import('./imagegen')).imageRuntime.evict()
      return
    }
    if (modality === 'transcription') {
      await (await import('./transcription/select')).sttRuntime.evict()
      return
    }
    if (modality === 'voice') {
      await (await import('./tts')).ttsRuntime.evict()
      return
    }
    if (modality === 'embedding') {
      await (await import('./embeddings')).embeddings.unloadNative()
    }
  }

  return {
    workspace,
    llm,
    generation,
    residency: memory,
    generationObservations,
    refresh: () => llm.refresh(),
    routeIdFor(modality, nativeModelId) {
      if (!nativeModelId) {
        return (
          llm.active(modality).selectedRouteId ??
          llm.list(modality).find((model) => model.ready)?.routeId
        )
      }
      const canonical = ids.canonical(nativeModelId)
      return llm.list(modality).find((model) => model.id === canonical)?.routeId
    },
    async select(modality, modelId) {
      try {
        await llm.refresh()
        if (modelId === null) {
          await workspace.select(modality, null)
          return { success: true }
        }
        // Any id space (route, legacy remote, native, or a stale family alias) resolves to the one
        // route through the workspace; the legacy codec only maps aliases to native ids first.
        const canonicalModelId = dependencies.resolveLegacyModelId
          ? await dependencies.resolveLegacyModelId(modelId)
          : modelId
        const selectedRoute =
          workspace.resolveRoute(modality, modelId) ??
          this.routeIdFor(modality, canonicalModelId)
        if (!selectedRoute) return { success: false, error: 'unknown model' }
        await workspace.select(modality, selectedRoute)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'The model could not be selected.'
        }
      }
    },
    // Through the shared authority, like every other selection change: one writer, one file.
    async clearRemoteServerSelections(serverId) {
      for (const modality of [
        'text',
        'vision',
        'computer_use',
        'image',
        'transcription',
        'voice',
        'embedding',
        'tool_selection'
      ] satisfies ModelModality[]) {
        const selected = selectionPersistence.readCanonical(modality)
        const route = selected ? decodeModelRouteId(selected) : null
        if (route?.serverId !== serverId) continue
        await workspace.select(modality, null)
      }
    },
    async warmText() {
      await llm.refresh()
      const model = llm.active('text').model
      if (!model) {
        throw new Error(
          'Models not downloaded. Please complete onboarding to download the AI model.'
        )
      }
      if (model.source !== 'local') return false
      const adapter = localGenerationAdapters.get(model.adapterId)
      if (!adapter || !model.residentSizeMB) return false
      const routeId = model.routeId ?? runtimeModelRouteId(model)
      const key = `${model.modality}:${routeId}`
      const lease = await memory.acquire(
        {
          key,
          modelId: routeId,
          type: model.modality,
          sizeMB: model.peakSizeMB ?? model.residentSizeMB,
          dirtyMemory: model.dirtyMemory,
          residencyKey: model.residencyKey
        },
        {
          load: () => adapter.load(),
          unload: () => adapter.unload()
        }
      )
      if (!lease.acquired) throw new ModelAdmissionError(model)
      await lease.release()
      return lease.loaded
    },
    async unload(modality) {
      const residents = memory.getResidents().filter((resident) => resident.type === modality)
      let freed = false
      for (const resident of residents) {
        freed = (await memory.evictByKey(resident.key)) || freed
      }
      return freed
    },
    async shutdown() {
      for (const resident of memory.getResidents()) await memory.evictByKey(resident.key)
      await Promise.allSettled([
        unloadNative('text'),
        unloadNative('image'),
        unloadNative('transcription'),
        unloadNative('voice'),
        unloadNative('embedding')
      ])
    },
    async activeModelIds(): Promise<string[]> {
      await llm.refresh()
      const active = SHARED_MODALITIES.flatMap((modality) => {
        const id = projectedId(modality)
        return id ? [id] : []
      })
      return [...new Set(active)]
    },
    activeModalities,
    async modelControlSnapshot() {
      await llm.refresh()
      const catalogRead = dependencies.modelControlCatalog
        ? dependencies.modelControlCatalog()
        : dependencies.listCatalog().then((models) => ({
            kinds: [...new Set(models.flatMap((model) => (model.kind ? [model.kind] : [])))],
            models: requireModelControlCatalogModels(models)
          }))
      const [catalog, installed, computerUse] = await Promise.all([
        catalogRead,
        dependencies.listInstalled(),
        import('./vision/vision-task-model-strategy').then((module) =>
          module.getComputerUseActiveModelProjection()
        )
      ])
      // Every projection decision (which catalog row an active route names, the active text
      // capabilities overlay) is the workspace's; this reads the ports and renders.
      return workspace.controlSnapshot({ catalog, installed, computerUse })
    }
  }
}

export const desktopModelServices = createDesktopModelServices({
  listCatalog: async () => {
    const catalog = await desktopModelManagerPorts.getCatalog()
    return catalog.models as DesktopInventoryModel[]
  },
  modelControlCatalog: async () => {
    const catalog = await desktopModelManagerPorts.getCatalog()
    return {
      kinds: catalog.kinds,
      models: requireModelControlCatalogModels(catalog.models)
    }
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
  resolveLegacyModelId: (modelId) =>
    desktopModelManagerPorts.resolveCanonicalModelSelectionId(modelId),
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

registerDesktopModelServices(desktopModelServices)
