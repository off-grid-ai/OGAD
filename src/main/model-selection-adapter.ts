import { type ModelModality, type ModelReasoningMetadata } from '@offgrid/models'

export interface DesktopInventoryModel {
  id: string
  familyId?: string
  name?: string
  kind?: string
  files?: Array<{ name?: string; sizeBytes?: number; role?: string }>
  availability?: 'ready' | 'coming_soon'
  runtime?: string
  engine?: string
  remoteServerId?: string
  remoteModelId?: string
  remoteCapabilities?: {
    supportsVision?: boolean
    supportsToolCalling?: boolean
    supportsThinking?: boolean
  }
  grounder?: boolean
  artifactDelivery?: 'catalog' | 'runtime'
}

export interface DesktopModelWorkspacePorts {
  listCatalog(): Promise<DesktopInventoryModel[]>
  listInstalled(): Promise<string[]>
  localTextRuntimeState(): Promise<{
    ready: boolean
    loaded: boolean
    reasoning?: ModelReasoningMetadata
    /** The window llama-server runs with; Shared bounds tool results to the room left in it. */
    contextLength?: number
  }>
  localVoiceRuntimeState?(): Promise<{ installed: boolean; ready: boolean; error?: string }>
  localTextLifecycle?: {
    load(): Promise<void>
    unload(): Promise<void>
  }
  projectTextSelection?(modelId: string): Promise<{ success: boolean; error?: string }>
  residencySetting?(modality: 'image' | 'stt'): 'resident' | 'on-demand'
}

export function desktopAdapterId(source: 'local' | 'remote', modality: ModelModality): string {
  const prefix = source === 'remote' ? 'desktop.remote-chat' : 'desktop.llama'
  if (modality === 'text' || modality === 'vision') return prefix
  if (modality === 'computer_use') return `${prefix}.computer-use`
  if (modality === 'image') return source === 'remote' ? 'desktop.remote-image' : 'desktop.image'
  if (modality === 'voice') return source === 'remote' ? 'desktop.remote-voice' : 'desktop.tts'
  if (modality === 'transcription') {
    return source === 'remote' ? 'desktop.remote-transcription' : 'desktop.transcription'
  }
  if (modality === 'embedding') {
    return source === 'remote' ? 'desktop.remote-embedding' : 'desktop.embedding'
  }
  return `${prefix}.${modality.replace('_', '-')}`
}
