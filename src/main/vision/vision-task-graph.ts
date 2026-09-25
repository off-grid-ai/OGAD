import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import {
  computerUseHistoryTokenBudget,
  tailWithinTokenBudget
} from '../../shared/computer-use-settings'
import {
  DEFAULT_COMPUTER_USE_STEP_BUDGET,
  MAX_COMPUTER_USE_REASONING_CHARS
} from '../../shared/computer-use-limits'
import { CurrentTaskBrief } from '../tasks/current-task-brief'
import {
  createTaskPhaseReporter,
  formatTaskExecutionPlanContext
} from '../tasks/task-execution-plan-service'
import { taskExecutionPlanProgress, type TaskExecutionPlan } from '../../shared/task-execution-plan'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../tasks/task-guide'
import type { ComputerUsePhase } from '../tasks/task-step-details'
import type { VisionAction } from './vision-action'
import {
  RecoverableVisionError,
  type VisionActionEffect,
  type VisionGroundingInput,
  type VisionGroundingResult,
  type VisionScreen,
  type VisionStepObservation,
  type VisionTaskDeps,
  type VisionTaskResult
} from './vision-agent'
import type {
  VisionContinuationCapsule,
  VisionPolicyDecision,
  VisionPolicyHistoryStep
} from './model-adapters/types'
import {
  boundedContinuationCapsule,
  continuationFromTaskSteps
} from './model-adapters/continuation-capsule'
import { uiTarsAdapter } from './model-adapters/ui-tars'

type WorkflowRoute =
  | 'gate'
  | 'pause'
  | 'capture'
  | 'decide'
  | 'advance'
  | 'handle_decision'
  | 'execute'
  | 'end'

const WorkflowState = Annotation.Root({
  route: Annotation<WorkflowRoute>()
})

export interface VisionTaskGraphDeps extends Omit<VisionTaskDeps, 'ground'> {
  decide: (input: VisionGroundingInput) => Promise<VisionGroundingResult>
}

interface CapturedStep {
  shot: Awaited<ReturnType<VisionScreen['capture']>>
  startedAt: number
  /** How long the screen capture itself took, measured around the capture call. */
  captureMs: number
  /** How long the model call took. Filled in by the decide node, which runs after capture. */
  decisionMs?: number
  guidance: readonly string[]
  history: string[]
  promptContext: string
  currentMilestone?: string
  evidence: ScreenEvidence
}

const MAX_CONSECUTIVE_RETHINKS = 3
const VISUAL_FINGERPRINT_SIZE = 128
const VISUAL_NOOP_MEAN_DELTA = 0.002
const VISUAL_CONFIRMED_MEAN_DELTA = 0.01
const VISUAL_TILE_SIZE = 8
const VISUAL_LOCAL_CONFIRMED_MEAN_DELTA = 0.05
const VISUAL_LOCAL_STRONG_PIXEL_DELTA = 32
const VISUAL_LOCAL_STRONG_PIXEL_COUNT = 6

interface ScreenEvidence {
  visual?: Buffer
  semantic?: string
}

async function screenEvidence(
  shot: Awaited<ReturnType<VisionScreen['capture']>>
): Promise<ScreenEvidence> {
  let visual: Buffer | undefined
  try {
    const source = shot.image.startsWith('data:')
      ? Buffer.from(shot.image.slice(shot.image.indexOf(',') + 1), 'base64')
      : await fs.readFile(shot.image)
    visual = await sharp(source)
      .resize(VISUAL_FINGERPRINT_SIZE, VISUAL_FINGERPRINT_SIZE, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer()
  } catch {
    // A missing comparison signal must remain unverifiable, never successful.
  }
  const elements = shot.metadata?.verificationSemanticElements ?? shot.metadata?.semanticElements
  const semantic = elements
    ? JSON.stringify(
        elements
          .map((element) => [element.role, element.name, element.value])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      )
    : undefined
  return { visual, semantic }
}

interface ActionEffectMeasurement {
  effect: VisionActionEffect
  semanticComparable: boolean
  semanticChanged: boolean
  visualComparable: boolean
  globalMeanDelta?: number
  localMeanDelta?: number
  localStrongPixels?: number
}

function actionEffect(
  before: ScreenEvidence,
  after: ScreenEvidence,
  previousAction?: {
    action: VisionAction
    coordinateFrame: ReturnType<typeof coordinateFrame>
  }
): ActionEffectMeasurement {
  const semanticComparable = before.semantic !== undefined && after.semantic !== undefined
  const semanticChanged = semanticComparable && before.semantic !== after.semantic
  if (semanticChanged) {
    return { effect: 'confirmed', semanticComparable, semanticChanged, visualComparable: false }
  }
  if (!before.visual || !after.visual || before.visual.length !== after.visual.length) {
    return {
      effect: 'unverifiable',
      semanticComparable,
      semanticChanged,
      visualComparable: false
    }
  }
  let delta = 0
  for (let index = 0; index < before.visual.length; index += 1) {
    delta += Math.abs(before.visual[index]! - after.visual[index]!)
  }
  const meanDelta = delta / (before.visual.length * 255)
  const local = localVisualChange(before.visual, after.visual, previousAction)
  const visualConfirmed =
    meanDelta >= VISUAL_CONFIRMED_MEAN_DELTA ||
    (local !== undefined &&
      local.meanDelta >= VISUAL_LOCAL_CONFIRMED_MEAN_DELTA &&
      local.strongPixels >= VISUAL_LOCAL_STRONG_PIXEL_COUNT)
  const visuallyUnchanged = meanDelta <= VISUAL_NOOP_MEAN_DELTA
  return {
    effect: visualConfirmed
      ? 'confirmed'
      : visuallyUnchanged && semanticComparable
        ? 'suspected_noop'
        : 'unverifiable',
    semanticComparable,
    semanticChanged,
    visualComparable: true,
    globalMeanDelta: meanDelta,
    ...(local ? { localMeanDelta: local.meanDelta, localStrongPixels: local.strongPixels } : {})
  }
}

function localVisualChange(
  before: Buffer,
  after: Buffer,
  previousAction:
    | { action: VisionAction; coordinateFrame: ReturnType<typeof coordinateFrame> }
    | undefined
): { meanDelta: number; strongPixels: number } | undefined {
  const point = verificationPoint(previousAction?.action)
  const bounds = previousAction?.coordinateFrame.encoded
  if (!point || !bounds || bounds.width <= 0 || bounds.height <= 0) return undefined
  const pixelX = Math.min(
    VISUAL_FINGERPRINT_SIZE - 1,
    Math.max(0, Math.floor((point.x * VISUAL_FINGERPRINT_SIZE) / bounds.width))
  )
  const pixelY = Math.min(
    VISUAL_FINGERPRINT_SIZE - 1,
    Math.max(0, Math.floor((point.y * VISUAL_FINGERPRINT_SIZE) / bounds.height))
  )
  const tileX = Math.floor(pixelX / VISUAL_TILE_SIZE)
  const tileY = Math.floor(pixelY / VISUAL_TILE_SIZE)
  let strongest = { meanDelta: 0, strongPixels: 0 }
  for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      const xStart = (tileX + xOffset) * VISUAL_TILE_SIZE
      const yStart = (tileY + yOffset) * VISUAL_TILE_SIZE
      if (
        xStart < 0 ||
        yStart < 0 ||
        xStart >= VISUAL_FINGERPRINT_SIZE ||
        yStart >= VISUAL_FINGERPRINT_SIZE
      ) {
        continue
      }
      let delta = 0
      let strongPixels = 0
      for (let y = yStart; y < yStart + VISUAL_TILE_SIZE; y += 1) {
        for (let x = xStart; x < xStart + VISUAL_TILE_SIZE; x += 1) {
          const index = y * VISUAL_FINGERPRINT_SIZE + x
          const pixelDelta = Math.abs(before[index]! - after[index]!)
          delta += pixelDelta
          if (pixelDelta >= VISUAL_LOCAL_STRONG_PIXEL_DELTA) strongPixels += 1
        }
      }
      const meanDelta = delta / (VISUAL_TILE_SIZE * VISUAL_TILE_SIZE * 255)
      if (meanDelta > strongest.meanDelta) strongest = { meanDelta, strongPixels }
    }
  }
  return strongest
}

function verificationPoint(action: VisionAction | undefined): { x: number; y: number } | undefined {
  switch (action?.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      return action.point
    default:
      return undefined
  }
}

/**
 * One local LangGraph workflow for the screenshot-first operator pipeline.
 * Binary screenshots and live Electron objects stay at injected boundaries;
 * SQLite task history remains the durable source of truth.
 */
export async function runVisionTaskGraph(
  goal: string,
  deps: VisionTaskGraphDeps
): Promise<VisionTaskResult> {
  const runtime = new VisionTaskGraphRuntime(goal, deps)
  const graph = new StateGraph(WorkflowState)
    .addNode('gate', () => runtime.gate())
    .addNode('pause', () => runtime.pause())
    .addNode('capture', () => runtime.capture())
    .addNode('decide', () => runtime.decide())
    .addNode('advance', () => runtime.advanceMilestone())
    .addNode('handle_decision', () => runtime.handleDecision())
    .addNode('execute', () => runtime.execute())
    .addEdge(START, 'gate')
    .addConditionalEdges('gate', route, {
      pause: 'pause',
      capture: 'capture',
      end: END
    })
    .addEdge('pause', 'gate')
    .addConditionalEdges('capture', route, {
      decide: 'decide',
      gate: 'gate',
      end: END
    })
    .addEdge('decide', 'handle_decision')
    .addConditionalEdges('advance', route, { gate: 'gate', end: END })
    .addConditionalEdges('handle_decision', route, {
      pause: 'pause',
      execute: 'execute',
      advance: 'advance',
      gate: 'gate',
      end: END
    })
    .addConditionalEdges('execute', route, { gate: 'gate', end: END })
    .compile()

  runtime.start()
  try {
    await graph.invoke(
      { route: 'gate' },
      { recursionLimit: runtime.maxPlanningSteps * 12 + 20, signal: deps.signal }
    )
  } catch (error) {
    if (!deps.signal?.aborted) throw error
    runtime.stopAfterAbort()
  }
  return runtime.result()
}

function route(state: typeof WorkflowState.State): WorkflowRoute {
  return state.route
}

function waitForDelay(durationMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Which plan phase a resumed run should start on.
 *
 * Delegates to the shared progress rule rather than re-deriving one here, so the runtime and the
 * task UI cannot disagree about the active phase. A fresh run (no resumed trace) starts at 0.
 */
function resumedPhaseIndex(
  plan: TaskExecutionPlan | undefined,
  resumedSteps: readonly string[] | undefined
): number {
  if (!plan?.phases.length || !resumedSteps?.length) return 0
  const progress = taskExecutionPlanProgress(resumedSteps)
  if (!progress) return 0
  return Math.max(0, Math.min(progress.activePhaseIndex, plan.phases.length - 1))
}

class VisionTaskGraphRuntime {
  readonly maxPlanningSteps: number
  private readonly now: () => number
  private readonly taskBrief: CurrentTaskBrief
  private readonly retrievedFacts: string[]
  private readonly parseResponse: NonNullable<VisionTaskDeps['parseResponse']>
  private readonly reportPhase: (phaseIndex: number) => void
  private readonly basePlanContext: string
  private readonly checkpointInterval: number
  private readonly visualHistoryFrames: number
  private readonly steps: string[] = []
  private readonly policyHistory: VisionPolicyHistoryStep[] = []
  private readonly verifiedActions: string[] = []
  private continuation?: VisionContinuationCapsule
  private previousVerifiedAction?: {
    action: VisionAction
    coordinateFrame: ReturnType<typeof coordinateFrame>
  }
  private equivalentClickRecoveries = 0
  private duplicateTypeRecoveries = 0
  private consecutiveRethinks = 0
  private consecutiveSuspectedNoops = 0
  private previousActionEffect?: VisionActionEffect
  private previousExpectedEffect?: string
  private pendingActionVerification = false
  private pendingActionEvidence?: ScreenEvidence
  private pendingExpectedEffect?: string
  private consecutiveCaptureFailures = 0
  private mustRethink = false
  private handoffs = 0
  private modelStep = 0
  private sessionCycle = 1
  /**
   * The plan phase this run is working on.
   *
   * Seeded from the resumed trace, NOT always 0. A retry constructs a fresh runtime, so starting at
   * 0 made it re-announce phase 1 and redo the first milestone while the trace claimed "Resumed
   * from the failed checkpoint" — then fail at the same later phase and loop. Observed on a real
   * run: milestone 1 completed and phase 2 entered three times over 66 steps.
   *
   * taskExecutionPlanProgress is the same rule the task UI uses to decide the active phase, so
   * "which phase are we in" has one answer rather than one per layer.
   */
  private phaseIndex: number
  private captured?: CapturedStep
  private decision?: VisionPolicyDecision
  private actionResponse?: string
  private actionModelInput?: string
  private pendingPolicyHistory?: VisionPolicyHistoryStep
  private currentReasoning = ''
  private finalResult?: VisionTaskResult

  constructor(
    goal: string,
    private readonly deps: VisionTaskGraphDeps
  ) {
    this.now = deps.now ?? Date.now
    this.taskBrief = new CurrentTaskBrief(goal)
    this.retrievedFacts = deps.retrievedFacts ?? []
    this.parseResponse = deps.parseResponse ?? uiTarsAdapter.parseResponse
    this.phaseIndex = resumedPhaseIndex(deps.plan, deps.resumedSteps)
    this.reportPhase = createTaskPhaseReporter(deps.plan, deps.onPhase)
    this.basePlanContext = [
      deps.plan ? formatTaskExecutionPlanContext(deps.plan) : '',
      deps.repeatUntilSessionLimit
        ? 'Timed session mode: repeat this plan until the external session deadline ends the run. Completing the final milestone completes one activity cycle, not the full task. For each new cycle, choose a different approved search term and a different relevant item. Do not repeat an earlier engagement.'
        : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    this.checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
    this.visualHistoryFrames = Math.max(0, Math.floor(deps.visualHistoryFrames ?? 2))
    this.continuation = continuationFromTaskSteps(
      deps.resumedSteps ?? [],
      this.visualHistoryFrames,
      deps.plan?.phases[this.phaseIndex]?.title ?? 'Choose the next safe action'
    )
    this.maxPlanningSteps = Math.max(
      1,
      Math.floor(deps.maxPlanningSteps ?? DEFAULT_COMPUTER_USE_STEP_BUDGET)
    )
  }

  start(): void {
    this.reportPhase(this.phaseIndex)
  }

  stopAfterAbort(): void {
    if (this.finalResult) return
    const summary = this.deps.guard.snapshot().reason || 'Stopped'
    if (this.deps.guard.automationStatus === 'completed') {
      this.progress('complete', summary)
      this.note(`done: ${summary}`)
      this.finish(true, summary)
      return
    }
    this.progress('stopped', summary)
    this.note(`stopped: ${summary}`)
    this.finish(false, summary)
  }

  result(): VisionTaskResult {
    return (
      this.finalResult ?? {
        ok: false,
        summary: 'The visual workflow ended without a final result.',
        steps: [...this.steps],
        handoffs: this.handoffs
      }
    )
  }

  gate(): { route: WorkflowRoute } {
    if (this.finalResult) return { route: 'end' }
    if (this.modelStep >= this.maxPlanningSteps) {
      const summary = `Computer use stopped after ${this.maxPlanningSteps} planning steps.`
      this.progress('failed', 'Reached the planning-step limit')
      this.note(summary)
      this.finish(false, summary)
      return { route: 'end' }
    }
    if (this.deps.guard.canCapture) return { route: 'capture' }
    const snapshot = this.deps.guard.snapshot()
    if (this.deps.guard.isPaused) return { route: 'pause' }
    const summary = snapshot.reason || 'Stopped'
    this.progress('stopped', summary)
    this.note(`stopped: ${summary}`)
    this.finish(false, summary)
    return { route: 'end' }
  }

  async pause(): Promise<{ route: WorkflowRoute }> {
    const reason = this.deps.guard.snapshot().reason || 'Waiting for you'
    this.progress('paused', reason)
    this.note(`paused: ${reason}`)
    await this.deps.guard.waitUntilRunnable(this.deps.signal)
    if (!this.deps.guard.isHalted) this.note('resumed by the user')
    return { route: 'gate' }
  }

  async capture(): Promise<{ route: WorkflowRoute }> {
    this.modelStep += 1
    this.progress('observing', 'Reading the current screen')
    const startedAt = this.now()
    this.taskBrief.accept(this.deps.takeGuidance?.() ?? [])
    const guidance = [...this.taskBrief.guidance]
    const currentPhase = this.deps.plan?.phases[this.phaseIndex]
    const planContext = [
      this.basePlanContext,
      currentPhase
        ? `Current milestone: ${currentPhase.title}\nInterpret this milestone against the current Task brief above. Mark it complete only after its result is visible.`
        : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    const history = tailWithinTokenBudget(
      planContext ? [planContext, ...this.steps] : this.steps,
      computerUseHistoryTokenBudget(this.deps.contextTokens ?? 2_048)
    )
    const durableObjective = this.taskBrief.guidance.reduce(
      (safeObjective, privateText) =>
        safeObjective.split(privateText).join(TASK_GUIDANCE_APPLIED_TRACE),
      this.taskBrief.objective
    )
    const promptContext = [
      `Task: ${durableObjective}`,
      this.retrievedFacts.length ? `Past task facts:\n${this.retrievedFacts.join('\n')}` : '',
      history.length ? `Current task history:\n${history.join('\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')
    try {
      const shot = await this.deps.screen.capture()
      this.consecutiveCaptureFailures = 0
      const evidence = await screenEvidence(shot)
      if (this.pendingActionEvidence) {
        const measurement = actionEffect(
          this.pendingActionEvidence,
          evidence,
          this.previousVerifiedAction
        )
        this.previousActionEffect = measurement.effect
        this.previousExpectedEffect = this.pendingExpectedEffect
        const trajectoryStep = this.policyHistory.at(-1)
        if (trajectoryStep) {
          trajectoryStep.result = this.previousExpectedEffect
            ? `Fresh observation captured. Expected state: ${this.previousExpectedEffect}. Mechanical change check: ${measurement.effect}. The model must verify whether the expected state is visible; unrelated change is inconclusive.`
            : `Fresh observation captured. Mechanical change check: ${measurement.effect}.`
        }
        this.note(`action effect: ${this.previousActionEffect}`)
        console.log('[vision][verification] action effect', {
          action: this.previousVerifiedAction?.action.type,
          ...measurement
        })
        this.pendingActionEvidence = undefined
        this.pendingExpectedEffect = undefined
        if (this.previousActionEffect === 'suspected_noop') {
          this.consecutiveSuspectedNoops += 1
          if (this.consecutiveSuspectedNoops >= 2) {
            this.mustRethink = true
            this.consecutiveSuspectedNoops = 0
            this.note('two consecutive actions had no observable effect; forcing a rethink')
          }
        } else {
          this.consecutiveSuspectedNoops = 0
        }
      }
      this.captured = {
        shot,
        startedAt,
        captureMs: this.now() - startedAt,
        guidance,
        history,
        promptContext,
        currentMilestone: currentPhase?.title,
        evidence
      }
      if (!this.deps.guard.markObservationReady()) return { route: 'gate' }
      this.decision = undefined
      this.actionResponse = undefined
      this.actionModelInput = undefined
      return { route: 'decide' }
    } catch (error) {
      const message = errorMessage(error, 'computer use capture failed')
      this.observe({
        phase: error instanceof RecoverableVisionError ? 'checking' : 'failed',
        promptContext,
        screenshot: { image: '', bounds: { width: 0, height: 0 } },
        durationMs: this.now() - startedAt,
        result: error instanceof RecoverableVisionError ? 'blocked' : 'error',
        error: message
      })
      if (error instanceof RecoverableVisionError) {
        this.consecutiveCaptureFailures += 1
        this.note(`rejected observation: ${message}`)
        if (this.consecutiveCaptureFailures >= MAX_CONSECUTIVE_RETHINKS) {
          const failure = `Computer use could not refresh the target after ${MAX_CONSECUTIVE_RETHINKS} attempts: ${message}`
          this.progress('failed', failure)
          this.finish(false, failure)
          return { route: 'end' }
        }
        this.progress('checking', 'Refreshing the browser observation')
        this.checkpoint()
        return { route: 'gate' }
      }
      this.note(`visual capture failed: ${message}`)
      this.finish(false, message)
      return { route: 'end' }
    }
  }

  async decide(): Promise<{ route: WorkflowRoute }> {
    const captured = this.requireCaptured()
    this.progress('thinking', 'Reviewing direction, milestone, and next action')
    if (this.mustRethink) {
      this.mustRethink = false
      this.decision = {
        kind: 'rethink',
        actionText: 'Reassess the current screen',
        summary: 'Two consecutive actions produced no observable screen or Accessibility change.',
        direction: 'off_course',
        decisionRationale: 'The action-effect check requires a different strategy.'
      }
      return { route: 'handle_decision' }
    }
    this.beginReasoning()
    const modelLease = this.deps.guard.currentActionLease()
    const modelSignal = this.deps.signal
      ? AbortSignal.any([this.deps.signal, modelLease.signal])
      : modelLease.signal
    try {
      const decisionStartedAt = this.now()
      const grounding = await this.deps.decide(this.groundingInput(captured, modelSignal))
      if (!this.deps.guard.ownsActionLease(modelLease.epoch)) {
        this.discardPendingPolicyHistory()
        if (this.deps.guard.isHalted) this.stopAfterAbort()
        return { route: this.deps.guard.isHalted ? 'end' : 'pause' }
      }
      captured.decisionMs = this.now() - decisionStartedAt
      this.actionResponse = grounding.response
      this.actionModelInput = grounding.modelInput
      console.log(
        `[computer-task] inference=${this.previousActionEffect ? 'task-verification' : 'task-action'} durationMs=${captured.decisionMs} inputChars=${grounding.modelInput.length} accessibilityElements=${captured.shot.metadata?.semanticElements?.length ?? 0}`
      )
      this.decision =
        grounding.decision ??
        this.parseResponse(grounding.response, captured.shot.bounds, coordinateFrame(captured.shot))
      this.pendingPolicyHistory = {
        response: grounding.response,
        actionText: this.decision.actionText,
        ...(this.currentReasoning ? { reasoning: this.currentReasoning } : {}),
        ...(grounding.screenshotDataUrl ? { screenshotDataUrl: grounding.screenshotDataUrl } : {})
      }
      return { route: 'handle_decision' }
    } catch (error) {
      if (this.deps.signal?.aborted) {
        this.stopAfterAbort()
        return { route: 'handle_decision' }
      }
      if (modelLease.signal.aborted) {
        this.discardPendingPolicyHistory()
        if (this.deps.guard.isHalted) this.stopAfterAbort()
        return { route: this.deps.guard.isHalted ? 'end' : 'pause' }
      }
      const message = errorMessage(error, 'visual decision failed')
      this.observe({
        phase: 'failed',
        promptContext: this.actionModelInput ?? captured.promptContext,
        screenshot: captured.shot,
        rawResponse: this.actionResponse,
        reasoning: this.currentReasoning,
        durationMs: this.now() - captured.startedAt,
        timings: {
          captureMs: captured.captureMs,
          ...(captured.decisionMs === undefined ? {} : { decisionMs: captured.decisionMs })
        },
        result: 'error',
        error: message
      })
      this.note(`visual decision failed: ${message}`)
      this.finish(false, `Visual decision failed: ${message}`)
      return { route: 'handle_decision' }
    } finally {
      this.endReasoning()
    }
  }

  advanceMilestone(): { route: WorkflowRoute } {
    if (this.decision?.kind !== 'phase_complete' && this.decision?.kind !== 'done') {
      this.finish(false, 'Only the milestone judge can advance the execution plan.')
      return { route: 'end' }
    }
    const hasNextPhase = Boolean(
      this.deps.plan && this.phaseIndex < this.deps.plan.phases.length - 1
    )
    if (!hasNextPhase) {
      if (this.deps.repeatUntilSessionLimit && !this.deps.guard.isHalted) {
        const completed = this.deps.plan?.phases[this.phaseIndex]
        this.note(`cycle ${this.sessionCycle} complete: ${completed?.title ?? this.decision.summary}`)
        this.sessionCycle += 1
        this.policyHistory.length = 0
        this.pendingPolicyHistory = undefined
        this.phaseIndex = 0
        const next = this.deps.plan?.phases[0]
        this.continuation = boundedContinuationCapsule(
          {
            done: [`Activity cycle ${this.sessionCycle - 1} completed`],
            next: next?.title ?? 'Start the next activity cycle',
            remember: `Start activity cycle ${this.sessionCycle}. Use a different approved search term and a different relevant item. Do not repeat an earlier engagement.`
          },
          this.visualHistoryFrames
        )
        this.reportPhase(this.phaseIndex)
        this.progress('checking', `Starting activity cycle ${this.sessionCycle}`)
        return { route: 'gate' }
      }
      if (!this.deps.guard.isVerifying) {
        this.deps.guard.beginVerification()
        this.progress('checking', 'Verifying the result on a fresh screen')
        return { route: 'gate' }
      }
      const completed = this.deps.plan?.phases[this.phaseIndex]
      this.note(`milestone complete: ${completed?.title ?? this.decision.summary}`)
      this.progress('complete', this.decision.summary)
      this.finish(true, this.decision.summary)
      return { route: 'end' }
    }
    const completed = this.deps.plan?.phases[this.phaseIndex]
    this.note(`milestone complete: ${completed?.title ?? this.decision.summary}`)
    // A model trajectory belongs to one milestone. Do not let actions from a
    // completed milestone bias the first decision for the next milestone.
    this.policyHistory.length = 0
    this.pendingPolicyHistory = undefined
    this.phaseIndex += 1
    const next = this.deps.plan?.phases[this.phaseIndex]
    this.continuation = boundedContinuationCapsule(
      {
        done: [completed?.title ?? this.decision.summary],
        next: next?.title ?? 'Continue with the next milestone',
        remember: this.continuation?.remember ?? ''
      },
      this.visualHistoryFrames
    )
    this.reportPhase(this.phaseIndex)
    return { route: 'gate' }
  }

  async handleDecision(): Promise<{ route: WorkflowRoute }> {
    if (this.finalResult) return { route: 'end' }
    // Take Over can arrive while the model request is in flight. Discard that
    // now-stale reply and park before it can act or finish the task. Continue
    // returns through the gate and captures the user's current screen.
    if (this.deps.guard.isPaused) {
      this.discardPendingPolicyHistory()
      return { route: 'pause' }
    }
    const decision = this.decision
    if (!decision) {
      this.finish(false, 'The action model returned no decision.')
      return { route: 'end' }
    }
    if (decision.kind === 'actions' || decision.kind === 'phase_complete') {
      this.updateContinuation(decision)
    }
    if (this.pendingActionVerification) {
      if (decision.kind === 'phase_complete') {
        const trajectoryStep = this.policyHistory.at(-1)
        if (trajectoryStep) {
          trajectoryStep.result = `Verified from the fresh screen: ${decision.summary}`
        }
        this.note(`action verified: ${decision.summary}`)
        this.pendingActionVerification = false
        this.previousActionEffect = 'confirmed'
      } else if (decision.kind === 'action_verified') {
        const trajectoryStep = this.policyHistory.at(-1)
        if (trajectoryStep) {
          trajectoryStep.result = `Verified from the fresh screen: ${decision.summary}`
        }
        this.note(`action verified: ${decision.summary}`)
        this.pendingActionVerification = false
        this.previousActionEffect = 'confirmed'
        this.discardPendingPolicyHistory()
        this.observeDecision('reviewed')
        this.progress('checking', 'Previous action verified; choosing the next task action')
        this.checkpoint()
        return { route: 'gate' }
      } else if (decision.kind === 'action_rejected') {
        const trajectoryStep = this.policyHistory.at(-1)
        if (trajectoryStep) {
          trajectoryStep.result = `Rejected from the fresh screen: ${decision.summary}`
        }
        this.note(`action not verified: ${decision.summary}`)
        this.pendingActionVerification = false
        this.previousActionEffect = 'suspected_noop'
        this.discardPendingPolicyHistory()
        this.observeDecision('blocked', decision.summary)
        this.progress('checking', 'Recovering from an unverified action')
        this.checkpoint()
        return { route: 'gate' }
      } else {
        this.discardPendingPolicyHistory()
        const failure =
          'The verification turn attempted a new action before resolving the previous action.'
        this.note(failure)
        this.finish(false, failure)
        return { route: 'end' }
      }
    }
    if (decision.kind === 'actions') {
      this.consecutiveRethinks = 0
      const repeatedType = decision.actions.find((action) =>
        isRepeatedTypeAction(action, this.previousVerifiedAction)
      )
      if (repeatedType) {
        this.duplicateTypeRecoveries += 1
        const summary = 'Repeated text input blocked because the same text was already typed.'
        this.discardPendingPolicyHistory()
        this.observeDecision('blocked', summary)
        this.note(summary)
        this.checkpoint()
        this.progress('checking', 'Taking a fresh observation and choosing a different action')
        return { route: 'gate' }
      }
      const repeatedClick =
        this.previousActionEffect === 'confirmed'
          ? undefined
          : decision.actions.find((action) =>
              isEquivalentClickTarget(
                action,
                coordinateFrame(this.requireCaptured().shot),
                this.previousVerifiedAction
              )
            )
      if (repeatedClick) {
        this.equivalentClickRecoveries += 1
        const summary = `Repeated click region blocked at (${repeatedClick.point.x}, ${repeatedClick.point.y}). The previous click marker shows where the earlier attempt landed.`
        const recovery =
          'Do not target the same region again. Prefer the exact supplied accessibility control. If no exact control is available, change the visible state before asking the grounding specialist for a new coordinate.'
        this.discardPendingPolicyHistory()
        this.observeDecision('blocked', summary)
        this.note(summary)
        this.note(recovery)
        this.checkpoint()
        if (this.equivalentClickRecoveries > 1) {
          const failure =
            'Computer use could not focus the intended control after a fresh observation. Use Take Over to complete this step.'
          this.progress('failed', 'The same click region did not accept focus')
          this.note(failure)
          this.finish(false, failure)
          return { route: 'end' }
        }
        this.progress('checking', 'Taking a fresh observation and changing the input strategy')
        return { route: 'gate' }
      }
      this.observeDecision('reviewed')
      this.note(`action approved: ${decision.actionText}`)
      this.checkpoint()
      return { route: 'execute' }
    }
    if (decision.kind === 'phase_complete') {
      this.consecutiveRethinks = 0
      this.discardPendingPolicyHistory()
      this.observeDecision('terminal')
      this.checkpoint()
      return { route: 'advance' }
    }
    if (decision.kind === 'rethink') {
      this.consecutiveRethinks += 1
      this.discardPendingPolicyHistory()
      this.observeDecision('blocked', decision.summary)
      this.note(`${decision.direction}: ${decision.summary}`)
      if (
        this.consecutiveRethinks >= MAX_CONSECUTIVE_RETHINKS &&
        !this.deps.repeatUntilSessionLimit
      ) {
        const failure = `Computer use could not make progress after ${MAX_CONSECUTIVE_RETHINKS} fresh observations: ${decision.summary}`
        this.progress('failed', 'The visual strategy did not make progress')
        this.note(failure)
        this.checkpoint()
        this.finish(false, failure)
        return { route: 'end' }
      }
      if (this.consecutiveRethinks >= MAX_CONSECUTIVE_RETHINKS) {
        this.note('Timed session recovery continues until the session deadline.')
        this.consecutiveRethinks = 0
      }
      this.progress('checking', 'Taking a fresh observation after rethinking the action')
      this.checkpoint()
      return { route: 'gate' }
    }
    if (decision.kind === 'invalid') {
      this.discardPendingPolicyHistory()
      this.observeDecision('parse_failed', decision.error)
      this.note(`${decision.error}; re-observing`)
      this.checkpoint()
      return { route: 'gate' }
    }
    if (decision.kind === 'wait') {
      this.discardPendingPolicyHistory()
      this.progress('waiting', `Waiting ${decision.durationMs} ms`)
      await waitForDelay(decision.durationMs, this.deps.signal)
      this.observeDecision('wait')
      this.note(`wait ${decision.durationMs}ms`)
      this.checkpoint()
      return { route: 'gate' }
    }
    if (decision.kind === 'done' && !this.deps.plan?.phases.length) {
      this.discardPendingPolicyHistory()
      this.observeDecision('terminal')
      this.checkpoint()
      if (!this.deps.guard.isVerifying) {
        this.deps.guard.beginVerification()
        this.progress('checking', 'Verifying the result on a fresh screen')
        return { route: 'gate' }
      }
      this.note(`done: ${decision.summary}`)
      this.finish(true, decision.summary)
      return { route: 'end' }
    }
    if (decision.kind === 'handoff') {
      if (this.deps.returnAfterAction) {
        const summary =
          'Recovery did not find an executable action. No structurally verified user-only input is required.'
        this.discardPendingPolicyHistory()
        this.observeDecision('blocked', summary)
        this.note(`handoff rejected: ${summary}`)
        this.checkpoint()
        this.finish(false, summary)
        return { route: 'end' }
      }
      this.discardPendingPolicyHistory()
      this.progress('waiting', 'Waiting for you to finish this step')
      this.observeDecision('handoff')
      this.handoffs += 1
      this.note(`handoff: ${decision.reason}`)
      this.checkpoint()
      await this.deps.waitForUser(decision.reason, this.deps.signal)
      if (!this.deps.guard.isHalted) this.note('resumed by the user')
      return { route: 'gate' }
    }
    if (decision.kind === 'done' && this.deps.plan?.phases.length) {
      // The execution plan is the task lifecycle SSOT. A model-level `done`
      // verdict is stronger than completion of the current milestone, but it
      // must not skip the remaining visible checks or release the specialist.
      // Advance one milestone and let the next screenshot verify the next one.
      this.discardPendingPolicyHistory()
      this.observeDecision('terminal')
      this.checkpoint()
      return { route: 'advance' }
    }
    this.discardPendingPolicyHistory()
    this.observeDecision('terminal')
    this.note(`${decision.kind}: ${decision.summary}`)
    this.checkpoint()
    this.finish(decision.kind === 'done', decision.summary)
    return { route: 'end' }
  }

  async execute(): Promise<{ route: WorkflowRoute }> {
    const captured = this.requireCaptured()
    const decision = this.decision
    if (decision?.kind !== 'actions') {
      this.finish(false, 'The visual workflow reached execution without an action.')
      return { route: 'end' }
    }
    const mappedActions: VisionAction[] = []
    let actionIndex = 0
    let blocked = false
    let executionHandoff: string | undefined
    let executionRejection: string | undefined
    try {
      for (const [index, action] of decision.actions.entries()) {
        actionIndex = index
        if (!this.deps.guard.canActuate()) {
          blocked = true
          break
        }
        this.progress(
          'acting',
          action.type === 'type'
            ? describeAction(action)
            : decision.actionText || describeAction(action)
        )
        const actuation = await this.deps.screen.actuate(action, {
          decisionRationale: decision.decisionRationale
        })
        if (actuation?.handoff) {
          executionHandoff = actuation.handoff
          break
        }
        if (actuation?.rejected) {
          executionRejection = actuation.rejected
          this.note(`rejected action: ${actuation.rejected}`)
          break
        }
        this.deps.guard.countStep()
        const verified = describeAction(action)
        this.note(verified)
        this.verifiedActions.push(verified)
        this.previousVerifiedAction = {
          action,
          coordinateFrame: coordinateFrame(captured.shot)
        }
        this.equivalentClickRecoveries = 0
        this.duplicateTypeRecoveries = 0
        if (actuation?.mappedAction) mappedActions.push(actuation.mappedAction)
      }
    } catch (error) {
      this.discardPendingPolicyHistory()
      if (this.deps.signal?.aborted) {
        this.stopAfterAbort()
        return { route: 'end' }
      }
      const message = errorMessage(error, 'computer use action failed')
      const failedAction = decision.actions[actionIndex]
      this.observe({
        phase: 'failed',
        promptContext: this.actionModelInput ?? captured.promptContext,
        screenshot: captured.shot,
        rawResponse: this.actionResponse,
        reasoning: this.currentReasoning,
        decisionSummary:
          decision.actionText || (failedAction ? describeAction(failedAction) : 'Action failed'),
        decisionRationale: decision.decisionRationale,
        parsedAction: failedAction ?? null,
        parsedActions: decision.actions,
        failedActionIndex: actionIndex,
        ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
        ...(mappedActions.length ? { mappedActions } : {}),
        durationMs: this.now() - captured.startedAt,
        timings: {
          captureMs: captured.captureMs,
          ...(captured.decisionMs === undefined ? {} : { decisionMs: captured.decisionMs })
        },
        result: 'error',
        error: message
      })
      this.checkpoint()
      this.finish(false, message)
      return { route: 'end' }
    }
    if (executionHandoff) {
      this.discardPendingPolicyHistory()
      this.progress('waiting', 'Waiting for you to finish this step')
      this.observeDecision('handoff', executionHandoff)
      this.handoffs += 1
      this.note(`handoff: ${executionHandoff}`)
      this.checkpoint()
      await this.deps.waitForUser(executionHandoff, this.deps.signal)
      if (!this.deps.guard.isHalted) this.note('resumed by the user')
      return { route: 'gate' }
    }
    if (executionRejection) {
      this.discardPendingPolicyHistory()
      this.observeDecision('blocked', executionRejection)
      this.progress('checking', 'Taking a fresh observation after the action was not executed')
      this.checkpoint()
      return { route: 'gate' }
    }
    if (!blocked && !this.deps.guard.isVerifying) this.deps.guard.beginVerification()
    if (blocked) this.discardPendingPolicyHistory()
    else {
      this.pendingActionEvidence = captured.evidence
      this.pendingExpectedEffect = decision.expectedEffect
      this.pendingActionVerification = true
      this.commitPendingPolicyHistory()
    }
    const blockedPhase: ComputerUsePhase = this.deps.guard.isHalted ? 'stopped' : 'paused'
    this.observe({
      phase: blocked ? blockedPhase : 'checking',
      promptContext: this.actionModelInput ?? captured.promptContext,
      screenshot: captured.shot,
      rawResponse: this.actionResponse,
      reasoning: this.currentReasoning,
      decisionSummary: decision.actionText || decision.actions.map(describeAction).join('; '),
      decisionRationale: decision.decisionRationale,
      parsedAction: decision.actions[0],
      parsedActions: decision.actions,
      ...(mappedActions[0] ? { mappedAction: mappedActions[0] } : {}),
      ...(mappedActions.length ? { mappedActions } : {}),
      durationMs: this.now() - captured.startedAt,
      timings: {
        captureMs: captured.captureMs,
        ...(captured.decisionMs === undefined ? {} : { decisionMs: captured.decisionMs })
      },
      result: blocked ? 'blocked' : 'actuated'
    })
    this.progress(
      blocked ? blockedPhase : 'checking',
      blocked ? 'Action paused' : 'Checking the result'
    )
    this.checkpoint()
    if (!blocked && this.deps.returnAfterAction) {
      const summary = 'Vision completed one recovery action. Returning to accessibility control.'
      this.finalResult = {
        ok: true,
        summary,
        steps: [...this.steps],
        handoffs: this.handoffs,
        performedActions: mappedActions
      }
      return { route: 'end' }
    }
    return { route: 'gate' }
  }

  private groundingInput(captured: CapturedStep, signal: AbortSignal): VisionGroundingInput {
    return {
      goal: this.taskBrief.objective,
      image: captured.shot.image,
      history: captured.history,
      retrievedFacts: this.retrievedFacts,
      continuation: this.continuation,
      continuationCapacity: this.visualHistoryFrames,
      policyHistory: this.policyHistory,
      guidance: captured.guidance,
      currentMilestone: captured.currentMilestone,
      verifiedActions: [...this.verifiedActions],
      previousActionEffect: this.previousActionEffect,
      pendingActionVerification: this.pendingActionVerification,
      previousExpectedEffect: this.previousExpectedEffect,
      semanticElements: captured.shot.metadata?.semanticElements,
      previousVerifiedAction: this.previousVerifiedAction,
      coordinateFrame: coordinateFrame(captured.shot),
      signal,
      reportProgress: (action) => this.progress('thinking', action),
      reportModelIdentity: (identity) => this.deps.onModelIdentity?.(identity),
      reportReasoning: (text) => this.appendReasoning(text)
    }
  }

  private beginReasoning(): void {
    this.currentReasoning = ''
    this.deps.onReasoning?.({ step: this.modelStep, content: '', live: true })
  }

  private updateContinuation(decision: VisionPolicyDecision): void {
    if (decision.continuation) {
      const done = [...(this.continuation?.done ?? []), ...decision.continuation.done].filter(
        (item, index, all) => all.indexOf(item) === index
      )
      this.continuation = boundedContinuationCapsule(
        {
          done,
          next: decision.continuation.next,
          remember: decision.continuation.remember || this.continuation?.remember || ''
        },
        this.visualHistoryFrames
      )
      return
    }
    const done = [...(this.continuation?.done ?? [])]
    if (this.previousActionEffect === 'confirmed') {
      const completed = this.policyHistory.at(-1)?.actionText
      if (completed && !done.includes(completed)) done.push(completed)
    }
    this.continuation = boundedContinuationCapsule(
      {
        done,
        next: decision.actionText,
        remember: this.continuation?.remember ?? ''
      },
      this.visualHistoryFrames
    )
  }

  private appendReasoning(text: string): void {
    if (!text) return
    this.currentReasoning = `${this.currentReasoning}${text}`.slice(
      -MAX_COMPUTER_USE_REASONING_CHARS
    )
    this.deps.onReasoning?.({
      step: this.modelStep,
      content: this.currentReasoning,
      live: true
    })
  }

  private endReasoning(): void {
    this.deps.onReasoning?.({
      step: this.modelStep,
      content: this.currentReasoning,
      live: false
    })
  }

  private observeDecision(result: VisionStepObservation['result'], error?: string): void {
    const captured = this.requireCaptured()
    const decision = this.decision
    this.observe({
      phase: result === 'handoff' || result === 'wait' ? 'waiting' : 'checking',
      promptContext: this.actionModelInput ?? captured.promptContext,
      screenshot: captured.shot,
      rawResponse: this.actionResponse,
      reasoning: this.currentReasoning,
      decisionSummary:
        error ||
        decision?.actionText ||
        (decision && 'summary' in decision ? decision.summary : undefined),
      decisionRationale: decision?.decisionRationale,
      parsedAction: decision?.kind === 'actions' ? decision.actions[0] : null,
      parsedActions: decision?.kind === 'actions' ? decision.actions : undefined,
      durationMs: this.now() - captured.startedAt,
      timings: {
        captureMs: captured.captureMs,
        ...(captured.decisionMs === undefined ? {} : { decisionMs: captured.decisionMs })
      },
      result,
      error
    })
  }

  private observe(detail: Omit<VisionStepObservation, 'step' | 'retrievedFacts'>): void {
    this.deps.onObservation?.({
      step: this.modelStep,
      retrievedFacts: this.retrievedFacts,
      ...detail
    })
  }

  private progress(phase: ComputerUsePhase, action: string): void {
    this.deps.onProgress?.({ phase, step: this.modelStep, action })
  }

  private note(line: string): void {
    this.steps.push(line)
    this.deps.onStep?.(line)
  }

  private checkpoint(): void {
    if (this.modelStep % this.checkpointInterval === 0) {
      this.deps.onCheckpoint?.(this.modelStep, this.steps)
    }
  }

  private trimVisualHistory(): void {
    const imageHistory = this.policyHistory.filter((step) => step.screenshotDataUrl)
    for (const old of imageHistory.slice(
      0,
      Math.max(0, imageHistory.length - this.visualHistoryFrames)
    )) {
      delete old.screenshotDataUrl
    }
  }

  private commitPendingPolicyHistory(): void {
    if (!this.pendingPolicyHistory) return
    this.policyHistory.push(this.pendingPolicyHistory)
    this.pendingPolicyHistory = undefined
    this.trimVisualHistory()
  }

  private discardPendingPolicyHistory(): void {
    this.pendingPolicyHistory = undefined
  }

  private requireCaptured(): CapturedStep {
    if (!this.captured) throw new Error('The visual workflow has no current screenshot.')
    return this.captured
  }

  private finish(ok: boolean, summary: string): void {
    if (ok) this.deps.guard.complete()
    else if (!this.deps.returnAfterAction && !this.deps.guard.isHalted) {
      this.deps.guard.fail(summary)
    }
    this.finalResult = {
      ok,
      summary,
      steps: [...this.steps],
      handoffs: this.handoffs
    }
  }
}

function isRepeatedTypeAction(
  action: VisionAction,
  previous:
    | { action: VisionAction; coordinateFrame: ReturnType<typeof coordinateFrame> }
    | undefined
): boolean {
  return (
    action.type === 'type' &&
    previous?.action.type === 'type' &&
    action.content === previous.action.content
  )
}

function coordinateFrame(shot: Awaited<ReturnType<VisionScreen['capture']>>): {
  encoded: { width: number; height: number }
  source: { width: number; height: number }
} {
  const source = shot.metadata?.geometry?.sourceBounds
  return {
    encoded: shot.bounds,
    source: source ? { width: source.width, height: source.height } : shot.bounds
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

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

const EQUIVALENT_CLICK_REGION_RATIO = 0.04

function clickTarget(action: VisionAction): { x: number; y: number } | null {
  switch (action.type) {
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'middle_click':
    case 'triple_click':
      return action.point
    default:
      return null
  }
}

/** Treat nearby click variants as one target strategy, even after capture resizing. */
export function isEquivalentClickTarget(
  action: VisionAction,
  currentFrame: ReturnType<typeof coordinateFrame>,
  previous:
    | { action: VisionAction; coordinateFrame: ReturnType<typeof coordinateFrame> }
    | undefined
): action is Extract<VisionAction, { point: { x: number; y: number } }> {
  const currentPoint = clickTarget(action)
  const previousPoint = previous ? clickTarget(previous.action) : null
  if (!currentPoint || !previousPoint || !previous) return false
  const currentBounds = currentFrame.encoded
  const previousBounds = previous.coordinateFrame.encoded
  if (
    currentBounds.width <= 0 ||
    currentBounds.height <= 0 ||
    previousBounds.width <= 0 ||
    previousBounds.height <= 0
  ) {
    return false
  }
  const deltaX = currentPoint.x / currentBounds.width - previousPoint.x / previousBounds.width
  const deltaY = currentPoint.y / currentBounds.height - previousPoint.y / previousBounds.height
  return Math.hypot(deltaX, deltaY) <= EQUIVALENT_CLICK_REGION_RATIO
}
