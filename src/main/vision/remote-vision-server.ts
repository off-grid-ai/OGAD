import { settingsChanged } from '../settings-version'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  remoteModelSelected,
  remoteModelServerId,
  setRemoteModelSelected,
  type RemoteModelModality
} from '../active-models'
import { modelsDir } from '../runtime-env'
import { deleteSecret, getSecret, setSecret } from '../secrets'
import {
  REMOTE_VISION_PROVIDERS,
  remoteVisionApiBase,
  remoteVisionEndpoint,
  type RemoteVisionConnectionResult,
  type RemoteVisionCatalogModel,
  type RemoteVisionModality,
  type RemoteVisionSelections,
  type RemoteVisionRoleSelections,
  type RemoteVisionTaskRole,
  type RemoteVisionProvider,
  type RemoteVisionSavedServer,
  type RemoteVisionServerSettings,
  type RemoteVisionServerUpdate
} from '../../shared/remote-vision-server'
import { isRemoteChatModel, parseRemoteVisionModelId } from '../../shared/remote-vision-server'

const LEGACY_API_KEY_SECRET = 'remote-vision-server:api-key'
const CONFIG_VERSION = 3

interface StoredRemoteVisionServer {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  enabled?: boolean
  mediaModels?: RemoteVisionSelections
  roleModels?: RemoteVisionRoleSelections
  modelCatalog?: RemoteVisionCatalogModel[]
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
  if (!value.id || !value.endpoint || !validProvider(value.provider)) return null
  const selections = value.mediaModels ?? (value.model ? { text: value.model } : {})
  const roleModels = value.roleModels ?? {}
  if (
    ![...Object.values(selections), ...Object.values(roleModels)].some(
      (model) => typeof model === 'string' && model.trim()
    )
  )
    return null
  return {
    id: value.id,
    name: value.name?.trim() || defaultServerName(value.endpoint),
    provider: value.provider,
    endpoint: remoteVisionApiBase(remoteVisionEndpoint(value.provider, value.endpoint)),
    model: (selections.text ?? value.model ?? '').trim(),
    enabled: value.enabled !== false,
    mediaModels: selections,
    roleModels,
    modelCatalog: Array.isArray(value.modelCatalog) ? value.modelCatalog : [],
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
      StoredRemoteVisionConfig | LegacyStoredRemoteVisionServer
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
  settingsChanged()
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

const MODALITIES: RemoteModelModality[] = ['text', 'image', 'video', 'voice', 'transcription']

/** The enabled server a modality's remote selection names, or null when it runs locally. */
function selectedServer(
  stored: StoredRemoteVisionConfig,
  modality: RemoteModelModality
): StoredRemoteVisionServer | null {
  if (!remoteModelSelected(modality)) return null
  const serverId = remoteModelServerId(modality) ?? stored.activeServerId
  return (
    stored.servers.find((server) => server.id === serverId && server.enabled !== false) ?? null
  )
}

/** Id of the server a modality runs on, or null when it runs locally. */
export function remoteServerIdFor(modality: RemoteModelModality): string | null {
  return selectedServer(readStored(), modality)?.id ?? null
}

function offersModel(server: StoredRemoteVisionServer, modality: RemoteModelModality): boolean {
  return Boolean(modality === 'text' ? server.model : server.mediaModels?.[modality])
}

// A selection saved before servers were recorded per modality follows the shared active server.
// Name its server before that changes, so the change cannot carry it along.
function pinLegacySelections(stored: StoredRemoteVisionConfig): void {
  for (const modality of MODALITIES) {
    if (!remoteModelSelected(modality) || remoteModelServerId(modality)) continue
    const server = selectedServer(stored, modality)
    if (server) setRemoteModelSelected(modality, true, server.id)
  }
}

export function getRemoteVisionServerSettings(): RemoteVisionServerSettings {
  const stored = readStored()
  // The server Settings marks active is the one chat runs on, when chat is remote.
  const active =
    selectedServer(stored, 'text') ??
    stored.servers.find((server) => server.id === stored.activeServerId && server.enabled !== false)
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
  (StoredRemoteVisionServer & { apiKey: string }) | null {
  const active = selectedServer(readStored(), 'text')
  return active?.model ? { ...active, apiKey: serverApiKey(active.id) } : null
}

/** Resolve any saved text/vision model reference through its owning server.
 * Task roles use this seam instead of depending on a provider or catalog kind. */
export function getRemoteVisionServerForModel(
  modelReference: string | null | undefined,
  role?: RemoteVisionTaskRole
): (StoredRemoteVisionServer & { apiKey: string }) | null {
  if (!modelReference) return null
  const reference = parseRemoteVisionModelId(modelReference)
  if (!reference) return null
  const stored = readStored()
  const server = stored.servers.find(
    (candidate) => candidate.id === reference.serverId && candidate.enabled !== false
  )
  if (!server) return null
  if (role && server.roleModels?.[role] !== reference.modelId) return null
  const catalogModel = server.modelCatalog?.find((model) => model.id === reference.modelId)
  if (catalogModel && catalogModel.kind !== 'text') return null
  // Chat never runs on a server's grounder or decider; their roles reach them by name.
  if (!role && catalogModel && !isRemoteChatModel(catalogModel)) return null
  return {
    ...server,
    model: reference.modelId,
    apiKey: serverApiKey(server.id)
  }
}

export function getActiveRemoteVisionServerForModality(
  modality: RemoteVisionModality
): (StoredRemoteVisionServer & { apiKey: string; selectedModel: string }) | null {
  const active = selectedServer(readStored(), modality)
  const selectedModel = active?.mediaModels?.[modality]
  return active &&
    selectedModel &&
    (modality !== 'video' || ['ogad', 'openrouter'].includes(active.provider))
    ? { ...active, apiKey: serverApiKey(active.id), selectedModel }
    : null
}

export function activateRemoteVisionModel(serverId: string, modelId: string): boolean {
  const stored = readStored()
  const server = stored.servers.find(
    (candidate) =>
      candidate.id === serverId && candidate.enabled !== false && candidate.model === modelId
  )
  if (!server) return false
  pinLegacySelections(stored)
  writeStored({ ...stored, activeServerId: server.id })
  setRemoteModelSelected('text', true, server.id)
  return true
}

export function deactivateRemoteVisionModel(): void {
  const stored = readStored()
  pinLegacySelections(stored)
  setRemoteModelSelected('text', false)
  if (stored.activeServerId !== null) writeStored({ ...stored, activeServerId: null })
}

export function activateRemoteVisionMediaModel(
  serverId: string,
  modality: Exclude<RemoteVisionModality, 'text'>,
  modelId: string
): boolean {
  const stored = readStored()
  const server = stored.servers.find(
    (candidate) =>
      candidate.id === serverId &&
      candidate.enabled !== false &&
      candidate.mediaModels?.[modality] === modelId
  )
  if (!server) return false
  // Only this modality moves: chat and the other media keep their own servers.
  setRemoteModelSelected(modality, true, serverId)
  return true
}

export function deactivateRemoteVisionMediaModel(
  modality: Exclude<RemoteVisionModality, 'text'>
): void {
  setRemoteModelSelected(modality, false)
}

export function setRemoteVisionServerSettings(
  update: RemoteVisionServerUpdate
): RemoteVisionServerSettings {
  const stored = readStored()
  if (update.provider === 'local') {
    for (const modality of MODALITIES) setRemoteModelSelected(modality, false)
    writeStored({
      ...stored,
      activeServerId: null,
      servers: stored.servers.map((server) => ({ ...server, enabled: false }))
    })
    return getRemoteVisionServerSettings()
  }
  if (!validProvider(update.provider)) throw new Error('Unknown model server.')
  const endpoint = remoteVisionApiBase(remoteVisionEndpoint(update.provider, update.endpoint))
  const model = update.model.trim()
  const mediaModels = update.mediaModels ?? (model ? { text: model } : {})
  const roleModels = update.roleModels ?? {}
  if (
    !endpoint ||
    ![...Object.values(mediaModels), ...Object.values(roleModels)].some((selected) =>
      Boolean((selected as string | undefined)?.trim())
    )
  ) {
    throw new Error('Remote model server and at least one model are required.')
  }
  const id = update.serverId || randomUUID()
  const isNewServer = !stored.servers.some((server) => server.id === id)
  const next: StoredRemoteVisionServer = {
    id,
    name: update.name?.trim() || defaultServerName(endpoint),
    provider: update.provider,
    endpoint,
    model: mediaModels.text?.trim() ?? '',
    enabled: update.enabled !== false,
    mediaModels,
    roleModels,
    modelCatalog:
      update.modelCatalog ?? stored.servers.find((server) => server.id === id)?.modelCatalog ?? [],
    screenFramesAllowed: update.screenFramesAllowed === true
  }
  const servers = stored.servers.some((server) => server.id === id)
    ? stored.servers.map((server) => (server.id === id ? next : server))
    : [...stored.servers, next]
  if (update.clearApiKey) deleteSecret(secretKey(id))
  else if (update.apiKey?.trim()) setSecret(secretKey(id), update.apiKey.trim())
  // Turning one server off leaves the others as they were; the active one hands over to the next.
  const others = servers.filter((server) => server.id !== id && server.enabled !== false)
  const activeServerId = next.enabled
    ? id
    : stored.activeServerId === id
      ? (others[0]?.id ?? null)
      : stored.activeServerId
  pinLegacySelections(stored)
  if (!next.enabled) {
    // What ran on the server just turned off moves to another that offers a model for it, or
    // runs locally.
    for (const modality of MODALITIES) {
      if (remoteModelServerId(modality) !== id) continue
      const handover = others.find((server) => offersModel(server, modality))?.id
      setRemoteModelSelected(modality, Boolean(handover), handover)
    }
  }
  // A new server saved with a chat model takes chat; one without leaves chat where it was, and
  // the media choices stay on their own servers either way.
  const takesChat = isNewServer && Boolean(mediaModels.text)
  writeStored({ version: CONFIG_VERSION, activeServerId, servers })
  if (takesChat) setRemoteModelSelected('text', true, id)
  return getRemoteVisionServerSettings()
}

export function removeRemoteVisionServer(serverId: string): RemoteVisionServerSettings {
  const stored = readStored()
  deleteSecret(secretKey(serverId))
  pinLegacySelections(stored)
  for (const modality of MODALITIES) {
    if (remoteModelServerId(modality) === serverId) setRemoteModelSelected(modality, false)
  }
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
    const response = await fetch(
      `${endpoint}/models${update.provider === 'openrouter' ? '?output_modalities=all' : ''}`,
      {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(10_000)
      }
    )
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      let message = body.trim()
      try {
        const parsed = JSON.parse(body) as {
          error?: { message?: string } | string
          message?: string
        }
        message =
          typeof parsed.error === 'string'
            ? parsed.error
            : (parsed.error?.message ?? parsed.message ?? '')
      } catch {
        /* plain text is already useful */
      }
      throw new Error((message || `Server returned HTTP ${response.status}.`).slice(0, 500))
    }
    type ModelsBody = {
      data?: Array<{
        id?: unknown
        name?: unknown
        model?: unknown
        kind?: unknown
        video_api?: unknown
        supported_parameters?: unknown
        reasoning?: unknown
        architecture?: { input_modalities?: unknown; output_modalities?: unknown }
      }>
      models?: Array<{
        id?: unknown
        name?: unknown
        model?: unknown
        kind?: unknown
        video_api?: unknown
        supported_parameters?: unknown
        reasoning?: unknown
        architecture?: { input_modalities?: unknown; output_modalities?: unknown }
      }>
    }
    const bodies: ModelsBody[] = [(await response.json()) as ModelsBody]
    if (update.provider === 'openrouter') {
      const decisionResponse = await fetch(`${endpoint}/models?output_modalities=decisions`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
        signal: AbortSignal.timeout(10_000)
      }).catch(() => null)
      if (decisionResponse?.ok) bodies.push((await decisionResponse.json()) as ModelsBody)
    }
    const entries: Array<{
      id?: unknown
      name?: unknown
      model?: unknown
      kind?: unknown
      video_api?: unknown
      supported_parameters?: unknown
      reasoning?: unknown
      capabilities?: unknown
      architecture?: { input_modalities?: unknown; output_modalities?: unknown }
    }> = [
      ...new Map(
        bodies
          .flatMap((body) => body.data ?? body.models ?? [])
          .map((entry) => [String(entry.id ?? entry.model ?? ''), entry] as const)
      ).values()
    ]
    // A server relaying a model from one of this app's own servers (this Mac's gateway relaying
    // its remote chat model) would list it twice, once by a longer road.
    const ownServers = new Set(readStored().servers.map((server) => server.id))
    // An OGAD server can use a custom port or sit behind a reverse proxy.
    const provider = update.provider === 'custom' &&
      entries.some((entry) => entry.video_api === 'offgrid-video-v1')
      ? 'ogad' : update.provider
    const models = entries.flatMap((entry) => {
      const id =
        typeof entry.id === 'string' ? entry.id : typeof entry.model === 'string' ? entry.model : ''
      if (!id) return []
      const relayed = parseRemoteVisionModelId(id)
      if (relayed && ownServers.has(relayed.serverId)) return []
      const kind = entry.kind
      if (
        (kind === 'video' ||
          (Array.isArray(entry.architecture?.output_modalities) &&
            entry.architecture.output_modalities.includes('video'))) &&
        !['ogad', 'openrouter'].includes(provider)
      )
        return []
      const outputs = Array.isArray(entry.architecture?.output_modalities)
        ? entry.architecture.output_modalities
        : []
      const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : []
      // An Off Grid gateway says a chat model reads images by its kind or capabilities.
      const inputs = Array.isArray(entry.architecture?.input_modalities)
        ? entry.architecture.input_modalities
        : kind === 'vision' || capabilities.includes('vision')
          ? ['text', 'image']
          : []
      const supportedParameters = Array.isArray(entry.supported_parameters)
        ? entry.supported_parameters.filter((value): value is string => typeof value === 'string')
        : []
      const role: RemoteVisionTaskRole | undefined =
        kind === 'grounding_specialist'
          ? 'grounding'
          : kind === 'decision_specialist'
            ? 'decision'
            : undefined
      const modality: RemoteVisionModality =
        role
          ? 'text'
          : kind === 'video' || outputs.includes('video')
          ? 'video'
          : kind === 'image'
          ? 'image'
          : kind === 'transcription'
            ? 'transcription'
            : kind === 'speech'
              ? 'voice'
              : kind === 'chat' || kind === 'vision' || kind === 'text'
                ? 'text'
                : outputs.includes('image')
                  ? 'image'
                  : outputs.includes('transcription')
                    ? 'transcription'
                    : outputs.includes('speech') || outputs.includes('audio')
                      ? 'voice'
                      : update.provider !== 'openrouter' &&
                          inputs.includes('audio') &&
                          outputs.includes('text')
                        ? 'transcription'
                        : update.provider !== 'openrouter' && outputs.includes('audio')
                          ? 'voice'
                          : 'text'
      return [
        {
          id,
          name: typeof entry.name === 'string' ? entry.name : id,
          kind: modality,
          ...(role ? { role } : {}),
          inputModalities: inputs.filter((value): value is string => typeof value === 'string'),
          outputModalities: outputs.filter((value): value is string => typeof value === 'string'),
          supportedParameters,
          reasoning:
            Boolean(entry.reasoning) ||
            supportedParameters.includes('reasoning') ||
            supportedParameters.includes('include_reasoning')
        }
      ]
    })
    return { ok: true, latencyMs: Date.now() - startedAt, models, provider }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'Connection failed.'
    }
  }
}

/**
 * Read each enabled server's model list again and keep it, so what its models can do (read
 * images, use tools) stays current without the person pressing Test connection. A server that
 * does not answer keeps the list it had.
 */
export async function refreshRemoteServerCatalogs(): Promise<void> {
  for (const server of readStored().servers) {
    if (server.enabled === false) continue
    const result = await testRemoteVisionServer({ ...server, serverId: server.id })
    if (!result.ok || !result.models?.length) continue
    const stored = readStored()
    if (!stored.servers.some(({ id }) => id === server.id)) continue
    writeStored({
      ...stored,
      servers: stored.servers.map((saved) =>
        saved.id === server.id ? { ...saved, modelCatalog: result.models } : saved
      )
    })
    ;(await import('../llm/remote-chat')).forgetRemoteServerFacts(server.endpoint)
  }
}
