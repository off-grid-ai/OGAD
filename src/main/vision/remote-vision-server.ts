import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { modelsDir } from '../runtime-env'
import {
  REMOTE_FETCH_REDIRECT_POLICY,
  RemoteServerApplicationService,
  canReconcileCredentialedEndpoint,
  catalogFromDiscovery,
  defaultRemoteSelections,
  discoveryFromRemoteModelList,
  migrateRemoteServerConfiguration,
  normalizeRemoteServerConfiguration,
  mergeRemoteSelections,
  hasRemoteServerSelection,
  remoteAuthorizationHeaders,
  remoteModelListUrl,
  type RemoteModelCatalog,
  type RemoteModalitySelections,
  type PersistedRemoteServer
} from '@offgrid/models'
import { decodeModelRouteId } from '@offgrid/models'
import { desktopModelSelectionPersistence } from '../model-selection-persistence'
import { desktopModelServices } from '../model-service-access'
import { deleteSecret, getSecret, setSecret } from '../secrets'
import {
  REMOTE_VISION_PROVIDERS,
  remoteVisionApiBase,
  remoteVisionEndpoint,
  remoteVisionModelId,
  type RemoteVisionConnectionResult,
  type RemoteVisionProvider,
  type RemoteVisionSavedServer,
  type RemoteVisionServerSettings,
  type RemoteVisionServerUpdate
} from '../../shared/remote-vision-server'

const LEGACY_API_KEY_SECRET = 'remote-vision-server:api-key'
const CONFIG_VERSION = 4

interface StoredRemoteVisionServer {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  selections: RemoteModalitySelections
  catalog: RemoteModelCatalog
  screenFramesAllowed: boolean
}

interface StoredRemoteVisionConfig {
  version: 4
  activeServerId: string | null
  servers: StoredRemoteVisionServer[]
}

interface LegacyStoredRemoteVisionServer {
  provider: RemoteVisionProvider
  endpoint: string
  model: string
}

export type RemoteVisionServerConnection = Omit<RemoteVisionSavedServer, 'hasApiKey'> & {
  apiKey: string
}

function configPath(): string {
  return path.join(modelsDir(), 'remote-vision-server.json')
}

function secretKey(serverId: string): string {
  return `remote-model-server:${serverId}:api-key`
}

function defaultServerName(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'Remote server'
  }
}

function validProvider(provider: unknown): provider is RemoteVisionProvider {
  return (
    typeof provider === 'string' &&
    REMOTE_VISION_PROVIDERS.includes(provider as RemoteVisionProvider)
  )
}

function normalizeServer(
  value: Partial<StoredRemoteVisionServer>
): StoredRemoteVisionServer | null {
  if (!validProvider(value.provider)) return null
  const normalized = normalizeRemoteServerConfiguration({
    ...value,
    provider: value.provider === 'ogad' ? 'offgrid-desktop' : value.provider
  })
  if (
    !normalized ||
    !Object.values(normalized.selections ?? {}).some(
      (selection) => typeof selection === 'string' && selection.trim()
    )
  )
    return null
  const desktopProvider =
    normalized.provider === 'offgrid-desktop'
      ? 'ogad'
      : normalized.provider === 'openai-compatible' || normalized.provider === 'anthropic'
        ? 'custom'
        : normalized.provider
  if (!validProvider(desktopProvider)) return null
  return {
    id: normalized.id,
    name: normalized.name,
    provider: desktopProvider,
    endpoint: normalized.endpoint,
    model: normalized.selections?.text?.trim() || '',
    selections: normalized.selections ?? {},
    catalog: normalized.catalog ?? {},
    screenFramesAllowed: normalized.screenFramesAllowed === true
  }
}

function sharedConfiguration(
  stored: StoredRemoteVisionConfig
): ReturnType<typeof migrateRemoteServerConfiguration> {
  return {
    version: 1,
    activeServerId: stored.activeServerId,
    servers: stored.servers.map((server) => ({
      ...server,
      provider: server.provider === 'ogad' ? 'offgrid-desktop' : server.provider
    }))
  }
}

function desktopProvider(provider: PersistedRemoteServer['provider']): RemoteVisionProvider {
  if (provider === 'offgrid-desktop') return 'ogad'
  if (provider === 'ollama' || provider === 'lmstudio' || provider === 'openrouter') return provider
  return 'custom'
}

function storedFromShared(server: PersistedRemoteServer): StoredRemoteVisionServer {
  return {
    id: server.id,
    name: server.name,
    provider: desktopProvider(server.provider) as Exclude<RemoteVisionProvider, 'local'>,
    endpoint: server.endpoint,
    model: server.selections?.text ?? '',
    selections: server.selections ?? {},
    catalog: server.catalog ?? {},
    screenFramesAllowed: server.screenFramesAllowed === true
  }
}

function readStored(): StoredRemoteVisionConfig {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as
      | StoredRemoteVisionConfig
      | LegacyStoredRemoteVisionServer
    const migrated = migrateRemoteServerConfiguration(value)
    const servers = migrated.servers.flatMap((server) => {
      const normalized = normalizeServer({
        ...server,
        provider:
          server.provider === 'offgrid-desktop'
            ? 'ogad'
            : server.provider === 'openai-compatible' || server.provider === 'anthropic'
              ? 'custom'
              : server.provider,
        model: server.selections?.text ?? ''
      })
      return normalized ? [normalized] : []
    })
    return {
      version: CONFIG_VERSION,
      activeServerId: servers.some((server) => server.id === migrated.activeServerId)
        ? migrated.activeServerId
        : null,
      servers
    }
  } catch {
    return { version: CONFIG_VERSION, activeServerId: null, servers: [] }
  }
}

function writeStored(value: StoredRemoteVisionConfig): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(value, null, 2))
}

function serverApiKey(serverId: string): string {
  return (
    getSecret(secretKey(serverId)) ??
    (serverId === 'migrated-server' ? getSecret(LEGACY_API_KEY_SECRET) : null) ??
    ''
  )
}

function transportApiKey(server: StoredRemoteVisionServer): string {
  const key = serverApiKey(server.id)
  return key && canReconcileCredentialedEndpoint(server.endpoint, true) ? key : ''
}

function publicServer(server: StoredRemoteVisionServer): RemoteVisionSavedServer {
  return { ...server, hasApiKey: Boolean(serverApiKey(server.id)) }
}

const desktopRemoteServerApplication = new RemoteServerApplicationService(
  {
    configuration: {
      read: () => {
        const configuration = sharedConfiguration(readStored())
        const selected = desktopModelSelectionPersistence.readCanonical('text')
        const route = selected ? decodeModelRouteId(selected) : null
        return {
          ...configuration,
          activeServerId: route?.adapterId === 'desktop.remote-chat'
            ? route.serverId ?? null
            : null
        }
      },
      async write(value) {
        writeStored({
          version: CONFIG_VERSION,
          activeServerId: null,
          servers: value.servers.map(storedFromShared)
        })
        await desktopModelServices.refresh()
      }
    },
    credentials: {
      async read(serverId) { return serverApiKey(serverId) || null },
      async write(serverId, value) { setSecret(secretKey(serverId), value) },
      async remove(serverId) { deleteSecret(secretKey(serverId)) }
    },
    providers: {
      async register() {},
      async update() {},
      async unregister() {}
    },
    async select(modality, route) {
      const selected = await desktopModelServices.select(
        modality,
        route ? remoteVisionModelId(route.serverId, route.modelId) : null
      )
      if (!selected.success) throw new Error(selected.error)
    },
    async clearSelections(serverId) {
      desktopModelServices.clearRemoteServerSelections(serverId)
    },
    async test(server, credential) {
      const startedAt = Date.now()
      try {
        const response = await fetch(remoteModelListUrl(server.endpoint), {
          headers: remoteAuthorizationHeaders(server.endpoint, credential),
          signal: AbortSignal.timeout(10_000),
          redirect: REMOTE_FETCH_REDIRECT_POLICY
        })
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`)
        const evidence = discoveryFromRemoteModelList(await response.json())
        if (!evidence) throw new Error('The server returned an invalid model list.')
        const catalog = catalogFromDiscovery(evidence)
        return {
          success: true,
          latency: Date.now() - startedAt,
          models: evidence.models,
          catalog,
          selections: mergeRemoteSelections(
            server.selections,
            defaultRemoteSelections(catalog),
            server.modelManagement === 'offgrid-desktop-v1'
          )
        }
      } catch (error) {
        return {
          success: false,
          latency: Date.now() - startedAt,
          error: error instanceof Error ? error.message : 'Connection failed.'
        }
      }
    }
  },
  randomUUID
)

function selectedRemoteServer(stored: StoredRemoteVisionConfig): StoredRemoteVisionServer | null {
  const selected = desktopModelSelectionPersistence.readCanonical('text')
  const route = selected ? decodeModelRouteId(selected) : null
  if (route?.adapterId === 'desktop.remote-chat' && route.serverId) {
    return (
      stored.servers.find(
        (server) => server.id === route.serverId && server.selections.text === route.modelId
      ) ?? null
    )
  }
  return null
}

export function getRemoteVisionServerSettings(): RemoteVisionServerSettings {
  const stored = readStored()
  const active = selectedRemoteServer(stored)
  return {
    provider: active?.provider ?? 'local',
    endpoint: active?.endpoint ?? '',
    model: active?.model ?? '',
    hasApiKey: active ? Boolean(serverApiKey(active.id)) : false,
    activeServerId: active?.id ?? null,
    servers: stored.servers.map(publicServer)
  }
}

export function getActiveRemoteVisionServer(): RemoteVisionServerConnection | null {
  const stored = readStored()
  const active = selectedRemoteServer(stored)
  return active ? { ...active, apiKey: transportApiKey(active) } : null
}

/** Resolve one persisted server for a route selected by the shared model service. */
export function getRemoteVisionServer(serverId: string): RemoteVisionServerConnection | null {
  const server = readStored().servers.find((candidate) => candidate.id === serverId)
  return server ? { ...server, apiKey: transportApiKey(server) } : null
}

export function activateRemoteVisionModel(serverId: string, modelId: string): boolean {
  const stored = readStored()
  return stored.servers.some(
    server => server.id === serverId && server.selections.text === modelId
  )
}

export function deactivateRemoteVisionModel(): void {}

export async function setRemoteVisionServerSettings(
  update: RemoteVisionServerUpdate
): Promise<RemoteVisionServerSettings> {
  if (update.provider === 'local') {
    const previousLocal = desktopModelSelectionPersistence.readLegacyTextConfig().id
    const selected = await desktopModelServices.select(
      'text',
      typeof previousLocal === 'string' ? previousLocal : null
    )
    if (!selected.success) throw new Error(selected.error)
    return getRemoteVisionServerSettings()
  }
  if (!validProvider(update.provider)) throw new Error('Unknown model server.')
  const endpoint = remoteVisionApiBase(remoteVisionEndpoint(update.provider, update.endpoint))
  const model = update.model.trim()
  if (!endpoint) throw new Error('Remote model server is required.')
  const id = update.serverId || randomUUID()
  const existing = desktopRemoteServerApplication.get(id)
  const catalog =
    update.catalog ??
    existing?.catalog ??
    (model ? { text: [{ id: model, name: model, capabilities: { supportsVision: true } }] } : {})
  const selections = update.selections ?? existing?.selections ?? (model ? { text: model } : {})
  if (!hasRemoteServerSelection({ selections })) throw new Error('Select at least one remote model.')
  await desktopRemoteServerApplication.save({
    id,
    name: update.name?.trim() || defaultServerName(endpoint),
    provider: update.provider === 'ogad' ? 'offgrid-desktop' : update.provider === 'custom'
      ? 'openai-compatible' : update.provider,
    endpoint,
    selections,
    catalog,
    screenFramesAllowed: update.screenFramesAllowed === true,
    credential: update.apiKey?.trim() || undefined,
    clearCredential: update.clearApiKey === true
  })
  for (const [remoteModality, selectedModel] of Object.entries(selections)) {
    if (typeof selectedModel !== 'string' || !selectedModel) continue
    await desktopRemoteServerApplication.activate(
      id,
      remoteModality as 'text' | 'image' | 'transcription' | 'voice' | 'embedding',
      selectedModel
    )
  }
  return getRemoteVisionServerSettings()
}

export async function removeRemoteVisionServer(
  serverId: string
): Promise<RemoteVisionServerSettings> {
  await desktopRemoteServerApplication.remove(serverId)
  return getRemoteVisionServerSettings()
}

export async function testRemoteVisionServer(
  update: RemoteVisionServerUpdate
): Promise<RemoteVisionConnectionResult> {
  if (update.provider === 'local') return { ok: true, latencyMs: 0 }
  const endpoint = remoteVisionApiBase(remoteVisionEndpoint(update.provider, update.endpoint))
  if (!endpoint) return { ok: false, latencyMs: 0, error: 'Remote model server is required.' }
  const current = update.serverId ? desktopRemoteServerApplication.get(update.serverId) : null
  const result = await desktopRemoteServerApplication.checkCandidate({
    id: update.serverId || 'connection-test',
    name: update.name?.trim() || defaultServerName(endpoint),
    endpoint,
    provider: update.provider === 'ogad' ? 'offgrid-desktop' : update.provider === 'custom'
      ? 'openai-compatible' : update.provider,
    selections: current?.selections ?? {},
    catalog: current?.catalog ?? {},
    ...(update.provider === 'ogad' ? { modelManagement: 'offgrid-desktop-v1' as const } : {})
  }, update.apiKey?.trim() || (update.serverId ? serverApiKey(update.serverId) : '') || null)
  return {
    ok: result.success,
    latencyMs: result.latency ?? 0,
    error: result.error,
    models: result.models as RemoteVisionConnectionResult['models'],
    catalog: result.catalog as RemoteModelCatalog | undefined,
    selections: result.selections
  }
}
