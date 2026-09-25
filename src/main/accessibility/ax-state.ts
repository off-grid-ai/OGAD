import { createHash } from 'node:crypto'

export interface AxRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AxCaptureGeometry {
  sourceBounds: AxRect
  encodedWidth: number
  encodedHeight: number
  scaleX: number
  scaleY: number
}

export type ObservationSource = 'ax' | 'ocr' | 'ax+ocr'
export type ObservationModality = 'ax' | 'uia' | 'ocr' | 'capture'

export interface WindowIdentity {
  platform: NodeJS.Platform
  processId: number
  processName: string
  windowId: string
  windowTitle: string
  bounds: AxRect
}

export interface SourceStatus {
  available: boolean
  degradedReason?: string
}

export interface WindowBoundObservation {
  snapshotId: string
  revision: number
  window: WindowIdentity
  capture: AxCaptureGeometry
  sources: Record<ObservationModality, SourceStatus>
}

export type CandidateRisk = 'reversible' | 'private' | 'authentication' | 'payment' | 'destructive'

export type CandidateAction =
  | { type: 'activate'; method: 'press' | 'click' | 'hover'; x: number; y: number }
  | { type: 'type'; text: string; submit: boolean }
  | { type: 'key'; keys: string }
  | { type: 'wait'; durationMs: number }

export type DeterministicPostcondition =
  | { type: 'field_value'; candidateId: string; value: string }
  | { type: 'state_change'; candidateId: string; property: 'checked' | 'selected'; from: boolean }
  | {
      type: 'candidate_effect'
      candidateId: string
      before: { value: string; enabled: boolean; checked?: boolean; selected?: boolean }
    }
  | { type: 'window_appears'; processId: number; title?: string }
  | { type: 'window_state_change'; processId: number; previousTitle: string }
  | { type: 'visible_effect'; description: string }
  | { type: 'unverifiable'; reason: string }

export interface NormalizedCandidate {
  id: string
  displayIndex: number
  source: ObservationSource
  role: string
  label: string
  value: string
  bounds: AxRect
  center: { x: number; y: number }
  enabled: boolean
  checked?: boolean
  selected?: boolean
  hasPopup?: boolean
  executable?: CandidateAction
  expected?: DeterministicPostcondition
  snapshotId: string
  revision: number
  windowId: string
  processId: number
  risk: CandidateRisk
  region?: string
}

export type DecisionFamily =
  | 'action_kind'
  | 'target_group'
  | 'target'
  | 'completion'
  | 'user_handoff'
  | 'visual_recovery'

export interface ProbabilityDistribution {
  labels: string[]
  probabilities: number[]
}

export interface ComputerUseDecisionResult {
  family: DecisionFamily
  selectedCandidate?: NormalizedCandidate
  distributions: ProbabilityDistribution[]
  topProbability: number
  probabilityMargin: number
  entropy: number
  combinedConfidence: number
  backend: 'rules' | 'decider' | 'reasoner' | 'specialist'
  abstentionReason?: string
  fallbackReason?: string
  latencyMs: number
}

export type VerificationStatus = 'satisfied' | 'unsatisfied' | 'unknown' | 'timeout'

export interface ComputerUseVerificationResult {
  status: VerificationStatus
  observedDifference?: string
  latencyMs: number
  samples: number
}

export interface ObservationRevisionState {
  fingerprint: string
  revision: number
}

function canonicalRect(rect: AxRect): string {
  return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value)).join(':')
}

export function stableCandidateId(input: {
  windowId: string
  source: ObservationSource
  role: string
  label: string
  bounds: AxRect
}): string {
  const label = input.label.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
  const value = `${input.windowId}|${input.source}|${input.role}|${label}|${canonicalRect(input.bounds)}`
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

export function nextObservationRevision(
  previous: ObservationRevisionState | undefined,
  window: WindowIdentity,
  candidateFacts: readonly string[]
): ObservationRevisionState {
  const fingerprint = createHash('sha256')
    .update(
      [
        window.processId,
        window.windowId,
        window.windowTitle,
        canonicalRect(window.bounds),
        ...candidateFacts
      ].join('|')
    )
    .digest('hex')
  return {
    fingerprint,
    revision:
      previous?.fingerprint === fingerprint ? previous.revision : (previous?.revision ?? 0) + 1
  }
}

export function regionDescription(rect: AxRect, windowBounds: AxRect): string {
  const x = rect.x + rect.width / 2 - windowBounds.x
  const y = rect.y + rect.height / 2 - windowBounds.y
  const horizontal =
    x < windowBounds.width / 3 ? 'left' : x > (windowBounds.width * 2) / 3 ? 'right' : 'center'
  const vertical =
    y < windowBounds.height / 3 ? 'top' : y > (windowBounds.height * 2) / 3 ? 'bottom' : 'middle'
  return vertical === 'middle' && horizontal === 'center' ? 'center' : `${vertical}-${horizontal}`
}

export function observationOwnsCandidate(
  observation: WindowBoundObservation,
  candidate: NormalizedCandidate
): boolean {
  return (
    candidate.snapshotId === observation.snapshotId &&
    candidate.revision === observation.revision &&
    candidate.windowId === observation.window.windowId &&
    candidate.processId === observation.window.processId
  )
}
