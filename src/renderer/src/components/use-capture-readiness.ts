import { useCallback, useEffect, useState } from 'react'
import {
  modelsFailureMessage,
  type CaptureReadinessProjection,
  type ModelsOperationsSnapshot
} from '@offgrid/application'
import { captureReadinessClient } from '@renderer/lib/capture-readiness-client'
import { modelControlClient } from '@renderer/lib/model-control-client'
import type { ProgressLike } from '@offgrid/ui'

export interface CaptureReadinessController {
  projection: CaptureReadinessProjection | null
  progress: ProgressLike | null
  repairing: boolean
  /**
   * Why the last readiness check or repair did not succeed, for the surface to SHOW. A repair
   * that failed silently left the prompt looking untouched and its button live again, so the
   * user's only reading was that the click did nothing.
   */
  failure: string | null
  repair(): Promise<void>
}

/** Desktop composition for Shared capture readiness. It supplies Electron observations and I/O only. */
export function useCaptureReadiness(isPro: boolean): CaptureReadinessController {
  const [projection, setProjection] = useState<CaptureReadinessProjection | null>(null)
  const [operations, setOperations] = useState<ModelsOperationsSnapshot | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    if (!isPro || !window.api.proInvoke) {
      setProjection(null)
      return
    }
    try {
      const [nextProjection, nextOperations] = await Promise.all([
        captureReadinessClient.projection(),
        modelControlClient.operations()
      ])
      setProjection(nextProjection)
      setOperations(nextOperations)
    } catch (error) {
      console.error('Failed to check capture vision readiness:', error)
    }
  }, [isPro])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!isPro) return
    const offCapture = window.api.proOn?.('capture:changed', () => void refresh())
    const offOperations = modelControlClient.observeOperations(setOperations)
    return () => {
      if (typeof offCapture === 'function') offCapture()
      offOperations()
    }
  }, [isPro, refresh])

  const repairOperation =
    projection?.kind === 'missing-projector'
      ? [...(operations?.active ?? []), ...(operations?.recent ?? [])].find(
          (operation) =>
            operation.kind === 'projector_repair' && operation.modelId === projection.modelId
        )
      : undefined
  const repairing = repairOperation?.state === 'active'
  const progress: ProgressLike | null = repairing ? (repairOperation.progress ?? null) : null
  const failure = repairOperation?.failure ? modelsFailureMessage(repairOperation.failure) : null

  const repair = useCallback(async (): Promise<void> => {
    try {
      if (projection) await captureReadinessClient.repair(projection)
    } catch (error) {
      console.error('Failed to repair capture vision readiness:', error)
    } finally {
      void refresh()
    }
  }, [projection, refresh])

  return { projection, progress, repairing, failure, repair }
}
