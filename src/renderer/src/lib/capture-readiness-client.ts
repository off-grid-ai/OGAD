import {
  modelsFailureMessage,
  projectCaptureReadiness,
  type CaptureReadinessProjection
} from '@offgrid/application'
import { modelControlClient } from './model-control-client'

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

/** Thin Electron observer/client. Shared owns readiness projection and projector repair. */
export const captureReadinessClient = {
  async projection(): Promise<CaptureReadinessProjection> {
    const [models, statuses, capture] = await Promise.all([
      modelControlClient.projection(),
      window.api.getModelVisionStatus(),
      window.api.proInvoke?.('capture:status')
    ])
    const activeId = models.active.text.modelId
    const captureStatus = (capture ?? {}) as CaptureStatusObservation
    const visionStatuses = (statuses ?? {}) as Record<string, ModelVisionObservation>
    const activeStatus = activeId ? visionStatuses[activeId] : undefined
    const catalogModel = activeId ? models.models.find((model) => model.id === activeId) : undefined
    return projectCaptureReadiness({
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
    })
  },

  async repair(projection: CaptureReadinessProjection): Promise<void> {
    if (projection.kind === 'choose-vision-model') {
      openModels()
      return
    }
    if (projection.kind !== 'missing-projector') return
    const outcome = await modelControlClient.control({
      type: 'repair-projector',
      modelId: projection.modelId
    })
    if (!outcome.ok) throw new Error(modelsFailureMessage(outcome.failure))
    if (outcome.value.status === 'projector_installed_not_ready') {
      throw new Error(modelsFailureMessage(outcome.value.failure))
    }
  }
}
