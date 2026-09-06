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

  // Newest first: `active` precedes `recent`, and Shared keeps `recent` newest-first. Both the
  // repair itself (`projector_repair`) and the control door's own record of the intent
  // (`control` / `repair-projector`) count, so a refusal at the door is read from the same
  // canonical projection as a failure mid-download.
  const repairOperations =
    projection?.kind === 'missing-projector'
      ? [...(operations?.active ?? []), ...(operations?.recent ?? [])].filter(
          (operation) =>
            operation.modelId === projection.modelId &&
            (operation.kind === 'projector_repair' ||
              (operation.kind === 'control' && operation.controlOperation === 'repair-projector'))
        )
      : []
  // The live download carries the measured progress; the door's record only frames it.
  const repairOperation =
    repairOperations.find(
      (operation) => operation.kind === 'projector_repair' && operation.state === 'active'
    ) ?? repairOperations[0]
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
