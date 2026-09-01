import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GenerationService as SharedGenerationService,
  LLMService as SharedLLMService,
  ModelResidencyManager,
  decodeModelRouteId,
  encodeModelRouteId,
  type ModelInventoryAdapter,
  type ModelKind,
  type ModelModality,
  type ModelSelectionStore,
  type RuntimeModel
} from '@offgrid/models'
import { getActiveModal, setActiveModal } from './active-models'
import { modelsDir } from './runtime-env'
import {
  activateRemoteVisionModel,
  deactivateRemoteVisionModel,
  getRemoteVisionServerSettings
} from './vision/remote-vision-server'
import { parseRemoteVisionModelId, remoteVisionModelId } from '../shared/remote-vision-server'
import {
  DesktopLocalGenerationAdapter,
  DesktopRemoteGenerationAdapter
} from './model-generation-adapters'

interface DesktopInventoryModel {
  id: string
  name?: string
  kind?: string
  files?: Array<{ name?: string; sizeBytes?: number; role?: string }>
  availability?: 'ready' | 'coming_soon'
  runtime?: string
  engine?: string
  remoteServerId?: string
  remoteModelId?: string
}

interface DesktopModelServicesDependencies {
  listCatalog(): Promise<DesktopInventoryModel[]>
  listInstalled(): Promise<string[]>
  localTextRuntimeState(): Promise<{ ready: boolean; loaded: boolean }>
}

const SHARED_MODALITIES: readonly ModelModality[] = ['text', 'image', 'voice', 'transcription']

function modalityForKind(kind: string | undefined): ModelModality | null {
  if (kind === 'text' || kind === 'vision') return 'text'
  if (kind === 'image' || kind === 'voice' || kind === 'transcription') return kind
  return null
}

function activeTextModelId(): string | null {
  const remote = getRemoteVisionServerSettings()
  const activeRemote = remote.servers.find((server) => server.id === remote.activeServerId)
  if (activeRemote) {
    return encodeModelRouteId({
      adapterId: 'desktop.remote-chat',
      providerId: activeRemote.provider,
      serverId: activeRemote.id,
      modelId: activeRemote.model
    })
  }
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(modelsDir(), 'active-model.json'), 'utf8')
    ) as { id?: unknown }
    return typeof value.id === 'string' && value.id ? value.id : null
  } catch {
    return null
  }
}

/**
 * Desktop persistence uses catalog ids for most models, but older image and STT
 * selections can contain a primary filename. This codec keeps that compatibility
 * at the adapter boundary. The shared service sees only canonical inventory ids.
 */
export class LegacyDesktopModelIdCodec {
  private readonly canonicalByStored = new Map<string, string>()
  private readonly storedByCanonical = new Map<string, string>()

  index(models: readonly DesktopInventoryModel[]): void {
    this.canonicalByStored.clear()
    this.storedByCanonical.clear()
    for (const model of models) {
      this.canonicalByStored.set(model.id, model.id)
      const primary = model.files?.find((file) => file.role !== 'mmproj')?.name
      if (!primary) continue
      this.canonicalByStored.set(primary, model.id)
      this.storedByCanonical.set(model.id, primary)
    }
  }

  canonical(stored: string | null): string | null {
    return stored ? (this.canonicalByStored.get(stored) ?? stored) : null
  }

  stored(modality: ModelModality, canonical: string | null): string | null {
    if (!canonical || modality !== 'image') return canonical
    return this.storedByCanonical.get(canonical) ?? canonical
  }
}

class DesktopRouteSelectionPersistence {
  private file(): string {
    return path.join(modelsDir(), 'model-selections.json')
  }

  read(modality: ModelModality): string | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, unknown>
      return typeof value[modality] === 'string' ? (value[modality] as string) : null
    } catch {
      return null
    }
  }

  write(modality: ModelModality, routeId: string | null): void {
    let value: Record<string, unknown> = {}
    try {
      value = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Record<string, unknown>
    } catch {
      /* first selection */
    }
    value[modality] = routeId
    fs.mkdirSync(path.dirname(this.file()), { recursive: true })
    fs.writeFileSync(this.file(), JSON.stringify(value, null, 2))
  }
}

export class DesktopModelSelectionStore implements ModelSelectionStore {
  constructor(
    private readonly ids: LegacyDesktopModelIdCodec,
    private readonly routes = new DesktopRouteSelectionPersistence()
  ) {}

  read(modality: ModelModality): string | null {
    const routeId = this.routes.read(modality)
    if (routeId) return routeId
    if (modality === 'text') return this.ids.canonical(activeTextModelId())
    const stored = getActiveModal(modality === 'voice' ? 'speech' : modality)
    return this.ids.canonical(stored)
  }

  async write(modality: ModelModality, modelId: string | null): Promise<void> {
    const route = modelId ? decodeModelRouteId(modelId) : null
    const nativeModelId = route?.modelId ?? modelId
    if (modality === 'text') {
      if (!nativeModelId) {
        deactivateRemoteVisionModel()
        fs.rmSync(path.join(modelsDir(), 'active-model.json'), { force: true })
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
      const result = await (await import('./models-manager')).setActiveModel(nativeModelId)
      if (!result.success) throw new Error(result.error ?? 'The model could not be selected.')
      deactivateRemoteVisionModel()
      this.routes.write(modality, modelId)
      return
    }
    const stored = this.ids.stored(modality, nativeModelId)
    setActiveModal(modality === 'voice' ? 'speech' : modality, stored)
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
    const [catalog, installedIds, localTextState] = await Promise.all([
      this.dependencies.listCatalog(),
      this.dependencies.listInstalled(),
      this.dependencies.localTextRuntimeState()
    ])
    this.ids.index(catalog)
    const installed = new Set(installedIds)
    const remoteSettings = getRemoteVisionServerSettings()
    const remoteById = new Map(remoteSettings.servers.map((server) => [server.id, server] as const))
    const activeText = this.selections.read('text')
    const activeTextRoute = activeText ? decodeModelRouteId(activeText) : null

    return catalog.flatMap((model): RuntimeModel[] => {
      const modality = modalityForKind(model.kind)
      if (!modality) return []
      const remote = model.remoteServerId ? remoteById.get(model.remoteServerId) : undefined
      const source = remote ? 'remote' : 'local'
      const isInstalled = source === 'remote' || installed.has(model.id)
      const ready = isInstalled && model.availability !== 'coming_soon'
      const loaded =
        source === 'remote'
          ? activeTextRoute?.serverId === remote?.id &&
            activeTextRoute?.modelId === model.remoteModelId
          : modality === 'text' &&
            (activeTextRoute?.modelId ?? activeText) === model.id &&
            localTextState.loaded
      const adapterId =
        source === 'remote'
          ? 'desktop.remote-chat'
          : modality === 'text'
            ? 'desktop.llama'
            : modality === 'image'
              ? 'desktop.image'
              : modality === 'voice'
                ? 'desktop.tts'
                : 'desktop.transcription'
      return [
        {
          id: remote && model.remoteModelId ? model.remoteModelId : model.id,
          name: model.name?.trim() || model.id,
          kind: (model.kind ?? 'text') as ModelKind,
          modality,
          source,
          adapterId,
          providerId: remote?.provider ?? model.runtime ?? model.engine,
          serverId: remote?.id,
          capabilities: {
            vision: model.kind === 'vision' || source === 'remote',
            tools: modality === 'text'
          },
          installed: isInstalled,
          ready,
          loaded
        }
      ]
    })
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

export interface DesktopModelServices {
  llm: SharedLLMService
  generation: SharedGenerationService
  refresh(): Promise<RuntimeModel[]>
  activeModelIds(): Promise<string[]>
  activeModalities(): {
    text: string | null
    computer_use: string | null
    image: string | null
    speech: string | null
    transcription: string | null
  }
}

export function createDesktopModelServices(
  dependencies: DesktopModelServicesDependencies
): DesktopModelServices {
  const ids = new LegacyDesktopModelIdCodec()
  const selections = new DesktopModelSelectionStore(ids)
  const llm = new SharedLLMService(selections)
  const source = new DesktopInventorySource(dependencies, ids, selections)
  for (const adapterId of [
    'desktop.llama',
    'desktop.remote-chat',
    'desktop.image',
    'desktop.tts',
    'desktop.transcription'
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
    generationTimeoutMs: 300_000
  })
  generation.registerAdapter(new DesktopLocalGenerationAdapter())
  generation.registerAdapter(new DesktopRemoteGenerationAdapter())

  const projectedId = (modality: ModelModality): string | null => {
    const active = llm.active(modality)
    if (active.model?.source === 'remote' && active.model.serverId) {
      return remoteVisionModelId(active.model.serverId, active.model.id)
    }
    return active.model?.id ?? ids.canonical(active.selectedId)
  }

  const activeModalities = (): ReturnType<DesktopModelServices['activeModalities']> => ({
    text: projectedId('text'),
    computer_use: getActiveModal('computer_use'),
    image: projectedId('image'),
    speech: projectedId('voice'),
    transcription: projectedId('transcription')
  })

  return {
    llm,
    generation,
    refresh: () => llm.refresh(),
    async activeModelIds(): Promise<string[]> {
      await llm.refresh()
      const active = SHARED_MODALITIES.flatMap((modality) => {
        const id = projectedId(modality)
        return id ? [id] : []
      })
      const computerUse = getActiveModal('computer_use')
      return [...new Set(computerUse ? [...active, computerUse] : active)]
    },
    activeModalities
  }
}

export const desktopModelServices = createDesktopModelServices({
  listCatalog: async () => {
    const catalog = await (await import('./models-manager')).getCatalog()
    return catalog.models as DesktopInventoryModel[]
  },
  listInstalled: async () => (await import('./models-manager')).listInstalled(),
  localTextRuntimeState: async () => {
    const { llm } = await import('./llm')
    return { ready: llm.isReady(), loaded: llm.isReady() }
  }
})
