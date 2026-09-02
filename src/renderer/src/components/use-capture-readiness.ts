import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CaptureReadinessApplicationService,
  type CaptureReadinessObservation,
  type CaptureReadinessProjection
} from '@offgrid/models'
import type { ProgressLike } from '@offgrid/ui'
import { useModelDownloadProgress } from '@renderer/hooks/useModelDownloadProgress'
import { desktopModelControl } from '@renderer/lib/model-control-application'

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
    window.api.getModelVisionStatus?.(),
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

export interface CaptureReadinessController {
  projection: CaptureReadinessProjection | null
  progress: ProgressLike | null
  repair(): Promise<void>
}

/** Desktop composition for Shared capture readiness. It supplies Electron observations and I/O only. */
export function useCaptureReadiness(isPro: boolean): CaptureReadinessController {
  const [projection, setProjection] = useState<CaptureReadinessProjection | null>(null)
  const [progress, setProgress] = useState<ProgressLike | null>(null)
  const service = useMemo(
    () =>
      new CaptureReadinessApplicationService({
        observe: observeCaptureReadiness,
        downloadProjector: async (modelId) =>
          (await window.api.downloadModel?.(modelId)) ?? {
            success: false,
            error: 'download unavailable'
          },
        openVisionModelPicker: openModels
      }),
    []
  )

  const refresh = useCallback(async (): Promise<void> => {
    if (!isPro || !window.api.proInvoke) {
      setProjection(null)
      return
    }
    try {
      setProjection(await service.read())
    } catch (error) {
      console.error('Failed to check capture vision readiness:', error)
    }
  }, [isPro, service])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!isPro) return
    const offCapture = window.api.proOn?.('capture:changed', () => void refresh())
    return () => {
      if (typeof offCapture === 'function') offCapture()
    }
  }, [isPro, refresh])

  useModelDownloadProgress((event) => {
    if (projection?.kind !== 'missing-projector' || event.modelId !== projection.modelId) return
    if (event.status === 'completed') {
      setProgress(null)
      void refresh()
    } else if (event.status === 'failed' || event.status === 'cancelled') {
      setProgress(null)
    } else {
      setProgress(event)
    }
  }, isPro)

  const repair = useCallback(async (): Promise<void> => {
    if (projection?.kind === 'missing-projector') setProgress({ percent: 0 })
    try {
      const result = await service.repair()
      if (result.status === 'failed') {
        setProgress(null)
        console.error('Failed to repair capture vision readiness:', result.error)
      }
    } catch (error) {
      setProgress(null)
      console.error('Failed to repair capture vision readiness:', error)
    } finally {
      if (projection?.kind === 'missing-projector') setProgress(null)
      void refresh()
    }
  }, [projection?.kind, refresh, service])

  return { projection, progress, repair }
}
