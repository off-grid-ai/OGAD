import type { ContentPart } from '../../llm/chat-payload'
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

export interface VisionPolicyMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface VisionPolicyToolCall {
  id: string
  name: string
  arguments: string
}

export interface VisionPolicyResponse {
  content: string
  toolCalls: readonly VisionPolicyToolCall[]
}

export interface VisionPolicyRequest {
  messages: VisionPolicyMessage[]
  maxTokens: number
  timeoutMs: number
  maxAttempts: number
  /** Exact shared generation route selected for this policy run. */
  generationRouteId?: string
  /** Optional structured-output grammar for specialist text protocols. */
  responseFormat?: unknown
  /** OpenAI-compatible native tools. General/remote operators use this path. */
  tools?: unknown[]
  toolChoice?: string
  temperature?: number
  topP?: number
  /** Preserve the model's inline <think> protocol while explicitly enabling its template mode. */
  enableThinking?: boolean
  disableThinking?: boolean
  /** Ask llama.cpp to return reasoning separately from the final answer. */
  separateReasoning?: boolean
  /** Require a final answer outside the model's private reasoning channel. */
  requireFinalAnswer?: boolean
  /** Reject a malformed final answer so the request can use its normal retry budget. */
  validateResponse?(response: VisionPolicyResponse): boolean
  /** Explain which strict contract rule failed without exposing private reasoning. */
  responseValidationError?(response: VisionPolicyResponse): string | undefined
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
