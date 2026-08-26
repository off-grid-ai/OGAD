/**
 * The vision loop (R2-D): screenshot -> ground -> actuate, under the guard,
 * until the model reports finished, calls the user, or the guard stops it.
 * The supervised tier - every actuation is on the user's live desktop, so the
 * guard (kill switch and explicit pause) gates each one and the user
 * always overrides.
 *
 * Every boundary is injected - the screen (capture + actuate), the grounding
 * model (ground), the guard, and the takeover wait - so the loop's control
 * flow is fully unit-tested without a display: what it actuates, what it
 * refuses, when it pauses, when it stops.
 */
import type { VisionAction, Bounds } from './vision-action'
import type { VisionGuard } from './vision-guard'
import {
  computerUseHistoryTokenBudget,
  tailWithinTokenBudget
} from '../../shared/computer-use-settings'
import type { ScreenshotGeometry } from './screenshot-geometry'
import { uiTarsAdapter } from './model-adapters/ui-tars'
import type {
  VisionPolicyCoordinateFrame,
  VisionPolicyDecision,
  VisionPolicyHistoryStep
} from './model-adapters/types'
import type { ComputerUsePhase } from '../tasks/task-step-details'
import { DEFAULT_COMPUTER_USE_STEP_BUDGET } from '../../shared/computer-use-limits'
import type { TaskExecutionPlan } from '../../shared/task-execution-plan'
import {
  createTaskPhaseReporter,
  formatTaskExecutionPlanContext
} from '../tasks/task-execution-plan-service'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../tasks/task-guide'
import { CurrentTaskBrief } from '../tasks/current-task-brief'

export interface VisionCaptureMetadata {
  path?: string
  geometry?: ScreenshotGeometry
  /** CSS-pixel bounds used by browser input for this captured frame. */
  viewport?: Bounds
}

export interface VisionActuationResult {
  mappedAction?: VisionAction
  /** Execution-boundary handoff. The private value is intentionally absent. */
  handoff?: string
  /** The surface refused a recoverable action before any input was sent. */
  rejected?: string
}

/** A screen can request a fresh observation when its capture boundary changed
 * underneath it. The owning screen must bound retries before using this. */
export class RecoverableVisionError extends Error {
  override readonly name = 'RecoverableVisionError'
}

export interface VisionGroundingInput {
  goal: string
  image: string
  history: string[]
  retrievedFacts: string[]
  policyHistory: readonly VisionPolicyHistoryStep[]
  guidance: readonly string[]
  currentMilestone?: string
  verifiedActions?: readonly string[]
  /** Last action that crossed the execution boundary, in the pixel frame used
   * when the model selected it. The policy runner annotates the exact next
   * screenshot used by both the model and task history. */
  previousVerifiedAction?: {
    action: VisionAction
    coordinateFrame: VisionPolicyCoordinateFrame
  }
  coordinateFrame?: VisionPolicyCoordinateFrame
  /** Audit-safe stage updates only. Never send hidden reasoning through this callback. */
  reportProgress?: (action: string) => void
  /** Separated reasoning-channel deltas from the active model request. */
  reportReasoning?: (text: string) => void
  /** One run-wide cancellation signal shared by the graph and model boundary. */
  signal?: AbortSignal
}

export interface VisionGroundingResult {
  response: string
  /** A native tool-call adapter can validate the graph transition before this
   * result crosses the model boundary. */
  decision?: VisionPolicyDecision
  /** Exact adapter messages with binary image payloads replaced by a marker. */
  modelInput: string
  /** The model-ready frame retained only inside the bounded policy history. */
  screenshotDataUrl?: string
}

export interface VisionStepObservation {
  step: number
  phase: ComputerUsePhase
  promptContext: string
  screenshot: { image: string; bounds: Bounds; metadata?: VisionCaptureMetadata }
  retrievedFacts: string[]
  decisionSummary?: string
  /** Bounded reasoning-channel output for the model request that produced this step. */
  reasoning?: string
  /** Concise adapter-derived rationale. Never raw hidden chain-of-thought. */
  decisionRationale?: string
  rawResponse?: string
  parsedAction?: VisionAction | null
  parsedActions?: readonly VisionAction[]
  failedActionIndex?: number
  mappedAction?: VisionAction
  mappedActions?: readonly VisionAction[]
  durationMs: number
  result:
    | 'reviewed'
    | 'parse_failed'
    | 'actuated'
    | 'wait'
    | 'terminal'
    | 'handoff'
    | 'blocked'
    | 'error'
  error?: string
}

export interface VisionTaskProgress {
  step: number
  phase: ComputerUsePhase
  action: string
}

export interface VisionTaskReasoning {
  step: number
  content: string
  live: boolean
}

export interface VisionScreen {
  /** The current screenshot reference and its encoded-image pixel bounds. */
  capture(): Promise<{ image: string; bounds: Bounds; metadata?: VisionCaptureMetadata }>
  /** Perform one grounded action on the live desktop. */
  actuate(
    action: VisionAction,
    context?: { decisionRationale?: string }
  ): Promise<VisionActuationResult | void>
}

export interface VisionTaskDeps {
  screen: VisionScreen
  guard: VisionGuard
  /** The grounding model: the goal + a screenshot in, one UI-TARS action out. */
  ground: (input: VisionGroundingInput) => Promise<string | VisionGroundingResult>
  /** Model-family parser. Defaults to the legacy UI-TARS adapter. */
  parseResponse?: (
    response: string,
    bounds: Bounds,
    coordinateFrame?: VisionPolicyCoordinateFrame
  ) => VisionPolicyDecision
  /** Parks until the user finishes a call_user handoff. */
  waitForUser: (why: string) => Promise<void>
  onStep?: (note: string) => void
  onProgress?: (progress: VisionTaskProgress) => void
  onReasoning?: (reasoning: VisionTaskReasoning) => void
  onObservation?: (observation: VisionStepObservation) => void
  onCheckpoint?: (step: number, steps: readonly string[]) => void
  contextTokens?: number
  checkpointInterval?: number
  visualHistoryFrames?: number
  retrievedFacts?: string[]
  now?: () => number
  maxPlanningSteps?: number
  plan?: TaskExecutionPlan
  onPhase?: (phaseId: string) => void
  takeGuidance?: () => readonly string[]
  signal?: AbortSignal
}

export interface VisionTaskResult {
  ok: boolean
  summary: string
  steps: string[]
  handoffs: number
}

const DEFAULT_HISTORY_TOKENS = 2_048

export function buildGroundingHistory(
  steps: string[],
  tokenBudget = DEFAULT_HISTORY_TOKENS
): string[] {
  return tailWithinTokenBudget(steps, tokenBudget)
}

/* eslint-disable complexity -- one supervised state machine; per-verb helpers
   would hide the guard/pause/stop control flow the tests pin down. */
export async function runVisionTask(goal: string, deps: VisionTaskDeps): Promise<VisionTaskResult> {
  const { screen, guard, ground, waitForUser, onStep } = deps
  const steps: string[] = []
  let handoffs = 0
  let modelStep = 0
  let phaseIndex = 0
  const now = deps.now ?? Date.now
  const retrievedFacts = deps.retrievedFacts ?? []
  const policyHistory: VisionPolicyHistoryStep[] = []
  const verifiedActions: string[] = []
  const taskBrief = new CurrentTaskBrief(goal)
  const parseResponse = deps.parseResponse ?? uiTarsAdapter.parseResponse
  const checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
  const maxPlanningSteps = Math.max(
    1,
    Math.floor(deps.maxPlanningSteps ?? DEFAULT_COMPUTER_USE_STEP_BUDGET)
  )
  const note = (line: string): void => {
    steps.push(line)
    onStep?.(line)
  }
  const reportPhase = createTaskPhaseReporter(deps.plan, deps.onPhase)
  const basePlanContext = deps.plan ? formatTaskExecutionPlanContext(deps.plan) : ''
  reportPhase(0)
  const progress = (phase: ComputerUsePhase, step: number, action: string): void => {
    deps.onProgress?.({ phase, step, action })
  }
  const checkpoint = (): void => {
    if (modelStep % checkpointInterval === 0) {
      deps.onCheckpoint?.(modelStep, steps)
    }
  }

  for (;;) {
    if (modelStep >= maxPlanningSteps) {
      progress('failed', modelStep, 'Reached the planning-step limit')
      const summary = `Computer use stopped after ${maxPlanningSteps} planning steps.`
      note(summary)
      return { ok: false, summary, steps, handoffs }
    }
    if (!guard.canActuate()) {
      const { state, reason } = guard.snapshot()
      if (state === 'paused') {
        // A visible Pause or Take Over command owns this transition. Passive
        // mouse movement never pauses the task.
        progress('paused', modelStep, reason || 'Waiting for you')
        note(`paused: ${reason}`)
        await guard.waitUntilRunnable()
        if (guard.isHalted) continue
        note('resumed by the user')
        continue
      }
      progress('stopped', modelStep, reason || 'Stopped')
      note(`stopped: ${reason}`)
      return { ok: false, summary: reason, steps, handoffs }
    }

    modelStep += 1
    progress('observing', modelStep, 'Reading the current screen')
    const startedAt = now()
    let shot: Awaited<ReturnType<VisionScreen['capture']>> | undefined
    let rawResponse: string
    let groundingDecision: VisionPolicyDecision | undefined
    let screenshotDataUrl: string | undefined
    const newGuidance = deps.takeGuidance?.() ?? []
    taskBrief.accept(newGuidance)
    const guidance = [...taskBrief.guidance]
    const currentPhase = deps.plan?.phases[phaseIndex]
    const planContext = [
      basePlanContext,
      currentPhase
        ? `Current milestone: ${currentPhase.title}\nInterpret this milestone against the current Task brief above. Mark it complete only after its result is visible.`
        : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    const history = buildGroundingHistory(
      planContext ? [planContext, ...steps] : steps,
      computerUseHistoryTokenBudget(deps.contextTokens ?? DEFAULT_HISTORY_TOKENS)
    )
    const durableTaskObjective = taskBrief.guidance.reduce(
      (safeObjective, privateText) =>
        safeObjective.split(privateText).join(TASK_GUIDANCE_APPLIED_TRACE),
      taskBrief.objective
    )
    let promptContext = [
      `Task: ${durableTaskObjective}`,
      retrievedFacts.length > 0 ? `Past task facts:\n${retrievedFacts.join('\n')}` : '',
      history.length > 0 ? `Current task history:\n${history.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      shot = await screen.capture()
      const sourceBounds = shot.metadata?.geometry?.sourceBounds
      const coordinateFrame = {
        encoded: shot.bounds,
        source: sourceBounds
          ? { width: sourceBounds.width, height: sourceBounds.height }
          : shot.bounds
      }
      progress('thinking', modelStep, 'Reading the current screen with the model')
      const grounding = await ground({
        goal: taskBrief.objective,
        image: shot.image,
        history,
        retrievedFacts,
        policyHistory,
        guidance,
        currentMilestone: currentPhase?.title,
        verifiedActions: [...verifiedActions],
        coordinateFrame,
        reportProgress: (action) => progress('thinking', modelStep, action)
      })
      rawResponse = typeof grounding === 'string' ? grounding : grounding.response
      if (typeof grounding !== 'string') {
        promptContext = grounding.modelInput
        screenshotDataUrl = grounding.screenshotDataUrl
        groundingDecision = grounding.decision
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'computer use step failed'
      if (error instanceof RecoverableVisionError) {
        deps.onObservation?.({
          step: modelStep,
          phase: 'checking',
          promptContext,
          screenshot: shot ?? { image: '', bounds: { width: 0, height: 0 } },
          retrievedFacts,
          durationMs: now() - startedAt,
          result: 'blocked',
          error: message
        })
        note(`rejected observation: ${message}`)
        progress('checking', modelStep, 'Refreshing the browser observation')
        checkpoint()
        continue
      }
      deps.onObservation?.({
        step: modelStep,
        phase: 'failed',
        promptContext,
        screenshot: shot ?? { image: '', bounds: { width: 0, height: 0 } },
        retrievedFacts,
        durationMs: now() - startedAt,
        result: 'error',
        error: message
      })
      throw error
    }
    const sourceBounds = shot.metadata?.geometry?.sourceBounds
    const decision =
      groundingDecision ??
      parseResponse(rawResponse, shot.bounds, {
        encoded: shot.bounds,
        source: sourceBounds
          ? { width: sourceBounds.width, height: sourceBounds.height }
          : shot.bounds
      })
    policyHistory.push({
      response: rawResponse,
      actionText: decision.actionText,
      ...(screenshotDataUrl ? { screenshotDataUrl } : {})
    })
    const imageHistory = policyHistory.filter((step) => step.screenshotDataUrl)
    const visualHistoryFrames = Math.max(0, Math.floor(deps.visualHistoryFrames ?? 2))
    const imagesToRemove = Math.max(0, imageHistory.length - visualHistoryFrames)
    for (const old of imageHistory.slice(0, imagesToRemove)) {
      delete old.screenshotDataUrl
    }
    if (decision.kind === 'invalid') {
      deps.onObservation?.({
        step: modelStep,
        phase: 'checking',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: decision.actionText || decision.error,
        decisionRationale: decision.decisionRationale,
        parsedAction: null,
        durationMs: now() - startedAt,
        result: 'parse_failed'
      })
      note(`${decision.error}; re-observing`)
      checkpoint()
      continue
    }
    if (decision.kind === 'wait') {
      progress('waiting', modelStep, `Waiting ${decision.durationMs} ms`)
      await new Promise((resolve) => setTimeout(resolve, decision.durationMs))
      deps.onObservation?.({
        step: modelStep,
        phase: 'waiting',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: decision.actionText || 'Wait before checking again',
        decisionRationale: decision.decisionRationale,
        durationMs: now() - startedAt,
        result: 'wait'
      })
      note(`wait ${decision.durationMs}ms`)
      checkpoint()
      continue
    }
    if (decision.kind === 'phase_complete') {
      const completed = deps.plan?.phases[phaseIndex]
      const hasNextPhase = Boolean(deps.plan && phaseIndex < deps.plan.phases.length - 1)
      note(`milestone complete: ${completed?.title ?? decision.summary}`)
      if (hasNextPhase) {
        phaseIndex += 1
        reportPhase(phaseIndex)
      }
      deps.onObservation?.({
        step: modelStep,
        phase: 'checking',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: decision.summary,
        decisionRationale: decision.decisionRationale,
        durationMs: now() - startedAt,
        result: 'terminal'
      })
      checkpoint()
      if (deps.plan && !hasNextPhase) {
        progress('complete', modelStep, decision.summary)
        return { ok: true, summary: decision.summary, steps, handoffs }
      }
      continue
    }
    if (decision.kind === 'rethink') {
      deps.onObservation?.({
        step: modelStep,
        phase: 'checking',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: decision.summary,
        decisionRationale: decision.decisionRationale,
        durationMs: now() - startedAt,
        result: 'blocked',
        error: decision.summary
      })
      note(`${decision.direction}: ${decision.summary}`)
      checkpoint()
      continue
    }
    if (decision.kind === 'done' || decision.kind === 'failed') {
      deps.onObservation?.({
        step: modelStep,
        phase: 'checking',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: decision.actionText || decision.summary,
        decisionRationale: decision.decisionRationale,
        durationMs: now() - startedAt,
        result: 'terminal'
      })
      note(`${decision.kind === 'done' ? 'done' : 'failed'}: ${decision.summary}`)
      checkpoint()
      return {
        ok: decision.kind === 'done',
        summary: decision.summary,
        steps,
        handoffs
      }
    }
    if (decision.kind === 'handoff') {
      progress('waiting', modelStep, 'Waiting for you to finish this step')
      deps.onObservation?.({
        step: modelStep,
        phase: 'waiting',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: decision.actionText || decision.reason,
        decisionRationale: decision.decisionRationale,
        durationMs: now() - startedAt,
        result: 'handoff'
      })
      handoffs += 1
      note(`handoff: ${decision.reason}`)
      checkpoint()
      await waitForUser(decision.reason)
      note('resumed by the user')
      continue
    }
    const mappedActions: VisionAction[] = []
    let actionIndex = 0
    let blocked = false
    let executionHandoff: string | undefined
    let executionRejection: string | undefined
    try {
      for (const [index, action] of decision.actions.entries()) {
        actionIndex = index
        // Re-check before EVERY action in a multi-action model response.
        if (!guard.canActuate()) {
          blocked = true
          break
        }
        // Typed content can contain passwords or private guidance. Keep the
        // live feed useful without echoing the value into UI or synced state.
        progress(
          'acting',
          modelStep,
          action.type === 'type'
            ? describeAction(action)
            : decision.actionText || describeAction(action)
        )
        const actuation = await screen.actuate(action, {
          decisionRationale: decision.decisionRationale
        })
        if (actuation?.handoff) {
          executionHandoff = actuation.handoff
          break
        }
        if (actuation?.rejected) {
          executionRejection = actuation.rejected
          note(`rejected action: ${actuation.rejected}`)
          break
        }
        guard.countStep()
        const verifiedAction = describeAction(action)
        note(verifiedAction)
        verifiedActions.push(verifiedAction)
        if (actuation?.mappedAction) mappedActions.push(actuation.mappedAction)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'computer use action failed'
      const failedAction = decision.actions[actionIndex]
      deps.onObservation?.({
        step: modelStep,
        phase: 'failed',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary:
          decision.actionText || (failedAction ? describeAction(failedAction) : 'Action failed'),
        decisionRationale: decision.decisionRationale,
        ...(failedAction ? { parsedAction: failedAction } : { parsedAction: null }),
        parsedActions: decision.actions,
        failedActionIndex: actionIndex,
        ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
        ...(mappedActions.length > 0 ? { mappedActions } : {}),
        durationMs: now() - startedAt,
        result: 'error',
        error: message
      })
      checkpoint()
      throw error
    }
    if (executionHandoff) {
      progress('waiting', modelStep, 'Waiting for you to finish this step')
      deps.onObservation?.({
        step: modelStep,
        phase: 'waiting',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: executionHandoff,
        decisionRationale: decision.decisionRationale,
        parsedAction: null,
        durationMs: now() - startedAt,
        result: 'handoff'
      })
      handoffs += 1
      note(`handoff: ${executionHandoff}`)
      checkpoint()
      await waitForUser(executionHandoff)
      note('resumed by the user')
      continue
    }
    if (executionRejection) {
      deps.onObservation?.({
        step: modelStep,
        phase: 'checking',
        promptContext,
        screenshot: shot,
        retrievedFacts,
        rawResponse,
        decisionSummary: executionRejection,
        decisionRationale: decision.decisionRationale,
        parsedAction: decision.actions[actionIndex] ?? null,
        parsedActions: decision.actions,
        durationMs: now() - startedAt,
        result: 'blocked',
        error: executionRejection
      })
      progress(
        'checking',
        modelStep,
        'Taking a fresh observation after the action was not executed'
      )
      checkpoint()
      continue
    }
    const blockedPhase: ComputerUsePhase = guard.isHalted ? 'stopped' : 'paused'
    deps.onObservation?.({
      step: modelStep,
      phase: blocked ? blockedPhase : 'checking',
      promptContext,
      screenshot: shot,
      retrievedFacts,
      rawResponse,
      decisionSummary:
        decision.actionText || decision.actions.map((action) => describeAction(action)).join('; '),
      decisionRationale: decision.decisionRationale,
      parsedAction: decision.actions[0],
      parsedActions: decision.actions,
      ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
      ...(mappedActions.length > 0 ? { mappedActions } : {}),
      durationMs: now() - startedAt,
      result: blocked ? 'blocked' : 'actuated'
    })
    progress(
      blocked ? blockedPhase : 'checking',
      modelStep,
      blocked ? 'Action paused' : 'Checking the result'
    )
    checkpoint()
  }
}
/* eslint-enable complexity */

function describeAction(action: VisionAction): string {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      return `${action.type} at (${action.point.x}, ${action.point.y})`
    case 'drag':
      return `drag (${action.from.x}, ${action.from.y}) -> (${action.to.x}, ${action.to.y})`
    case 'drag_to':
      return `drag to (${action.to.x}, ${action.to.y})`
    case 'mouse_move':
      return `move to (${action.point.x}, ${action.point.y})`
    case 'type':
      return 'type text'
    case 'hotkey':
      return `hotkey ${action.keys}`
    case 'press':
    case 'key_down':
    case 'key_up':
      return `${action.type} ${action.keys.join(' ')}`
    case 'scroll':
      return `scroll ${action.direction} at (${action.point.x}, ${action.point.y})`
    case 'scroll_by':
      return `scroll ${action.axis} by ${action.amount}`
    case 'wait':
      return `wait ${action.durationMs ?? 0}ms`
    default:
      return action.type
  }
}
