import type {
  CaptureReadinessApplicationService,
  CaptureReadinessObservation
} from '@offgrid/models'
import { desktopModelControl } from '@renderer/composition/model-control'

interface CaptureStatusObservation {
  running?: boolean
  paused?: boolean
  visionReady?: boolean
}

interface ModelVisionObservation {
  supportsVision: boolean
  projectorInstalled: boolean
}

function openModels(): void {
  window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'models' }))
  window.history.replaceState(null, '', '/models')
}

async function observeCaptureReadiness(): Promise<CaptureReadinessObservation> {
  const [modelControl, statuses, capture] = await Promise.all([
    desktopModelControl.project(),
    window.api.getModelVisionStatus(),
    window.api.proInvoke?.('capture:status')
  ])
  const activeId = modelControl.active.text
  const captureStatus = (capture ?? {}) as CaptureStatusObservation
  const visionStatuses = (statuses ?? {}) as Record<string, ModelVisionObservation>
  const activeStatus = activeId ? visionStatuses[activeId] : undefined
  const catalogModel = activeId
    ? modelControl.models.find((model) => model.id === activeId)
    : undefined
  return {
    capture: {
      running: captureStatus.running === true,
      paused: captureStatus.paused === true,
      visionReady: captureStatus.visionReady === true
    },
    activeModel: activeId
      ? {
          id: activeId,
          name: catalogModel?.name ?? activeId.split('/').pop() ?? activeId,
          supportsVision: activeStatus?.supportsVision === true,
          projectorInstalled: activeStatus?.projectorInstalled === true
        }
      : null
  }
}

type CaptureReadinessPorts = ConstructorParameters<typeof CaptureReadinessApplicationService>[0]

/** Electron observations and I/O only; Shared decides readiness. */
export function desktopCaptureReadinessPorts(): CaptureReadinessPorts {
  return {
    observe: observeCaptureReadiness,
    downloadProjector: async (modelId) =>
      (await window.api.downloadModel(modelId)) ?? {
        success: false,
        error: 'download unavailable'
      },
    openVisionModelPicker: openModels
  }
}
