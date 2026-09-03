import {
  type ModelControlApplicationService,
  type ModelCapabilities,
  type ModelControlProjection,
  type ModelControlSurface,
  type ModelKind
} from '@offgrid/application'
import type { ComputerUseActiveModelProjection } from '../../../shared/computer-use-settings'

export interface DesktopModelControlModel {
  id: string
  name: string
  kind: ModelKind
  sourceModelId?: string
  engine?: string
  description?: string
  files: Array<{ name: string; role?: string; sizeBytes?: number; url?: string }>
  remoteServerId?: string
  remoteModelId?: string
  grounder?: boolean
  availability?: 'ready' | 'coming_soon'
  availabilityNote?: string
  org?: string
  params?: number
  minRamGb?: number
  isNew?: boolean
  imageModes?: string[]
  tags?: string[]
  releaseDate?: string
  quant?: string
  capabilities?: ModelCapabilities
}

export type DesktopModelControlProjection = ModelControlProjection<
  DesktopModelControlModel,
  ComputerUseActiveModelProjection
>

/** Narrow privileged boundary required by the model-control application. */
export interface DesktopModelControlPreloadPort {
  getModelControlSnapshot(): Promise<DesktopModelControlProjection>
  estimateModelFit(modelId: string): Promise<{ level: string; message?: string } | null>
  activateModel(
    modelId: string,
    requestedKind?: string
  ): Promise<{ success: boolean; error?: string }>
  setActiveModalModel(
    surface: Exclude<ModelControlSurface, 'text'>,
    modelId: string | null
  ): Promise<{ success: boolean; error?: string }>
  downloadModel(modelId: string): Promise<{ success: boolean; error?: string }>
  cancelModelDownload(modelId: string): Promise<boolean>
  unloadRuntime(modality: 'llm' | 'image' | 'tts' | 'stt'): Promise<boolean>
  deleteModel(modelId: string): Promise<{ success: boolean; error?: string }>
}

const api = (): DesktopModelControlPreloadPort => window.api

type DesktopModelControlPorts = ConstructorParameters<
  typeof ModelControlApplicationService<DesktopModelControlModel, ComputerUseActiveModelProjection>
>[0]

/** Electron methods as I/O ports only. Shared owns every decision; the instance is composed in
 *  `@renderer/composition/model-control`. */
export function desktopModelControlPorts(): DesktopModelControlPorts {
  return {
    snapshot: async () => {
      return api().getModelControlSnapshot()
    },
    assess: (modelId) => api().estimateModelFit(modelId),
    activate: (modelId, requestedKind) => api().activateModel(modelId, requestedKind),
    select: (surface, modelId) => api().setActiveModalModel(surface, modelId),
    download: (modelId) => api().downloadModel(modelId),
    cancelDownload: (modelId) => api().cancelModelDownload(modelId),
    unload: (modality) => api().unloadRuntime(modality),
    remove: async (modelId) => {
      return api().deleteModel(modelId)
    }
  }
}
