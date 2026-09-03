import { useCallback, useEffect, useState } from 'react'
import type {
  CaptureReadinessApplicationService,
  CaptureReadinessProjection
} from '@offgrid/models'
import { captureReadinessApplication } from '@renderer/composition/capture-readiness'
import type { ProgressLike } from '@offgrid/ui'
import { useModelDownloadProgress } from '@renderer/hooks/useModelDownloadProgress'

export interface CaptureReadinessController {
  projection: CaptureReadinessProjection | null
  progress: ProgressLike | null
  repair(): Promise<void>
}

/** Desktop composition for Shared capture readiness. It supplies Electron observations and I/O only. */
export function useCaptureReadiness(isPro: boolean): CaptureReadinessController {
  const [projection, setProjection] = useState<CaptureReadinessProjection | null>(null)
  const [progress, setProgress] = useState<ProgressLike | null>(null)
  const service: CaptureReadinessApplicationService = captureReadinessApplication()

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
