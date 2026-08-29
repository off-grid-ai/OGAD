import type { WebContentsView } from 'electron'
import { llm } from '../llm'
import { getComputerUseSettings } from '../computer-use-settings'
import { appendTaskStepDetail, getTaskExecutionDevice } from '../tasks/task-history'
import type { ComputerUseStepDetail } from '../tasks/task-step-details'
import type { TaskExecutionPlan } from '../../shared/task-execution-plan'
import { resolveComputerUseContextTokens } from '../../shared/computer-use-settings'
import { recentVisualFacts } from '../vision/visual-context'
import {
  type VisionStepObservation,
  type VisionTaskProgress,
  type VisionTaskResult
} from '../vision/vision-agent'
import { resolveVisionModelAdapterForStrategy } from '../vision/model-adapters'
import { generalVisionOperatorAdapter } from '../vision/model-adapters/general-vision-operator'
import type { VisionModelAdapter } from '../vision/model-adapters/types'
import { getActiveRemoteVisionServer } from '../vision/remote-vision-server'
import { remoteVisionModelId } from '../../shared/remote-vision-server'
import { createVisionGrounder } from '../vision/vision-policy-runner'
import { runVisionTaskGraph } from '../vision/vision-task-graph'
import type { VisionGuard } from '../vision/vision-guard'
import type { ModelIdentity } from '../models-manager'
import {
  withVisionTaskModelStrategy,
  type VisionTaskModelSession
} from '../vision/vision-task-model-strategy'
import type { BrowserDriver } from './browser-driver'
import { createBrowserVisionScreen } from './browser-vision-screen'

export interface BrowserVisionSelection {
  adapter: VisionModelAdapter
  modelId: string
}

export interface ActiveBrowserVision {
  selection: BrowserVisionSelection
  identity: ModelIdentity
  decide: VisionTaskModelSession['decide']
}

export interface ActiveBrowserVisionDependencies {
  withSelectedModel<T>(task: () => Promise<T>): Promise<{ result: T }>
  resolveSelection(): BrowserVisionSelection
  resolveIdentity(modelId: string): Promise<ModelIdentity>
}

/** Capture the adapter and model ID from one active-model read. The task host
 * persists this identity, so a later global selection cannot relabel the run. */
export function resolveActiveBrowserVisionSelection(): BrowserVisionSelection {
  const remote = getActiveRemoteVisionServer()
  if (remote) {
    return {
      adapter: generalVisionOperatorAdapter,
      modelId: remoteVisionModelId(remote.id, remote.model)
    }
  }
  const artifacts = llm.activeModelArtifacts()
  if (!artifacts) {
    throw new Error('Web Use requires an active model with installed vision support.')
  }
  try {
    const strategy = getComputerUseSettings().modelStrategy
    return {
      // The user's strategy decides the adapter: "Same as Chat" means a general tool-calling VLM
      // is driving, whatever it is named.
      adapter: resolveVisionModelAdapterForStrategy(
        artifacts,
        strategy === 'text_plus_specialist' ? 'same_as_chat' : strategy
      ),
      modelId: artifacts.id
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Vision support is unavailable.'
    throw new Error(`Web Use requires an active vision model. ${detail}`)
  }
}

/** Back-compatible adapter-only boundary for callers that do not own a task. */
export function resolveActiveBrowserVisionAdapter(): VisionModelAdapter {
  return resolveActiveBrowserVisionSelection().adapter
}

/** Run only after the selected Computer Use model is resident. Identity and
 * adapter come from the same post-swap snapshot that performs the task. */
export async function withActiveBrowserVision<T>(
  task: (active: ActiveBrowserVision) => Promise<T>,
  dependencies?: ActiveBrowserVisionDependencies
): Promise<T> {
  if (!dependencies) {
    return withVisionTaskModelStrategy('embedded_browser', (session) =>
      task({
        selection: { adapter: session.adapter, modelId: session.identity.modelId },
        identity: session.identity,
        decide: session.decide
      })
    )
  }
  const { result } = await dependencies.withSelectedModel(async () => {
    const selection = dependencies.resolveSelection()
    const identity = await dependencies.resolveIdentity(selection.modelId)
    return task({
      selection,
      identity,
      decide: createVisionGrounder(selection.adapter, 'embedded_browser')
    })
  })
  return result
}

interface BrowserVisualTaskInput {
  goal: string
  taskId: string
  journeyId: string
  adapter: VisionModelAdapter
  decide?: VisionTaskModelSession['decide']
  guard: VisionGuard
  plan: TaskExecutionPlan
  /** Trace of the attempt being resumed, so a retry restarts at the phase it reached. */
  resumedSteps?: readonly string[]
  activePage: () => { view: WebContentsView; driver: BrowserDriver }
  takeGuidance: () => readonly string[]
  waitForUser: (why: string) => Promise<void>
  onStep: (note: string) => void
  onPhase: (phaseId: string) => void
  onProgress: (progress: VisionTaskProgress) => void
  onReasoning?: (reasoning: { step: number; content: string; live: boolean }) => void
  signal?: AbortSignal
}

/** Runs the browser screenshot -> decision -> action -> verification loop.
 * Session ownership and task status remain in BrowserHost. */
export function runBrowserVisualTask(input: BrowserVisualTaskInput): Promise<VisionTaskResult> {
  const settings = getComputerUseSettings()
  const executionDevice = getTaskExecutionDevice()
  return runVisionTaskGraph(input.goal, {
    screen: createBrowserVisionScreen({
      activePage: input.activePage,
      taskId: input.taskId,
      journeyId: input.journeyId,
      goal: input.goal,
      settings,
      screenshotResizeFactor: input.adapter.screenshotResizeFactor
    }),
    guard: input.guard,
    decide: input.decide ?? createVisionGrounder(input.adapter, 'embedded_browser'),
    parseResponse: input.adapter.parseResponse,
    waitForUser: input.waitForUser,
    onStep: input.onStep,
    plan: input.plan,
    ...(input.resumedSteps?.length ? { resumedSteps: input.resumedSteps } : {}),
    onPhase: input.onPhase,
    onProgress: input.onProgress,
    onReasoning: input.onReasoning,
    takeGuidance: input.takeGuidance,
    contextTokens: resolveComputerUseContextTokens(settings.context, llm.effectiveContextSize()),
    checkpointInterval: settings.checkpointInterval,
    visualHistoryFrames: settings.visualHistoryFrames,
    retrievedFacts: settings.retrieveOlderVisuals ? recentVisualFacts(input.taskId) : [],
    signal: input.signal,
    onObservation: (observation) => {
      const detail = browserVisionStepDetail(observation, executionDevice)
      appendTaskStepDetail(input.taskId, 'web_use', input.goal, detail)
      // Every supported provider returns visible_evidence in the validated
      // decision. Surface that public rationale even when the provider does not
      // expose a separate private reasoning stream.
      if (detail.decisionRationale?.trim()) {
        input.onReasoning?.({
          step: observation.step,
          content: detail.decisionRationale.trim(),
          live: false
        })
      }
    }
  })
}

/** Pure projection from a graph event to the task-history evidence schema. */
export function browserVisionStepDetail(
  observation: VisionStepObservation,
  executionDevice: { id: string; name: string },
  at = Date.now()
): ComputerUseStepDetail {
  const geometry = observation.screenshot.metadata?.geometry
  const mappedAction = serializeObservationAction(observation)
  return {
    stepId: String(observation.step),
    at,
    phase: observation.phase,
    ...(geometry
      ? {
          screenshot: {
            path: observation.screenshot.metadata?.path,
            availability: 'device_local' as const,
            executionDeviceId: executionDevice.id,
            executionDeviceName: executionDevice.name,
            originalWidth: geometry.sourceBounds.width,
            originalHeight: geometry.sourceBounds.height,
            inferenceWidth: geometry.encodedSize.width,
            inferenceHeight: geometry.encodedSize.height,
            ...(observation.screenshot.metadata?.viewport
              ? {
                  viewportWidth: observation.screenshot.metadata.viewport.width,
                  viewportHeight: observation.screenshot.metadata.viewport.height
                }
              : {})
          }
        }
      : {}),
    retrievedFacts: observation.retrievedFacts,
    decisionSummary: observation.decisionSummary,
    reasoning: observation.reasoning,
    decisionRationale: observation.decisionRationale,
    rawResponse: observation.rawResponse,
    mappedAction,
    ...(mappedAction
      ? {
          actionCoordinateSpace:
            observation.mappedActions?.length || observation.mappedAction
              ? ('viewport' as const)
              : ('inference' as const)
        }
      : {}),
    ...(observation.timings ? { timings: observation.timings } : {}),
    execution: {
      status: observation.result === 'error' ? 'failed' : 'complete',
      durationMs: observation.durationMs,
      result: observation.result,
      error: observation.error
    }
  }
}

function serializeObservationAction(observation: VisionStepObservation): string | undefined {
  const action = observation.mappedActions?.length
    ? observation.mappedActions
    : observation.mappedAction
      ? observation.mappedAction
      : observation.parsedActions?.length
        ? observation.parsedActions
        : observation.parsedAction
  return action ? JSON.stringify(action) : undefined
}
