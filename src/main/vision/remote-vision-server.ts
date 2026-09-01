import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { modelsDir } from '../runtime-env'
import {
  REMOTE_FETCH_REDIRECT_POLICY,
  canReconcileCredentialedEndpoint,
  catalogFromDiscovery,
  defaultRemoteSelections,
  discoveryFromRemoteModelList,
  mergeRemoteSelections,
  remoteAuthorizationHeaders,
  type RemoteModelCatalog,
  type RemoteModalitySelections
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
  if (!value.id || !value.endpoint || !validProvider(value.provider)) return null
  const legacyModel = value.model?.trim() ?? ''
  const catalog =
    value.catalog ??
    (legacyModel
      ? { text: [{ id: legacyModel, name: legacyModel, capabilities: { supportsVision: true } }] }
      : {})
  const selections = value.selections ?? (legacyModel ? { text: legacyModel } : {})
  if (
    !Object.values(selections).some(
      (selection) => typeof selection === 'string' && selection.trim()
    )
  ) {
    return null
  }
  return {
    id: value.id,
    name: value.name?.trim() || defaultServerName(value.endpoint),
    provider: value.provider,
    endpoint: remoteVisionApiBase(remoteVisionEndpoint(value.provider, value.endpoint)),
    model: selections.text?.trim() || legacyModel,
    selections,
    catalog,
    screenFramesAllowed: value.screenFramesAllowed === true
  }
}

function isStoredConfig(
  value: StoredRemoteVisionConfig | LegacyStoredRemoteVisionServer
): value is StoredRemoteVisionConfig {
  return 'servers' in value && Array.isArray(value.servers)
}

function readStored(): StoredRemoteVisionConfig {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as
      | StoredRemoteVisionConfig
      | LegacyStoredRemoteVisionServer
    if (isStoredConfig(value)) {
      const servers = value.servers.flatMap((server) => {
        const normalized = normalizeServer(server)
        return normalized ? [normalized] : []
      })
      return {
        version: CONFIG_VERSION,
        activeServerId: servers.some((server) => server.id === value.activeServerId)
          ? value.activeServerId
          : null,
        servers
      }
    }
    if (
      !validProvider(value.provider) ||
      value.provider === 'local' ||
      !value.endpoint ||
      !value.model
    ) {
      return { version: CONFIG_VERSION, activeServerId: null, servers: [] }
    }
    const id = 'migrated-server'
    const server = normalizeServer({
      id,
      name: defaultServerName(value.endpoint),
      provider: value.provider,
      endpoint: value.endpoint,
      model: value.model
    })
    return {
      version: CONFIG_VERSION,
      activeServerId: server ? id : null,
      servers: server ? [server] : []
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
  if (selected) return null
  return stored.servers.find((server) => server.id === stored.activeServerId) ?? null
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
  const server = stored.servers.find(
    (candidate) => candidate.id === serverId && candidate.selections.text === modelId
  )
  if (!server) return false
  writeStored({ ...stored, activeServerId: server.id })
  return true
}

export function deactivateRemoteVisionModel(): void {
  const stored = readStored()
  if (stored.activeServerId === null) return
  writeStored({ ...stored, activeServerId: null })
}

export async function setRemoteVisionServerSettings(
  update: RemoteVisionServerUpdate
): Promise<RemoteVisionServerSettings> {
  const stored = readStored()
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
  const existing = stored.servers.find((server) => server.id === id)
  const catalog =
    update.catalog ??
    existing?.catalog ??
    (model ? { text: [{ id: model, name: model, capabilities: { supportsVision: true } }] } : {})
  const selections = update.selections ?? existing?.selections ?? (model ? { text: model } : {})
  if (
    !Object.values(selections).some(
      (selection) => typeof selection === 'string' && selection.trim()
    )
  ) {
    throw new Error('Select at least one remote model.')
  }
  const requestedKey = update.apiKey?.trim() || (existing ? serverApiKey(id) : '')
  if (requestedKey && !canReconcileCredentialedEndpoint(endpoint, true)) {
    throw new Error('API keys require an HTTPS remote server.')
  }
  const next: StoredRemoteVisionServer = {
    id,
    name: update.name?.trim() || defaultServerName(endpoint),
    provider: update.provider,
    endpoint,
    model: selections.text ?? model,
    selections,
    catalog,
    screenFramesAllowed: update.screenFramesAllowed === true
  }
  const servers = stored.servers.some((server) => server.id === id)
    ? stored.servers.map((server) => (server.id === id ? next : server))
    : [...stored.servers, next]
  if (update.clearApiKey) deleteSecret(secretKey(id))
  else if (update.apiKey?.trim()) setSecret(secretKey(id), update.apiKey.trim())
  writeStored({
    version: CONFIG_VERSION,
    activeServerId: stored.activeServerId === id ? null : stored.activeServerId,
    servers
  })
  await desktopModelServices.refresh()
  for (const [remoteModality, selectedModel] of Object.entries(selections)) {
    if (typeof selectedModel !== 'string' || !selectedModel) continue
    const modality = remoteModality === 'voice' ? 'voice' : remoteModality
    const selected = await desktopModelServices.select(
      modality as 'text' | 'image' | 'transcription' | 'voice' | 'embedding',
      remoteVisionModelId(id, selectedModel)
    )
    if (!selected.success) throw new Error(selected.error)
  }
  return getRemoteVisionServerSettings()
}

export function removeRemoteVisionServer(serverId: string): RemoteVisionServerSettings {
  const stored = readStored()
  desktopModelServices.clearRemoteServerSelections(serverId)
  deleteSecret(secretKey(serverId))
  writeStored({
    version: CONFIG_VERSION,
    activeServerId: stored.activeServerId === serverId ? null : stored.activeServerId,
    servers: stored.servers.filter((server) => server.id !== serverId)
  })
  return getRemoteVisionServerSettings()
}

export async function testRemoteVisionServer(
  update: RemoteVisionServerUpdate
): Promise<RemoteVisionConnectionResult> {
  const startedAt = Date.now()
  try {
    const endpoint = remoteVisionApiBase(remoteVisionEndpoint(update.provider, update.endpoint))
    if (update.provider === 'local') return { ok: true, latencyMs: 0 }
    if (!endpoint) throw new Error('Remote model server is required.')
    const key = update.apiKey?.trim() || (update.serverId ? serverApiKey(update.serverId) : '')
    if (key && !canReconcileCredentialedEndpoint(endpoint, true)) {
      throw new Error('API keys require an HTTPS remote server.')
    }
    const response = await fetch(`${endpoint}/models`, {
      headers: remoteAuthorizationHeaders(endpoint, key),
      signal: AbortSignal.timeout(10_000),
      redirect: REMOTE_FETCH_REDIRECT_POLICY
    })
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`)
    const evidence = discoveryFromRemoteModelList(await response.json())
    if (!evidence) throw new Error('The server returned an invalid model list.')
    const catalog = catalogFromDiscovery(evidence)
    const current = update.serverId
      ? readStored().servers.find((server) => server.id === update.serverId)?.selections
      : undefined
    const selections = mergeRemoteSelections(
      current,
      defaultRemoteSelections(catalog),
      update.provider === 'ogad'
    )
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      models: evidence.models,
      catalog,
      selections
    }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Connection failed.'
    }
  }
}
