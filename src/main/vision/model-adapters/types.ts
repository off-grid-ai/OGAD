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
}

export interface VisionPolicyInput {
  goal: string
  currentScreenshotDataUrl: string
  history: readonly VisionPolicyHistoryStep[]
  recentSteps: readonly string[]
  olderVisualFacts: readonly string[]
}

export interface VisionPolicyMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface VisionPolicyRequest {
  messages: VisionPolicyMessage[]
  maxTokens: number
  timeoutMs: number
  maxAttempts: number
  temperature?: number
  topP?: number
  disableThinking?: boolean
}

export type VisionPolicyDecision =
  | { kind: 'actions'; actionText: string; actions: readonly VisionAction[] }
  | { kind: 'wait'; actionText: string; durationMs: number }
  | { kind: 'done'; actionText: string; summary: string }
  | { kind: 'failed'; actionText: string; summary: string }
  | { kind: 'handoff'; actionText: string; reason: string }
  | { kind: 'invalid'; actionText: string; error: string }

export interface VisionModelAdapter {
  readonly id: string
  readonly screenshotResizeFactor?: number
  readonly requiresLoadCapabilityGate?: boolean
  matches(model: VisionModelArtifacts): boolean
  assertCapabilities(model: VisionModelArtifacts): void
  buildRequest(input: VisionPolicyInput): VisionPolicyRequest
  parseResponse(response: string, bounds: Bounds): VisionPolicyDecision
}
