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
  VisionPolicyDecision,
  VisionPolicyHistoryStep
} from './model-adapters/types'
import type { ComputerUsePhase } from '../tasks/task-step-details'
import type { TaskExecutionPlan } from '../../shared/task-execution-plan'

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
