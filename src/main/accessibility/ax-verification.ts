import type {
  ComputerUseVerificationResult,
  DeterministicPostcondition,
  NormalizedCandidate
} from './ax-state'

export interface VerificationObservation {
  windowId: string
  processId: number
  windowTitle: string
  candidates: readonly NormalizedCandidate[]
  visibleText?: string
}

export interface VerificationOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  stableSamples?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
}

export function evaluatePostcondition(
  expected: DeterministicPostcondition,
  before: VerificationObservation,
  after: VerificationObservation
): Exclude<ComputerUseVerificationResult['status'], 'timeout'> {
  if (after.processId !== before.processId) return 'unknown'
  switch (expected.type) {
    case 'field_value': {
      const candidate = after.candidates.find((item) => item.id === expected.candidateId)
      return candidate
        ? candidate.value === expected.value
          ? 'satisfied'
          : 'unsatisfied'
        : 'unknown'
    }
    case 'state_change': {
      const candidate = after.candidates.find((item) => item.id === expected.candidateId)
      if (!candidate) return 'unknown'
      const value = candidate[expected.property]
      return typeof value === 'boolean'
        ? value !== expected.from
          ? 'satisfied'
          : 'unsatisfied'
        : 'unknown'
    }
    case 'candidate_effect': {
      const candidate = after.candidates.find((item) => item.id === expected.candidateId)
      if (!candidate) return 'satisfied'
      return candidate.value !== expected.before.value ||
        candidate.enabled !== expected.before.enabled ||
        candidate.checked !== expected.before.checked ||
        candidate.selected !== expected.before.selected
        ? 'satisfied'
        : 'unsatisfied'
    }
    case 'window_appears':
      return after.windowId !== before.windowId &&
        (!expected.title || after.windowTitle.includes(expected.title))
        ? 'satisfied'
        : 'unsatisfied'
    case 'window_state_change':
      return 'unknown'
    case 'visible_effect':
      return 'unknown'
    case 'unverifiable':
      return 'unknown'
  }
}

export async function verifyPostcondition(
  expected: DeterministicPostcondition,
  before: VerificationObservation,
  observe: () => Promise<VerificationObservation>,
  options: VerificationOptions = {}
): Promise<ComputerUseVerificationResult> {
  const now = options.now ?? Date.now
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const timeoutMs = options.timeoutMs ?? 2_000
  const pollIntervalMs = options.pollIntervalMs ?? 75
  const stableSamples = Math.max(1, options.stableSamples ?? 2)
  const startedAt = now()
  let samples = 0
  let consecutiveSatisfied = 0
  let last: ComputerUseVerificationResult['status'] = 'unknown'
  while (now() - startedAt <= timeoutMs) {
    const after = await observe()
    samples += 1
    last = evaluatePostcondition(expected, before, after)
    if (last === 'satisfied') {
      consecutiveSatisfied += 1
      if (consecutiveSatisfied >= stableSamples) {
        return {
          status: 'satisfied',
          observedDifference: `${before.windowTitle} -> ${after.windowTitle}`,
          latencyMs: now() - startedAt,
          samples
        }
      }
    } else {
      consecutiveSatisfied = 0
    }
    if (now() - startedAt + pollIntervalMs > timeoutMs) break
    await wait(pollIntervalMs)
  }
  return {
    status: last === 'unknown' ? 'unknown' : 'timeout',
    latencyMs: now() - startedAt,
    samples
  }
}
