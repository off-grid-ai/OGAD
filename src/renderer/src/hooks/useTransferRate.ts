import { useCallback, useRef } from 'react'
import { sampleProgressRate, type ProgressRateSample } from '@offgrid/ui'

/**
 * The download's transfer rate, measured where it is shown.
 *
 * Main used to compute this and send it, which meant the main process importing
 * `sampleProgressRate` from `@offgrid/ui` for arithmetic no part of main reads. A rate exists to be
 * rendered - this file formats it two lines later with `formatTransferSpeed` - so it is derived
 * here, from the observations main sends: how many bytes, and when they were counted.
 *
 * Two explicit observations, no timer and no module state: a counter reset, a clock that goes
 * backwards or a repeated timestamp starts a new baseline instead of reporting a rate that never
 * happened.
 */
export function useTransferRate(): {
  measure: (currentBytes: number | undefined, sampledAtMs: number | undefined) => number | undefined
  reset: () => void
} {
  const sample = useRef<ProgressRateSample | undefined>(undefined)
  const measure = useCallback(
    (currentBytes: number | undefined, sampledAtMs: number | undefined): number | undefined => {
      if (currentBytes === undefined || sampledAtMs === undefined) return undefined
      const measured = sampleProgressRate(sample.current, { currentBytes, sampledAtMs })
      sample.current = measured.sample
      return measured.bytesPerSecond
    },
    []
  )
  const reset = useCallback((): void => {
    sample.current = undefined
  }, [])
  return { measure, reset }
}
