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
  kind: 'vision'
  org: string
  description: string
  files: []
  tags: ['Remote']
  remoteServerId: string
  remoteModelId: string
}

/** Stable inventory id for a model that belongs to a saved remote server. */
export function remoteVisionModelId(serverId: string, modelId: string): string {
  return sharedRemoteVisionModelId(serverId, modelId)
}

/** Parse only ids created by remoteVisionModelId. */
export function parseRemoteVisionModelId(value: string): RemoteVisionModelReference | null {
  return parseSharedRemoteVisionModelId(value)
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
  screenFramesAllowed?: boolean
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
  if (provider === 'custom') return trimRemoteEndpoint(endpoint)
  return trimRemoteEndpoint(endpoint) || REMOTE_VISION_DEFAULTS[provider] || ''
}

export function remoteVisionProviderForEndpoint(endpoint: string): RemoteVisionProvider {
  const provider = inferRemoteProvider(endpoint)
  return provider === 'offgrid-desktop' ? 'ogad' :
    provider === 'openai-compatible' || provider === 'anthropic' ? 'custom' : provider
}

export function remoteVisionApiBase(endpoint: string): string {
  return remoteApiBase(endpoint)
}
import {
  inferRemoteProvider,
  parseRemoteVisionModelId as parseSharedRemoteVisionModelId,
  remoteApiBase,
  remoteVisionModelId as sharedRemoteVisionModelId,
  trimRemoteEndpoint
} from '@offgrid/models'
