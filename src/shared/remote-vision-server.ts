export const REMOTE_VISION_PROVIDERS = [
  'local',
  'ollama',
  'lmstudio',
  'ogad',
  'openrouter',
  'custom'
] as const

export type RemoteVisionProvider = (typeof REMOTE_VISION_PROVIDERS)[number]

export type RemoteVisionModality = 'text' | 'image' | 'transcription' | 'voice'
export type RemoteVisionSelections = Partial<Record<RemoteVisionModality, string>>
export type RemoteVisionTaskRole = 'grounding' | 'decision'
export type RemoteVisionRoleSelections = Partial<Record<RemoteVisionTaskRole, string>>
export interface RemoteVisionCatalogModel {
  id: string
  name: string
  kind: RemoteVisionModality
  inputModalities?: string[]
  outputModalities?: string[]
  supportedParameters?: string[]
  reasoning?: boolean
}

export interface RemoteVisionSavedServer {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  enabled?: boolean
  mediaModels?: RemoteVisionSelections
  roleModels?: RemoteVisionRoleSelections
  modelCatalog?: RemoteVisionCatalogModel[]
  hasApiKey: boolean
  /** The user has confirmed that this remote server can receive screen images. */
  screenFramesAllowed: boolean
}

export interface RemoteVisionModelReference {
  serverId: string
  modelId: string
}

export interface RemoteVisionInventoryModel {
  id: string
  name: string
  kind: 'vision' | 'image' | 'transcription' | 'speech' | 'computer_use'
  org: string
  description: string
  files: []
  /** 'Remote', plus 'Decision' for a server's decision model: the same tag local deciders carry. */
  tags: readonly string[]
  remoteServerId: string
  remoteModelId: string
}

const REMOTE_VISION_MODEL_PREFIX = 'remote-vision:'

/** Stable inventory id for a model that belongs to a saved remote server. */
export function remoteVisionModelId(serverId: string, modelId: string): string {
  return `${REMOTE_VISION_MODEL_PREFIX}${encodeURIComponent(serverId)}:${encodeURIComponent(modelId)}`
}

/** Parse only ids created by remoteVisionModelId. */
export function parseRemoteVisionModelId(value: string): RemoteVisionModelReference | null {
  if (!value.startsWith(REMOTE_VISION_MODEL_PREFIX)) return null
  const encoded = value.slice(REMOTE_VISION_MODEL_PREFIX.length)
  const separator = encoded.indexOf(':')
  if (separator < 1 || separator === encoded.length - 1) return null
  try {
    const serverId = decodeURIComponent(encoded.slice(0, separator))
    const modelId = decodeURIComponent(encoded.slice(separator + 1))
    return serverId && modelId ? { serverId, modelId } : null
  } catch {
    return null
  }
}

export function remoteVisionInventoryModels(
  servers: RemoteVisionSavedServer[]
): RemoteVisionInventoryModel[] {
  return servers.flatMap((server) => {
    if (server.enabled === false) return []
    const selections: RemoteVisionSelections = server.mediaModels ?? { text: server.model }
    const entry = (
      modelId: string,
      kind: RemoteVisionInventoryModel['kind'],
      catalogKind: RemoteVisionModality,
      tags: readonly string[] = ['Remote']
    ): RemoteVisionInventoryModel => {
      const advertisedName = server.modelCatalog
        ?.find((model) => model.id === modelId && model.kind === catalogKind)
        ?.name?.trim()
      const label = advertisedName || modelId
      // File paths are routing IDs, not display names. Retain provider IDs and
      // explicit names; shorten only GGUF filenames, including split suffixes.
      const name = /\.gguf$/i.test(label)
        ? (label.split(/[\\/]/).pop() || label)
            .replace(/(?:-\d{5}-of-\d{5})?\.gguf$/i, '')
            .replace(/-/g, ' ')
        : label
      return {
        id: remoteVisionModelId(server.id, modelId),
        name,
        kind,
        org: server.name,
        description: `Runs through ${server.name}.`,
        files: [] as [],
        tags,
        remoteServerId: server.id,
        remoteModelId: modelId
      }
    }
    const media = (['text', 'image', 'transcription', 'voice'] as const).flatMap((modality) => {
      const modelId = selections[modality]
      if (!modelId) return []
      const kind =
        modality === 'text'
          ? ('vision' as const)
          : modality === 'voice'
            ? ('speech' as const)
            : modality
      return [entry(modelId, kind, modality)]
    })
    // A server's Computer Use roles (grounding, decision) are its Computer Use models, listed
    // with them as the local ones are. One entry per model: a model already listed is not twice.
    const listed = new Set(media.map((model) => model.id))
    const roles = (['grounding', 'decision'] as const).flatMap((role) => {
      const modelId = server.roleModels?.[role]
      if (!modelId) return []
      const id = remoteVisionModelId(server.id, modelId)
      if (listed.has(id)) return []
      listed.add(id)
      // Tagged like local task models, so every list can tell a decider from a grounder.
      return [
        entry(
          modelId,
          'computer_use',
          'text',
          role === 'decision' ? ['Remote', 'Decision'] : ['Remote']
        )
      ]
    })
    return [...media, ...roles]
  })
}

export interface RemoteVisionServerSettings {
  provider: RemoteVisionProvider
  endpoint: string
  model: string
  mediaModels?: RemoteVisionSelections
  roleModels?: RemoteVisionRoleSelections
  modelCatalog?: RemoteVisionCatalogModel[]
  hasApiKey: boolean
  activeServerId: string | null
  servers: RemoteVisionSavedServer[]
}

export interface RemoteVisionServerUpdate {
  provider: RemoteVisionProvider
  endpoint: string
  model: string
  mediaModels?: RemoteVisionSelections
  roleModels?: RemoteVisionRoleSelections
  modelCatalog?: RemoteVisionCatalogModel[]
  serverId?: string
  name?: string
  apiKey?: string
  clearApiKey?: boolean
  screenFramesAllowed?: boolean
}

export interface RemoteVisionConnectionResult {
  ok: boolean
  latencyMs: number
  error?: string
  models?: RemoteVisionCatalogModel[]
}

const REMOTE_VISION_DEFAULTS: Record<Exclude<RemoteVisionProvider, 'local' | 'custom'>, string> = {
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  ogad: 'http://127.0.0.1:7878/v1',
  openrouter: 'https://openrouter.ai/api/v1'
}

export function remoteVisionEndpoint(provider: RemoteVisionProvider, endpoint: string): string {
  if (provider === 'local') return ''
  if (provider === 'custom') return endpoint.trim().replace(/\/+$/, '')
  return endpoint.trim().replace(/\/+$/, '') || REMOTE_VISION_DEFAULTS[provider] || ''
}

export function remoteVisionProviderForEndpoint(endpoint: string): RemoteVisionProvider {
  const normalized = endpoint.trim().toLowerCase()
  if (normalized.includes('openrouter.ai')) return 'openrouter'
  if (/:(?:11434)(?:\/|$)/.test(normalized)) return 'ollama'
  if (/:(?:1234)(?:\/|$)/.test(normalized)) return 'lmstudio'
  if (/:(?:7878)(?:\/|$)/.test(normalized)) return 'ogad'
  return 'custom'
}

export function remoteVisionApiBase(endpoint: string): string {
  const normalized = endpoint.trim().replace(/\/+$/, '')
  if (!normalized || /\/v1$/i.test(normalized)) return normalized
  return `${normalized}/v1`
}
