import type {
  ComputerUsePolicyRequest,
  ComputerUsePolicyResponse,
  ComputerUsePolicyToolCall
} from '@offgrid/models'
import type { Bounds, VisionAction } from '../vision-action'

export interface VisionModelArtifacts {
  id: string
  primaryFile: string
  projectorFile: string | null
  availableFiles: readonly string[]
}

export interface VisionPolicyHistoryStep {
  response: string
  actionText: string
  /** Recent visual state. Older steps keep text only after the image window collapses. */
  screenshotDataUrl?: string
}

export interface VisionPolicyInput {
  goal: string
  /** The action surface changes which shortcuts are real controls. */
  operatorEnvironment?: 'desktop' | 'embedded_browser'
  currentScreenshotDataUrl: string
  history: readonly VisionPolicyHistoryStep[]
  recentSteps: readonly string[]
  olderVisualFacts: readonly string[]
  /** Explicit plan state. Do not force an adapter to recover it from free-form history. */
  currentMilestone?: string
  /** Actions that crossed the execution boundary without an error. */
  verifiedActions?: readonly string[]
  /** Marker drawn into the current screenshot at the previous click position.
   * This lets the visual judge verify where the last action landed. */
  previousClickMarker?: { x: number; y: number }
  /** The image sent to the model and its encoded/capture geometry. Model
   * actions use the canonical 0-1000 normalized coordinate protocol and are
   * converted into encoded pixels before actuation. */
  coordinateFrame?: VisionPolicyCoordinateFrame
  /** Exact shared generation route selected for this policy run. */
  generationRouteId?: string
}

export interface VisionPolicyCoordinateFrame {
  encoded: Bounds
  source: Bounds
}

export type VisionPolicyMessage = ComputerUsePolicyRequest['messages'][number]
export type VisionPolicyToolCall = ComputerUsePolicyToolCall
export type VisionPolicyResponse = ComputerUsePolicyResponse
export type VisionPolicyRequest = Omit<ComputerUsePolicyRequest, 'messages'> & {
  messages: VisionPolicyMessage[]
}

export type VisionPolicyDecision = (
  | { kind: 'actions'; actionText: string; actions: readonly VisionAction[] }
  | { kind: 'phase_complete'; actionText: string; summary: string }
  | { kind: 'wait'; actionText: string; durationMs: number }
  | { kind: 'done'; actionText: string; summary: string }
  | { kind: 'failed'; actionText: string; summary: string }
  | { kind: 'handoff'; actionText: string; reason: string }
  | {
      kind: 'rethink'
      actionText: string
      summary: string
      direction: 'aligned' | 'off_course'
    }
  | { kind: 'invalid'; actionText: string; error: string }
) & {
  /** Short, redacted explanation for user-visible task evidence. Never raw chain-of-thought. */
  decisionRationale?: string
}

export interface VisionModelAdapter {
  readonly id: string
  readonly screenshotResizeFactor?: number
  /** Select the visual surface that Web Use sends to this model family.
   * Page-only capture keeps webpage coordinates in one frame. */
  readonly browserCaptureScope?: 'page' | 'surface'
  readonly requiresLoadCapabilityGate?: boolean
  matches(model: VisionModelArtifacts): boolean
  assertCapabilities(model: VisionModelArtifacts): void
  buildRequest(input: VisionPolicyInput): VisionPolicyRequest
  parseResponse(
    response: string,
    bounds: Bounds,
    coordinateFrame?: VisionPolicyCoordinateFrame
  ): VisionPolicyDecision
  /** General and remote models route from native tool calls. Specialist text
   * protocols omit this hook and continue through parseResponse. */
  parsePolicyResponse?(
    response: VisionPolicyResponse,
    bounds: Bounds,
    coordinateFrame?: VisionPolicyCoordinateFrame
  ): VisionPolicyDecision
}
