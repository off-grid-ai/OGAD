import { randomUUID } from 'crypto'
import os from 'node:os'
import {
  localCatalogRuntimeModels,
  createModelWorkspace,
  decodeModelRouteId,
  runtimeModelRouteId,
  type ModelInventoryAdapter,
  type GenerationAdapter,
  type ModelModality,
  type ModelSelectionStore,
  type ModelReasoningMetadata,
  type ModelWorkspace,
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

interface DesktopModelWorkspacePorts {
  listCatalog(): Promise<DesktopInventoryModel[]>
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
  projectTextSelection?(modelId: string): Promise<{ success: boolean; error?: string }>
  residencySetting?(modality: 'image' | 'stt'): 'resident' | 'on-demand'
}

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
      this.ports.localVoiceRuntimeState?.() ??
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

export function createDesktopModelWorkspace(
  ports: DesktopModelWorkspacePorts,
  selectionPersistence: DesktopModelSelectionPersistence = desktopModelSelectionPersistence
): ModelWorkspace {
  const ids = new LegacyDesktopModelIdCodec()
  const selections = new DesktopModelSelectionStore(
    ids,
    selectionPersistence,
    ports.projectTextSelection
  )
  const lifecycleAdapters = new Map<string, GenerationAdapter>()
  let lifecycleWorkspace: ReturnType<typeof createModelWorkspace> | null = null
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
    localFallback: (modality) => {
      if (modality !== 'text') return undefined
      const id = desktopModelSelectionPersistence.readLegacyTextConfig().id
      return typeof id === 'string' ? id : undefined
    },
    lifecycle: () => {
      if (!lifecycleWorkspace) throw new Error('Desktop model workspace is not initialized.')
      return desktopModelLifecyclePorts(lifecycleWorkspace, lifecycleAdapters)
    },
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
            .then(() => lifecycleWorkspace?.refresh())
            .catch(() => undefined)
        }
        return known
      }
    }
  })
  lifecycleWorkspace = workspace
  // Adapters register THROUGH the workspace, not through its raw routing and generation owners:
  // reaching inside was the last thing keeping the workspace itself in the platform ports.
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
    workspace.registerInventoryAdapter(new DesktopModelInventoryAdapter(adapterId, source))
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
    workspace.registerGenerationAdapter(adapter)
  }
  const imageAdapter = new DesktopImageGenerationAdapter()
  const voiceAdapter = new DesktopVoiceGenerationAdapter()
  const transcriptionAdapter = new DesktopTranscriptionGenerationAdapter()
  const embeddingAdapter = new DesktopEmbeddingGenerationAdapter()
  for (const adapter of [imageAdapter, voiceAdapter, transcriptionAdapter, embeddingAdapter]) {
    lifecycleAdapters.set(adapter.id, adapter)
    workspace.registerGenerationAdapter(adapter)
  }
  workspace.registerGenerationAdapter(new DesktopRemoteImageGenerationAdapter())
  workspace.registerGenerationAdapter(new DesktopRemoteVoiceGenerationAdapter())
  workspace.registerGenerationAdapter(new DesktopRemoteTranscriptionGenerationAdapter())
  workspace.registerGenerationAdapter(new DesktopRemoteEmbeddingGenerationAdapter())
  for (const adapterId of [
    'desktop.remote-chat',
    'desktop.remote-chat.classifier',
    'desktop.remote-chat.tool-selection',
    'desktop.remote-chat.computer-use'
  ]) {
    workspace.registerGenerationAdapter(
      new DesktopRemoteGenerationAdapter(generationObservations, adapterId)
    )
  }

  return workspace
}

export const desktopModelWorkspace = createDesktopModelWorkspace({
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
