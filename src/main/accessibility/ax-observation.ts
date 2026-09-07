import {
  appendComputerUseStepDetail,
  getTaskExecutionDevice,
  recordTaskRun
} from '../tasks/task-history'
import type { CapturedDisplayFrame } from '../vision'
import type { ElementStepObservation } from './ax-agent'
import type { AxSnapshot } from './ax-elements'

export interface AxObservationFrame {
  capture: CapturedDisplayFrame
  snapshot: AxSnapshot
}

interface AxFramePersistence {
  taskId: string
  journeyId: string
  title: string
  frame: AxObservationFrame
}

/** Make a newly captured frame durable before any later progress projection can
 * prune files that are not referenced by task history yet. This is the single
 * owner for the AX rail's current live-frame path. */
export function persistAxFrame(input: AxFramePersistence): void {
  const { taskId, journeyId, title, frame } = input
  const executionDevice = getTaskExecutionDevice()
  recordTaskRun({
    taskId,
    journeyId,
    kind: 'computer_use',
    title,
    screenshotPath: frame.capture.path,
    screenshotDeviceId: executionDevice.id,
    executionDeviceId: executionDevice.id,
    executionDeviceName: executionDevice.name
  })
}

type AxObservationInput = ElementStepObservation & { frame?: AxObservationFrame }

function targetIndex(observation: ElementStepObservation): number | undefined {
  const action = observation.parsedAction
  if (!action || !('index' in action)) return undefined
  return action.index
}

function mappedAction(
  observation: ElementStepObservation,
  frame: AxObservationFrame | undefined
): string | undefined {
  const action = observation.parsedAction
  if (action === undefined) return undefined
  if (!action || !frame) return JSON.stringify(action)
  const index = targetIndex(observation)
  const element = index
    ? frame.snapshot.elements.find((candidate) => candidate.index === index)
    : undefined
  if (!element) return JSON.stringify(action)
  const { displayBounds, width, height } = frame.capture
  if (displayBounds.width <= 0 || displayBounds.height <= 0) return JSON.stringify(action)
  const x = Math.round(((element.cx - displayBounds.x) * width) / displayBounds.width)
  const y = Math.round(((element.cy - displayBounds.y) * height) / displayBounds.height)
  return JSON.stringify({ ...action, point: { x, y } })
}

/** Persist AX planning evidence through the same bounded, redacted task-history
 * adapter as vision Computer Use. The model remains text-grounded; the frame is
 * for user supervision and execution evidence. */
export function persistAxObservation(
  taskId: string,
  title: string,
  observation: AxObservationInput
): void {
  const { frame } = observation
  const executionDevice = frame ? getTaskExecutionDevice() : undefined
  appendComputerUseStepDetail(taskId, title, {
    stepId: String(observation.step),
    at: Date.now(),
    phase: observation.result === 'error' ? 'failed' : 'checking',
    retrievedFacts: observation.retrievedFacts,
    decisionSummary:
      observation.parsedAction === undefined
        ? observation.result
        : JSON.stringify(observation.parsedAction),
    rawResponse: observation.rawResponse,
    ...(frame && executionDevice
      ? {
          screenshot: {
            path: frame.capture.path,
            availability: 'device_local',
            executionDeviceId: executionDevice.id,
            executionDeviceName: executionDevice.name,
            originalWidth: frame.capture.displayBounds.width,
            originalHeight: frame.capture.displayBounds.height,
            inferenceWidth: frame.capture.width,
            inferenceHeight: frame.capture.height
          }
        }
      : {}),
    mappedAction: mappedAction(observation, frame),
    ...(frame ? { actionCoordinateSpace: 'inference' as const } : {}),
    execution: {
      status: observation.result === 'error' ? 'failed' : 'complete',
      durationMs: observation.durationMs,
      result: observation.result,
      error: observation.error
    }
  })
}
