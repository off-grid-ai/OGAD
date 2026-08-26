export const REMOTE_VISION_PROVIDERS = [
  'local',
  'ollama',
  'lmstudio',
  'ogad',
  'openrouter',
  'custom'
] as const

export type RemoteVisionProvider = (typeof REMOTE_VISION_PROVIDERS)[number]

export interface RemoteVisionSavedServer {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  hasApiKey: boolean
}

export interface RemoteVisionModelReference {
  serverId: string
  modelId: string
}

export interface RemoteVisionInventoryModel {
  id: string
  name: string
  kind: 'vision'
  org: string
  description: string
  files: []
  tags: ['Remote']
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
  return servers.map((server) => ({
    id: remoteVisionModelId(server.id, server.model),
    name: server.model,
    kind: 'vision',
    org: server.name,
    description: `Runs through ${server.name}.`,
    files: [],
    tags: ['Remote'],
    remoteServerId: server.id,
    remoteModelId: server.model
  }))
}

export interface RemoteVisionServerSettings {
  provider: RemoteVisionProvider
  endpoint: string
  model: string
  hasApiKey: boolean
  activeServerId: string | null
  servers: RemoteVisionSavedServer[]
}

export interface RemoteVisionServerUpdate {
  provider: RemoteVisionProvider
  endpoint: string
  model: string
  serverId?: string
  name?: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface RemoteVisionConnectionResult {
  ok: boolean
  latencyMs: number
  error?: string
  models?: Array<{ id: string; name: string }>
}

export const REMOTE_VISION_DEFAULTS: Record<
  Exclude<RemoteVisionProvider, 'local' | 'custom'>,
  string
> = {
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  ogad: 'http://127.0.0.1:7878/v1',
  openrouter: 'https://openrouter.ai/api/v1'
}

export function remoteVisionEndpoint(provider: RemoteVisionProvider, endpoint: string): string {
  if (provider === 'local') return ''
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
