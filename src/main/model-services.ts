import os from 'node:os'
import {
  GenerationService as SharedGenerationService,
  LLMService as SharedLLMService,
  ModelResidencyManager,
  decodeModelRouteId,
  runtimeModelRouteId,
  ModelAdmissionError,
  inventoryModelCapabilities,
  inventoryModelMemoryProfile,
  resolveReasoningPlan,
  runtimeModalityForModelKind,
  runtimeResidencyLifecycle,
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
import {
  activateRemoteVisionModel,
  deactivateRemoteVisionModel,
  getRemoteVisionServer,
  getRemoteVisionServerSettings
} from './vision/remote-vision-server'
import { remoteReasoningMetadata } from './llm/remote-chat'
import { parseRemoteVisionModelId } from '../shared/remote-vision-server'
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

/** A persisted runtime route cannot be presented as a ready model-control selection. */
export class DesktopModelProjectionError extends Error {
  readonly code = 'model_control_route_unresolved' as const

  constructor(readonly routeId: string) {
    super('The active model route is unavailable in the model-control catalog.')
    this.name = 'DesktopModelProjectionError'
  }
}

function projectActiveTextCapabilities(
  models: readonly DesktopModelControlCatalogModel[],
  activeModelId: string | null,
  capabilities: ModelCapabilities | null
): DesktopModelControlCatalogModel[] {
  if (!activeModelId || !capabilities) return [...models]
  return models.map((model) =>
    model.id === activeModelId ? { ...model, capabilities: { ...capabilities } } : model
  )
}

/** Convert the runtime route identity into the catalog identity used by model-control clients. */
export function projectActiveTextCatalogId(
  models: readonly DesktopModelControlCatalogModel[],
  selectedId: string | null
): string | null {
  if (!selectedId) return null
  const route = decodeModelRouteId(selectedId)
  const selected = route
    ? route.serverId
      ? models.find(
          (model) =>
            model.remoteServerId === route.serverId && model.remoteModelId === route.modelId
        )
      : models.find((model) => model.id === route.modelId)
    : models.find((model) => model.id === selectedId)
  if (!selected) throw new DesktopModelProjectionError(selectedId)
  return selected.id
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

function runtimeSizes(model: DesktopInventoryModel): {
  residentSizeMB?: number
  peakSizeMB?: number
} {
  const bytes = (model.files ?? []).reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0)
  return inventoryModelMemoryProfile({
    artifactBytes: bytes,
    kind: model.kind,
    remote: Boolean(model.remoteServerId)
  })
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

  async write(modality: ModelModality, modelId: string | null): Promise<void> {
    const route = modelId ? decodeModelRouteId(modelId) : null
    const nativeModelId = route?.modelId ?? modelId
    if (modality === 'text') {
      if (!nativeModelId) {
        deactivateRemoteVisionModel()
        this.routes.clearLegacyTextConfig()
        this.routes.write(modality, null)
        return
      }
      const legacyRemote = parseRemoteVisionModelId(nativeModelId)
      const remote = route?.serverId
        ? { serverId: route.serverId, modelId: route.modelId }
        : legacyRemote
      if (remote) {
        if (!activateRemoteVisionModel(remote.serverId, remote.modelId)) {
          throw new Error('Remote model is no longer available.')
        }
        this.routes.write(modality, modelId)
        return
      }
      if (this.projectTextSelection) {
        const result = await this.projectTextSelection(nativeModelId)
        if (!result.success) throw new Error(result.error ?? 'The model could not be selected.')
      }
      deactivateRemoteVisionModel()
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
    const installed = new Set(installedIds)
    const remoteSettings = getRemoteVisionServerSettings()
    const remoteById = new Map(remoteSettings.servers.map((server) => [server.id, server] as const))
    const remoteReasoningById = new Map(
      await Promise.all(
        remoteSettings.servers.map(async (server) => {
          const connection = getRemoteVisionServer(server.id)
          return [
            server.id,
            connection ? await remoteReasoningMetadata(connection) : undefined
          ] as const
        })
      )
    )
    const activeText = this.selections.read('text')
    const activeTextRoute = activeText ? decodeModelRouteId(activeText) : null
    const residencyLifecycle = (
      modality: 'image' | 'stt'
    ): NonNullable<RuntimeModel['residencyLifecycle']> =>
      runtimeResidencyLifecycle(this.dependencies.residencySetting?.(modality) ?? 'on-demand')

    const expandTextRoutes = (base: RuntimeModel): RuntimeModel[] => {
      const route = (
        routeModality: ModelModality,
        adapterId: string,
        capabilities: RuntimeModel['capabilities']
      ): RuntimeModel => ({ ...base, modality: routeModality, adapterId, capabilities })
      const prefix = base.source === 'remote' ? 'desktop.remote-chat' : 'desktop.llama'
      return [
        base,
        route('classifier', `${prefix}.classifier`, { classification: true, streaming: true }),
        ...(base.capabilities.tools
          ? [
              route('tool_selection', `${prefix}.tool-selection`, {
                tools: true,
                toolSelection: true,
                thinking: base.capabilities.thinking,
                streaming: true,
                structuredOutput: true
              })
            ]
          : []),
        ...(base.capabilities.vision && base.capabilities.tools
          ? [
              route('computer_use', `${prefix}.computer-use`, {
                vision: true,
                computerUse: true,
                tools: true,
                toolSelection: true,
                thinking: base.capabilities.thinking,
                streaming: true,
                structuredOutput: true
              })
            ]
          : [])
      ]
    }

    const catalogRoutes = catalog.flatMap((model): RuntimeModel[] => {
      const modality = runtimeModalityForModelKind(model.kind)
      if (!modality) return []
      const remote = model.remoteServerId ? remoteById.get(model.remoteServerId) : undefined
      const source = remote ? 'remote' : 'local'
      const runtimeManagedVoice =
        source === 'local' && modality === 'voice' && model.artifactDelivery === 'runtime'
      const isInstalled = runtimeManagedVoice
        ? localVoiceState.installed
        : source === 'remote' || installed.has(model.id)
      const ready =
        isInstalled &&
        model.availability !== 'coming_soon' &&
        (!runtimeManagedVoice || localVoiceState.ready)
      const loaded =
        source === 'remote'
          ? activeTextRoute?.serverId === remote?.id &&
            activeTextRoute?.modelId === model.remoteModelId
          : modality === 'text' &&
            (activeTextRoute?.modelId ?? activeText) === model.id &&
            localTextState.loaded
      const adapterId = desktopAdapterId(source, modality)
      const reasoning = remote
        ? remoteReasoningById.get(remote.id)
        : modality === 'text' || modality === 'computer_use'
          ? localTextState.reasoning
          : undefined
      const capabilities = inventoryModelCapabilities({
        kind: model.kind,
        source,
        remoteCapabilities: model.remoteCapabilities
      })
      if (source === 'local' && loaded && (modality === 'text' || modality === 'computer_use')) {
        capabilities.thinking =
          resolveReasoningPlan({ enabled: true }, reasoning).disposition === 'controlled'
      }
      const base: RuntimeModel = {
        id: remote && model.remoteModelId ? model.remoteModelId : model.id,
        name: model.name?.trim() || model.id,
        kind: (model.kind ?? 'text') as RuntimeModel['kind'],
        modality,
        source,
        adapterId,
        providerId: remote?.provider ?? model.runtime ?? model.engine,
        serverId: remote?.id,
        reasoning,
        contextLength:
          source === 'local' && modality === 'text' ? localTextState.contextLength : undefined,
        ...runtimeSizes(model),
        dirtyMemory: modality === 'image',
        residencyLifecycle:
          modality === 'image'
            ? residencyLifecycle('image')
            : modality === 'transcription'
              ? residencyLifecycle('stt')
              : modality === 'voice'
                ? 'operation'
                : 'persistent',
        capabilities,
        installed: isInstalled,
        ready,
        loaded
      }
      if (modality !== 'text') return [base]
      return expandTextRoutes(base)
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
  const llm = new SharedLLMService(selections)
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
  const memory = new ModelResidencyManager({
    current: () => ({
      totalMB: os.totalmem() / (1024 * 1024),
      availableMB: os.freemem() / (1024 * 1024),
      platform: 'desktop'
    })
  })
  const generation = new SharedGenerationService(llm, memory, {
    // No deadline: a generation runs until it finishes or the user stops it.
    tools: desktopToolExecutor
  })
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
          await llm.select(modality, null)
          return { success: true }
        }
        const remote = parseRemoteVisionModelId(modelId)
        const canonicalModelId = dependencies.resolveLegacyModelId
          ? await dependencies.resolveLegacyModelId(modelId)
          : modelId
        const selectedRoute = decodeModelRouteId(modelId)
          ? modelId
          : remote
            ? llm
                .list(modality)
                .find((model) => model.serverId === remote.serverId && model.id === remote.modelId)
                ?.routeId
            : this.routeIdFor(modality, canonicalModelId)
        if (!selectedRoute) return { success: false, error: 'unknown model' }
        await llm.select(modality, selectedRoute)
        return { success: true }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'The model could not be selected.'
        }
      }
    },
    clearRemoteServerSelections(serverId) {
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
        selectionPersistence.write(modality, null)
        selectionPersistence.projectLegacyModality(modality, null)
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
      const runtimeActive = activeModalities()
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
      const activeTextCapabilities = llm.active('text').model?.capabilities ?? null
      const active = {
        ...runtimeActive,
        text: projectActiveTextCatalogId(catalog.models, runtimeActive.text)
      }
      const activeIds = [
        ...new Set(Object.values(active).filter((id): id is string => Boolean(id)))
      ]
      return {
        kinds: [...catalog.kinds],
        models: projectActiveTextCapabilities(catalog.models, active.text, activeTextCapabilities),
        installed,
        activeIds,
        active,
        computerUse
      }
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
