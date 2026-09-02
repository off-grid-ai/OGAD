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

/** Stable inventory id for a model that belongs to a saved remote server. */
export function remoteVisionModelId(serverId: string, modelId: string): string {
  return sharedRemoteVisionModelId(serverId, modelId)
}

/** Parse only ids created by remoteVisionModelId. */
export function parseRemoteVisionModelId(value: string): RemoteVisionModelReference | null {
  return parseSharedRemoteVisionModelId(value)
}

/**
 * The remote models a server contributes to the app's inventory: only the ones SELECTED for it
 * (one per modality). The full catalog belongs to the server's settings page; the inventory is what
 * can be used, so the Active models panel and the paired phone see one remote model per modality,
 * not every model a provider lists.
 */
export function remoteVisionInventoryModels(
  servers: RemoteVisionSavedServer[]
): RemoteVisionInventoryModel[] {
  const kindFor = (
    modality: RemoteModelModality,
    capabilities?: Partial<RemoteModelCapabilities>
  ): RemoteVisionInventoryModel['kind'] =>
    modality === 'text' ? (capabilities?.supportsVision ? 'vision' : 'text') : modality
  return servers.flatMap((server) => {
    const selections = Object.entries(server.selections ?? {}).filter(
      (entry): entry is [RemoteModelModality, string] => typeof entry[1] === 'string' && !!entry[1]
    )
    const selected = selections.length
      ? selections
      : server.model
        ? [['text', server.model] as [RemoteModelModality, string]]
        : []
    return selected.map(([modality, modelId]) => {
      const model = server.catalog?.[modality]?.find((candidate) => candidate.id === modelId) ?? {
        id: modelId,
        name: modelId
      }
      return {
        id: remoteVisionModelId(server.id, model.id),
        name: model.name,
        kind: kindFor(modality, model.capabilities),
        org: server.name,
        description: `Runs through ${server.name}.`,
        files: [],
        tags: ['Remote'],
        remoteServerId: server.id,
        remoteModelId: model.id,
        remoteCapabilities: model.capabilities
      }
    })
  })
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
import {
  inferRemoteProvider,
  parseRemoteVisionModelId as parseSharedRemoteVisionModelId,
  remoteApiBase,
  remoteVisionModelId as sharedRemoteVisionModelId,
  trimRemoteEndpoint
} from '@offgrid/models'
