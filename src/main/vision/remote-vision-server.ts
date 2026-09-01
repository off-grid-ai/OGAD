import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { modelsDir } from '../runtime-env'
import { deleteSecret, getSecret, setSecret } from '../secrets'
import {
  REMOTE_VISION_PROVIDERS,
  remoteVisionApiBase,
  remoteVisionEndpoint,
  type RemoteVisionConnectionResult,
  type RemoteVisionProvider,
  type RemoteVisionSavedServer,
  type RemoteVisionServerSettings,
  type RemoteVisionServerUpdate
} from '../../shared/remote-vision-server'

const LEGACY_API_KEY_SECRET = 'remote-vision-server:api-key'
const CONFIG_VERSION = 3

interface StoredRemoteVisionServer {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  screenFramesAllowed: boolean
}

interface StoredRemoteVisionConfig {
  version: 3
  activeServerId: string | null
  servers: StoredRemoteVisionServer[]
}

interface LegacyStoredRemoteVisionServer {
  provider: RemoteVisionProvider
  endpoint: string
  model: string
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
  if (!value.id || !value.endpoint || !value.model || !validProvider(value.provider)) return null
  return {
    id: value.id,
    name: value.name?.trim() || defaultServerName(value.endpoint),
    provider: value.provider,
    endpoint: remoteVisionApiBase(remoteVisionEndpoint(value.provider, value.endpoint)),
    model: value.model.trim(),
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

function publicServer(server: StoredRemoteVisionServer): RemoteVisionSavedServer {
  return { ...server, hasApiKey: Boolean(serverApiKey(server.id)) }
}

export function getRemoteVisionServerSettings(): RemoteVisionServerSettings {
  const stored = readStored()
  const active = stored.servers.find((server) => server.id === stored.activeServerId)
  return {
    provider: active?.provider ?? 'local',
    endpoint: active?.endpoint ?? '',
    model: active?.model ?? '',
    hasApiKey: active ? Boolean(serverApiKey(active.id)) : false,
    activeServerId: active?.id ?? null,
    servers: stored.servers.map(publicServer)
  }
}

export function getActiveRemoteVisionServer():
  | (StoredRemoteVisionServer & { apiKey: string })
  | null {
  const stored = readStored()
  const active = stored.servers.find((server) => server.id === stored.activeServerId)
  return active ? { ...active, apiKey: serverApiKey(active.id) } : null
}

/** Resolve one persisted server for a route selected by the shared model service. */
export function getRemoteVisionServer(
  serverId: string
): (StoredRemoteVisionServer & { apiKey: string }) | null {
  const server = readStored().servers.find((candidate) => candidate.id === serverId)
  return server ? { ...server, apiKey: serverApiKey(server.id) } : null
}

export function activateRemoteVisionModel(serverId: string, modelId: string): boolean {
  const stored = readStored()
  const server = stored.servers.find(
    (candidate) => candidate.id === serverId && candidate.model === modelId
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

export function setRemoteVisionServerSettings(
  update: RemoteVisionServerUpdate
): RemoteVisionServerSettings {
  const stored = readStored()
  if (update.provider === 'local') {
    writeStored({ ...stored, activeServerId: null })
    return getRemoteVisionServerSettings()
  }
  if (!validProvider(update.provider)) throw new Error('Unknown model server.')
  const endpoint = remoteVisionApiBase(remoteVisionEndpoint(update.provider, update.endpoint))
  const model = update.model.trim()
  if (!endpoint || !model) throw new Error('Remote model server and model are required.')
  const id = update.serverId || randomUUID()
  const next: StoredRemoteVisionServer = {
    id,
    name: update.name?.trim() || defaultServerName(endpoint),
    provider: update.provider,
    endpoint,
    model,
    screenFramesAllowed: update.screenFramesAllowed === true
  }
  const servers = stored.servers.some((server) => server.id === id)
    ? stored.servers.map((server) => (server.id === id ? next : server))
    : [...stored.servers, next]
  if (update.clearApiKey) deleteSecret(secretKey(id))
  else if (update.apiKey?.trim()) setSecret(secretKey(id), update.apiKey.trim())
  writeStored({ version: CONFIG_VERSION, activeServerId: id, servers })
  return getRemoteVisionServerSettings()
}

export function removeRemoteVisionServer(serverId: string): RemoteVisionServerSettings {
  const stored = readStored()
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
    const response = await fetch(`${endpoint}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}.`)
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; name?: unknown }>
      models?: Array<{ id?: unknown; name?: unknown; model?: unknown }>
    }
    const entries: Array<{ id?: unknown; name?: unknown; model?: unknown }> =
      body.data ?? body.models ?? []
    const models = entries.flatMap((entry) => {
      const id =
        typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : ''
      return id ? [{ id, name: typeof entry.name === 'string' ? entry.name : id }] : []
    })
    return { ok: true, latencyMs: Date.now() - startedAt, models }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Connection failed.'
    }
  }
}
