import type {
  WorkspaceGenerationPort,
  LLMService,
  ModelCapabilities,
  ModelControlApplicationSnapshot,
  ModelModality,
  ModelResidencyManager,
  ModelWorkspace,
  RuntimeModel
} from '@offgrid/models'
import type { ComputerUseActiveModelProjection } from '../shared/computer-use-settings'
import type { GenerationMetrics } from '../shared/generation-metrics'

export interface DesktopGenerationObservationPort {
  takeMetrics(turnId: string): GenerationMetrics | undefined
}

export interface DesktopModelServices {
  /** The one shared facade; `llm`, `generation`, `residency` below are its parts (migration). */
  workspace: ModelWorkspace
  llm: LLMService
  generation: WorkspaceGenerationPort
  residency: ModelResidencyManager
  generationObservations: DesktopGenerationObservationPort
  refresh(): Promise<RuntimeModel[]>
  routeIdFor(modality: ModelModality, nativeModelId?: string): string | undefined
  select(
    modality: ModelModality,
    modelId: string | null
  ): Promise<{ success: boolean; error?: string }>
  clearRemoteServerSelections(serverId: string): Promise<void>
  warmText(): Promise<boolean>
  unload(modality: ModelModality): Promise<boolean>
  shutdown(): Promise<void>
  activeModelIds(): Promise<string[]>
  activeModalities(): {
    text: string | null
    computer_use: string | null
    image: string | null
    speech: string | null
    transcription: string | null
  }
  modelControlSnapshot(): Promise<
    ModelControlApplicationSnapshot<
      {
        id: string
        name: string
        kind: string
        engine?: string
        remoteServerId?: string
        files?: Array<{ name: string; role?: string }>
        capabilities?: ModelCapabilities
      },
      ComputerUseActiveModelProjection
    >
  >
}

let services: DesktopModelServices | null = null

export function registerDesktopModelServices(value: DesktopModelServices): void {
  services = value
}

function current(): DesktopModelServices {
  if (!services) throw new Error('Desktop model services are not initialized.')
  return services
}

/** Stable inward-facing port. The composition root registers its implementation once. */
export const desktopModelServices: DesktopModelServices = new Proxy({} as DesktopModelServices, {
  get: (_target, property) => {
    const value = current()[property as keyof DesktopModelServices]
    return typeof value === 'function' ? value.bind(current()) : value
  }
})
