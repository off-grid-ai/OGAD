import { taskScreenshotPath } from '../tasks/task-history'
import { emitVisionState, emitVisionStep } from '../vision/vision-controller'
import type { AxSnapshot } from './ax-elements'
import type { AxObservationFrame } from './ax-observation'

const AX_SCREEN_CAPTURE_ATTEMPTS = 3
const AX_SCREEN_CAPTURE_TIMEOUT_MS = 2_000
const AX_SCREEN_CAPTURE_RETRY_DELAY_MS = 100
const AX_SCREEN_CAPTURE_FAILURE_SUMMARY = `Off Grid AI could not capture the screen after ${AX_SCREEN_CAPTURE_ATTEMPTS} attempts. Check screen-recording permission, unlock the screen, then retry Computer Use.`

export class AxScreenCaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AxScreenCaptureError'
  }
}

interface AxFrameCaptureInput {
  taskId: string
  journeyId: string
  goal: string
  currentStep: number
  captureNumber: number
  snapshot: AxSnapshot
  signal?: AbortSignal
}

function snapshotBounds(
  snapshot: AxSnapshot
): { x: number; y: number; width: number; height: number } | undefined {
  if (!snapshot.elements.length) return undefined
  const xs = snapshot.elements.map((element) => element.cx)
  const ys = snapshot.elements.map((element) => element.cy)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.max(...xs) - left),
    height: Math.max(1, Math.max(...ys) - top)
  }
}

function abortError(signal: AbortSignal): Error {
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'screen capture stopped')
}

async function waitForRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal)
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal!))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, AX_SCREEN_CAPTURE_RETRY_DELAY_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    ;(timer as { unref?: () => void }).unref?.()
  })
}

async function withCaptureDeadline<T>(capture: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw abortError(signal)
  return await new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => finish(() => reject(abortError(signal!)))
    const finish = (result: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      result()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error('screen capture timed out'))),
      AX_SCREEN_CAPTURE_TIMEOUT_MS
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    capture.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error))
    )
    ;(timer as { unref?: () => void }).unref?.()
  })
}

/** Capture and project the AX screen-preview lifecycle through the existing task record. A task
 * must not keep running without the explicit screen-capture primitive: transient failures retry,
 * recovery becomes visible in the task trace, and exhaustion becomes one terminal task state. */
export async function captureAxObservationFrame({
  taskId,
  journeyId,
  goal,
  currentStep,
  captureNumber,
  snapshot,
  signal
}: AxFrameCaptureInput): Promise<AxObservationFrame> {
  const { vision } = await import('../vision')
  for (let attempt = 1; attempt <= AX_SCREEN_CAPTURE_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError(signal)
    const capture = await withCaptureDeadline(
      vision.captureDisplayFrame(
        snapshotBounds(snapshot),
        taskScreenshotPath(taskId, `ax-${captureNumber}-${attempt}`)
      ),
      signal
    ).catch(() => null)
    if (capture) {
      if (attempt > 1) {
        emitVisionStep(
          taskId,
          `Screen preview recovered on attempt ${attempt} of ${AX_SCREEN_CAPTURE_ATTEMPTS}.`
        )
      }
      return { capture, snapshot }
    }
    if (signal?.aborted) throw abortError(signal)
    if (attempt < AX_SCREEN_CAPTURE_ATTEMPTS) {
      const action = `Screen preview is unavailable. Retrying capture (${attempt}/${AX_SCREEN_CAPTURE_ATTEMPTS}).`
      emitVisionStep(taskId, action)
      emitVisionState({
        taskId,
        journeyId,
        goal,
        status: 'running',
        phase: 'checking',
        currentStep,
        currentAction: action
      })
      await waitForRetry(signal)
    }
  }

  const summary = AX_SCREEN_CAPTURE_FAILURE_SUMMARY
  emitVisionStep(taskId, `Screen preview failed: ${summary}`)
  emitVisionState({
    taskId,
    journeyId,
    goal,
    status: 'failed',
    phase: 'failed',
    currentStep,
    currentAction: summary,
    summary
  })
  throw new AxScreenCaptureError(summary)
}
