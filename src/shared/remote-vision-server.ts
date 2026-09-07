import type {
  RemoteModelCapabilities,
  RemoteModelCatalog,
  RemoteModelModality,
  RemoteModalitySelections
} from '@offgrid/models'

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
  selections?: RemoteModalitySelections
  catalog?: RemoteModelCatalog
  hasApiKey: boolean
  /** The user has confirmed that this remote server can receive screen images. */
  screenFramesAllowed: boolean
  /** "Use this server". Absent means true. */
  enabled?: boolean
}

export interface RemoteVisionModelReference {
  serverId: string
  modelId: string
}

export interface RemoteVisionInventoryModel {
  id: string
  name: string
  kind: 'text' | 'vision' | 'image' | 'transcription' | 'voice' | 'embedding'
  org: string
  description: string
  files: []
  tags: ['Remote']
  remoteServerId: string
  remoteModelId: string
  remoteCapabilities?: Partial<RemoteModelCapabilities>
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
  selections?: RemoteModalitySelections
  catalog?: RemoteModelCatalog
}

export interface RemoteVisionConnectionResult {
  ok: boolean
  latencyMs: number
  error?: string
  models?: Array<{
    id: string
    name: string
    modality: RemoteModelModality
    capabilities?: Partial<RemoteModelCapabilities>
  }>
  selections?: RemoteModalitySelections
  catalog?: RemoteModelCatalog
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
  return provider === 'offgrid-desktop'
    ? 'ogad'
    : provider === 'openai-compatible' || provider === 'anthropic'
      ? 'custom'
      : provider
}

export function remoteVisionApiBase(endpoint: string): string {
  return remoteApiBase(endpoint)
}
import { inferRemoteProvider, remoteApiBase, trimRemoteEndpoint } from '@offgrid/models'
