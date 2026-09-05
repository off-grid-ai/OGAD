import { type ModelModality } from '@offgrid/models'
import type { DesktopLocalTextRuntime } from './model-generation-adapters'

export interface DesktopInventoryModel {
  id: string
  familyId?: string
  name?: string
  kind?: string
  files?: Array<{ name?: string; sizeBytes?: number; role?: string; installed?: boolean }>
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
  /** Verified on-disk bytes of an installed artifact file; undefined when not on disk. */
  installedArtifactBytes?(fileName: string): number | undefined
  localVoiceRuntimeState?(): Promise<{ installed: boolean; ready: boolean; error?: string }>
  /** The ONE native text-runtime boundary: lifecycle, readiness facts, settings, and generation. */
  localTextRuntime: DesktopLocalTextRuntime
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
