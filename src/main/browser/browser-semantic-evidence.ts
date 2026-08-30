import type { WebContentsView } from 'electron'
import { getComputerUseSettings } from '../computer-use-settings'
import { appendTaskStepDetail, getTaskExecutionDevice } from '../tasks/task-history'
import type { ComputerUseStepDetail } from '../tasks/task-step-details'
import type { BrowserDriver } from './browser-driver'
import type { BrowserSemanticObservation } from './browser-playwright-task-contract'
import { createBrowserVisionScreen } from './browser-vision-screen'

interface BrowserSemanticEvidenceInput {
  goal: string
  taskId: string
  journeyId: string
  activePage: () => { view: WebContentsView; driver: BrowserDriver }
}

type BrowserCapture = Awaited<ReturnType<ReturnType<typeof createBrowserVisionScreen>['capture']>>

interface BrowserSemanticStepDetailInput {
  observation: BrowserSemanticObservation
  screenshot: BrowserCapture
  executionDevice: { id: string; name: string }
  at?: number
}

/** Use the same bounded screenshot and task-history path for semantic and visual Web Use. */
export function createBrowserSemanticEvidenceRecorder(
  input: BrowserSemanticEvidenceInput
): (observation: BrowserSemanticObservation) => Promise<void> {
  const screen = createBrowserVisionScreen({
    activePage: input.activePage,
    taskId: input.taskId,
    journeyId: input.journeyId,
    goal: input.goal,
    settings: getComputerUseSettings()
  })
  const executionDevice = getTaskExecutionDevice()
  return async (observation) => {
    const screenshot = await screen.capture()
    appendTaskStepDetail(
      input.taskId,
      'web_use',
      input.goal,
      browserSemanticStepDetail({ observation, screenshot, executionDevice })
    )
  }
}

/** Pure projection from one semantic page observation to the shared replay schema. */
export function browserSemanticStepDetail(
  input: BrowserSemanticStepDetailInput
): ComputerUseStepDetail {
  const { observation, screenshot, executionDevice } = input
  const geometry = screenshot.metadata?.geometry
  return {
    stepId: `semantic-${observation.step}-${observation.phase}`,
    at: input.at ?? Date.now(),
    phase: observation.phase,
    ...(geometry
      ? {
          screenshot: {
            path: screenshot.metadata?.path,
            availability: 'device_local' as const,
            executionDeviceId: executionDevice.id,
            executionDeviceName: executionDevice.name,
            originalWidth: geometry.sourceBounds.width,
            originalHeight: geometry.sourceBounds.height,
            inferenceWidth: geometry.encodedSize.width,
            inferenceHeight: geometry.encodedSize.height,
            ...(screenshot.metadata?.viewport
              ? {
                  viewportWidth: screenshot.metadata.viewport.width,
                  viewportHeight: screenshot.metadata.viewport.height
                }
              : {})
          }
        }
      : {}),
    decisionSummary: observation.summary,
    execution: { status: 'complete', result: 'semantic page observed' }
  }
}
