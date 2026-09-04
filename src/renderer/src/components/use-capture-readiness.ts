import { useCallback, useEffect, useState } from 'react'
import type { CaptureReadinessProjection } from '@offgrid/application'
import { captureReadinessClient } from '@renderer/lib/capture-readiness-client'
import type { ProgressLike } from '@offgrid/ui'
import { useModelDownloadProgress } from '@renderer/hooks/useModelDownloadProgress'

export interface CaptureReadinessController {
  projection: CaptureReadinessProjection | null
  progress: ProgressLike | null
  /**
   * Why the last readiness check or repair did not succeed, for the surface to SHOW. A repair
   * that failed silently left the prompt looking untouched and its button live again, so the
   * user's only reading was that the click did nothing.
   */
  failure: string | null
  repair(): Promise<void>
}

/** Shared already turned its typed failure into a sentence; anything else is an unexpected throw. */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : 'Capture vision support could not be prepared.'
}

/** Desktop composition for Shared capture readiness. It supplies Electron observations and I/O only. */
export function useCaptureReadiness(isPro: boolean): CaptureReadinessController {
  const [projection, setProjection] = useState<CaptureReadinessProjection | null>(null)
  const [progress, setProgress] = useState<ProgressLike | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    if (!isPro || !window.api.proInvoke) {
      setProjection(null)
      return
    }
    try {
      setProjection(await captureReadinessClient.projection())
      setFailure(null)
    } catch (error) {
      console.error('Failed to check capture vision readiness:', error)
      setFailure(failureText(error))
    }
  }, [isPro])

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
    } else if (event.status === 'failed' || event.status === 'interrupted') {
      // The projector download is the repair. Its failure IS the repair's failure, and it arrives
      // on this event rather than from the call that started it, so it has to be surfaced here.
      setProgress(null)
      setFailure(event.error ?? 'The vision projector download did not finish.')
    } else if (event.status === 'cancelled') {
      setProgress(null)
    } else {
      setProgress(event)
    }
  }, isPro)

  const repair = useCallback(async (): Promise<void> => {
    if (projection?.kind === 'missing-projector') setProgress({ percent: 0 })
    setFailure(null)
    try {
      if (projection) await captureReadinessClient.repair(projection)
    } catch (error) {
      setProgress(null)
      console.error('Failed to repair capture vision readiness:', error)
      setFailure(failureText(error))
    } finally {
      if (projection?.kind === 'missing-projector') setProgress(null)
      void refresh()
    }
  }, [projection, refresh])

  return { projection, progress, failure, repair }
}
