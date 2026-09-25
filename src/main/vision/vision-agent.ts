/**
 * The vision rail's shared contract (R2-D): the injected boundaries every
 * supervised screen-control workflow plugs into - the screen (capture +
 * actuate), the grounding model, the guard, and the takeover wait - plus the
 * step/observation types the surfaces report through. The workflow itself is
 * runVisionTaskGraph in vision-task-graph.ts.
 */
import type { VisionAction, Bounds } from './vision-action'
import type { VisionGuard } from './vision-guard'
import type { ScreenshotGeometry } from './screenshot-geometry'
import type {
  VisionPolicyCoordinateFrame,
  VisionContinuationCapsule,
  VisionPolicyDecision,
  VisionPolicyHistoryStep
} from './model-adapters/types'
import type { ComputerUsePhase } from '../tasks/task-step-details'
import type { TaskExecutionPlan } from '../../shared/task-execution-plan'
import type { VisionActionEffect, VisionSemanticElement } from './vision-common-types'

export type { VisionActionEffect, VisionSemanticElement } from './vision-common-types'

export interface VisionCaptureMetadata {
  path?: string
  geometry?: ScreenshotGeometry
  /** Native title of the captured target window, when accessibility provides it. */
  windowTitle?: string
  /** CSS-pixel bounds used by browser input for this captured frame. */
  viewport?: Bounds
  /** Optional OS accessibility controls captured with this same frame. */
  semanticElements?: readonly VisionSemanticElement[]
  /** OS accessibility controls used only to verify screen changes. These are
   * never added to model input unless the Accessibility rail is enabled. */
  verificationSemanticElements?: readonly VisionSemanticElement[]
}

export interface VisionActuationResult {
  mappedAction?: VisionAction
  /** Execution-boundary handoff. The private value is intentionally absent. */
  handoff?: string
  /** The surface refused a recoverable action before any input was sent. */
  rejected?: string
}

export interface VisionTaskContinuation {
  guard: VisionGuard
  request: AbortController
  queuedGuidance: string[]
  /** Return to the owning accessibility loop after one successful visual action. */
  returnAfterAction?: boolean
  /** Run the selected grounding specialist directly for an AX recovery action. */
  specialistOnly?: boolean
  /** Run the heavy reasoning model only after the grounding specialist fails. */
  reasonerOnly?: boolean
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
  continuation?: VisionContinuationCapsule
  continuationCapacity?: number
  policyHistory: readonly VisionPolicyHistoryStep[]
  guidance: readonly string[]
  currentMilestone?: string
  verifiedActions?: readonly string[]
  /** Result of comparing the last action's before/after screen and semantic state. */
  previousActionEffect?: VisionActionEffect
  /** Enforce a verification-only model turn before any further actuation. */
  pendingActionVerification?: boolean
  previousExpectedEffect?: string
  semanticElements?: readonly VisionSemanticElement[]
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
  /** Report the model that owns the current inference call. */
  reportModelIdentity?: (identity: { modelId: string; modelName: string }) => void
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
  /**
   * Where a step's time actually went, split at the only boundary that matters for diagnosis:
   * screen capture versus the model call. "The task feels slow" is unanswerable without it - the
   * same total can be a slow model or a capture loop retrying against a page that will not settle,
   * and those have opposite fixes.
   */
  timings?: { captureMs?: number; decisionMs?: number }
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
  waitForUser: (why: string, signal?: AbortSignal) => Promise<void>
  onStep?: (note: string) => void
  onProgress?: (progress: VisionTaskProgress) => void
  onModelIdentity?: (identity: { modelId: string; modelName: string }) => void
  onReasoning?: (reasoning: VisionTaskReasoning) => void
  onObservation?: (observation: VisionStepObservation) => void
  onCheckpoint?: (step: number, steps: readonly string[]) => void
  contextTokens?: number
  checkpointInterval?: number
  visualHistoryFrames?: number
  retrievedFacts?: string[]
  now?: () => number
  maxPlanningSteps?: number
  /** Recovery mode: stop after one successful action without completing the shared task. */
  returnAfterAction?: boolean
  /** A timed activity repeats its plan until the session owner ends it. */
  repeatUntilSessionLimit?: boolean
  plan?: TaskExecutionPlan
  onPhase?: (phaseId: string) => void
  /** The trace this run is resuming from, so a retry restarts at the phase it reached instead of
   *  the first one. Absent for a fresh run. */
  resumedSteps?: readonly string[]
  takeGuidance?: () => readonly string[]
  signal?: AbortSignal
}

export interface VisionTaskResult {
  ok: boolean
  summary: string
  steps: string[]
  handoffs: number
  /** Actions that crossed the execution boundary in a one-action recovery. */
  performedActions?: readonly VisionAction[]
}
