import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { modelsDir } from '../runtime-env'
import { type WorkspaceRemoteServersPort,
  REMOTE_FETCH_REDIRECT_POLICY,
  type RemoteServerApplicationService,
  type RemoteServerApplicationPorts,
  activeRemoteServer,
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
import { desktopModelSelectionPersistence } from '../model-selection-persistence'
import { desktopModelServices } from '../model-service-access'
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
  /** "Use this server". Absent means true (records written before the flag existed). */
  enabled?: boolean
}

/**
 * On disk since version 4. Files written before 2026-09-03 also carry an `activeServerId`; the
 * active server is derived from the list (shared `activeRemoteServer`), so that field is read past.
 */
interface StoredRemoteVisionConfig {
  version: 4
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
    provider: sharedProvider(value.provider)
  })
  if (
    !normalized ||
    !Object.values(normalized.selections ?? {}).some(
      (selection) => typeof selection === 'string' && selection.trim()
    )
  )
    return null
  return {
    id: normalized.id,
    name: normalized.name,
    provider: desktopProvider(normalized.provider),
    endpoint: normalized.endpoint,
    model: normalized.selections?.text?.trim() || '',
    selections: normalized.selections ?? {},
    catalog: normalized.catalog ?? {},
    screenFramesAllowed: normalized.screenFramesAllowed === true,
    ...(normalized.enabled === false ? { enabled: false } : {})
  }
}

function sharedConfiguration(
  stored: StoredRemoteVisionConfig
): ReturnType<typeof migrateRemoteServerConfiguration> {
  return {
    version: 1,
    activeServerId: activeRemoteServer(stored.servers)?.id ?? null,
    servers: stored.servers.map((server) => ({ ...server, provider: sharedProvider(server.provider) }))
  }
}

// Desktop's provider vocabulary ('ogad', 'custom') and shared's ('offgrid-desktop',
// 'openai-compatible', 'anthropic') meet in these two functions and nowhere else in this file.
function desktopProvider(
  provider: PersistedRemoteServer['provider']
): Exclude<RemoteVisionProvider, 'local'> {
  if (provider === 'offgrid-desktop') return 'ogad'
  if (provider === 'ollama' || provider === 'lmstudio' || provider === 'openrouter') return provider
  return 'custom'
}

function sharedProvider(
  provider: Exclude<RemoteVisionProvider, 'local'>
): PersistedRemoteServer['provider'] {
  if (provider === 'ogad') return 'offgrid-desktop'
  if (provider === 'custom') return 'openai-compatible'
  return provider
}

function storedFromShared(server: PersistedRemoteServer): StoredRemoteVisionServer {
  return {
    id: server.id,
    name: server.name,
    provider: desktopProvider(server.provider),
    endpoint: server.endpoint,
    model: server.selections?.text ?? '',
    selections: server.selections ?? {},
    catalog: server.catalog ?? {},
    screenFramesAllowed: server.screenFramesAllowed === true,
    enabled: server.enabled !== false
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
        provider: desktopProvider(server.provider),
        model: server.selections?.text ?? ''
      })
      return normalized ? [normalized] : []
    })
    return { version: CONFIG_VERSION, servers }
  } catch {
    return { version: CONFIG_VERSION, servers: [] }
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

/**
 * Desktop's remote-server I/O, handed to the shared ModelWorkspace. Selection is NOT a port here:
 * the workspace resolves a server's model to this device's route and writes it through the one
 * selection authority.
 */
export const desktopRemoteServerPorts: Omit<RemoteServerApplicationPorts, 'select' | 'clearSelections'> = {
    configuration: {
      read: () => sharedConfiguration(readStored()),
      async write(value) {
        writeStored({ version: CONFIG_VERSION, servers: value.servers.map(storedFromShared) })
        await desktopModelServices.refresh()
      }
    },
    credentials: {
      async read(serverId) { return serverApiKey(serverId) || null },
      async write(serverId, value) { setSecret(secretKey(serverId), value) },
      async remove(serverId) { deleteSecret(secretKey(serverId)) }
    },
    providers: {
      // Desktop has no provider registry: the workspace inventory reads saved servers directly.
      async register() {
        /* see above */
      },
      async update() {
        /* see above */
      },
      async unregister() {
        /* see above */
      }
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
}

/** The workspace owns the remote-server application; this file only reaches it lazily. */
const desktopRemoteServerApplication: RemoteServerApplicationService = new Proxy(
  {} as RemoteServerApplicationService,
  {
    get: (_target, property) => {
      const servers = desktopModelServices.workspace.servers
      const value = servers[property as keyof WorkspaceRemoteServersPort]
      return typeof value === 'function' ? value.bind(servers) : value
    }
  }
)

export function getRemoteVisionServerSettings(): RemoteVisionServerSettings {
  const stored = readStored()
  const active = activeRemoteServer(stored.servers)
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
  const active = activeRemoteServer(stored.servers)
  return active ? { ...active, apiKey: transportApiKey(active) } : null
}

/** Resolve one persisted server for a route selected by the shared model service. */
export function getRemoteVisionServer(serverId: string): RemoteVisionServerConnection | null {
  const server = readStored().servers.find((candidate) => candidate.id === serverId)
  return server ? { ...server, apiKey: transportApiKey(server) } : null
}

export async function setRemoteVisionServerSettings(
  update: RemoteVisionServerUpdate
): Promise<RemoteVisionServerSettings> {
  if (update.provider === 'local') {
    // "Off uses models on this device": one shared rule, every modality. The last local text model
    // is the preferred fallback for text.
    const previousLocal = desktopModelSelectionPersistence.readLegacyTextConfig().id
    for (const server of readStored().servers) {
      if (server.enabled === false) continue
      await desktopModelServices.workspace.setServerEnabled(server.id, false, (modality) =>
        modality === 'text' && typeof previousLocal === 'string' ? previousLocal : undefined
      )
    }
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
    // A model named without a catalog row is listed by name only; its capabilities come from the
    // shared capability policy once the server is probed, never from a guess written to disk.
    (model ? { text: [{ id: model, name: model }] } : {})
  const selections = update.selections ?? existing?.selections ?? (model ? { text: model } : {})
  if (!hasRemoteServerSelection({ selections })) throw new Error('Select at least one remote model.')
  await desktopRemoteServerApplication.save({
    id,
    name: update.name?.trim() || defaultServerName(endpoint),
    provider: sharedProvider(update.provider),
    endpoint,
    selections,
    catalog,
    screenFramesAllowed: update.screenFramesAllowed === true,
    // Saving a server is the "on" side of the toggle.
    enabled: true,
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
    provider: sharedProvider(update.provider),
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
