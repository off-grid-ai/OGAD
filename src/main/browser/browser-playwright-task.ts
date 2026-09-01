import type { PlaywrightToolResult } from './playwright-mcp-session'
import {
  completionEvidenceMatches,
  decideBrowserSemanticAction,
  type SemanticDecision
} from './browser-playwright-policy'
import {
  executePlaywrightAction,
  isPrivateSemanticTarget,
  projectPlaywrightPointer
} from './browser-playwright-actions'
import type {
  BrowserPlaywrightTaskInput,
  BrowserPlaywrightTaskResult,
  BrowserSemanticObservation
} from './browser-playwright-task-contract'
import {
  actionLabel,
  combinedSignal,
  compact,
  fallback,
  fingerprint,
  hasSemanticReferences,
  isCrashedTarget,
  isStaleReference,
  observeWithCurrentLease,
  recoverCrashedTarget,
  stableActionKey
} from './browser-playwright-task-support'

const MAX_STEPS = 24
const MAX_NO_CHANGE = 2

export type {
  BrowserPlaywrightTaskInput,
  BrowserPlaywrightTaskResult,
  BrowserSemanticObservation
} from './browser-playwright-task-contract'

interface SemanticLoopState {
  observation: PlaywrightToolResult
  handoffs: number
  noChangeCount: number
  lastActionKey: string
  lastFingerprint: string
  recoveryNote: string
  crashRecoveries: number
}

interface SemanticLoopContext {
  input: BrowserPlaywrightTaskInput
  state: SemanticLoopState
}

/**
 * The semantic Web Use loop. Playwright MCP owns observation, references,
 * waiting, navigation, and actuation. This class owns only product policy:
 * goal planning, privacy handoff, progress evidence, and bounded fallback.
 */
export async function runBrowserPlaywrightTask(
  input: BrowserPlaywrightTaskInput
): Promise<BrowserPlaywrightTaskResult> {
  try {
    return await runSemanticLoop(input)
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason ?? error
    const detail = error instanceof Error ? error.message : String(error)
    return fallback(`Semantic control was unavailable: ${compact(detail)}`)
  }
}

async function runSemanticLoop(
  input: BrowserPlaywrightTaskInput
): Promise<BrowserPlaywrightTaskResult> {
  let observation = await observeWithCurrentLease(input)
  let crashRecoveries = 0
  if (observation.isError && isCrashedTarget(observation)) {
    observation = await recoverCrashedTarget(input)
    crashRecoveries += 1
  }
  if (observation.isError || !hasSemanticReferences(observation.text)) {
    return fallback('The page did not expose usable semantic controls.')
  }
  await publishObservation(input, { step: 0, phase: 'observing', summary: 'Initial page' })

  const state: SemanticLoopState = {
    observation,
    handoffs: 0,
    noChangeCount: 0,
    lastActionKey: '',
    lastFingerprint: fingerprint(observation.text),
    recoveryNote: '',
    crashRecoveries
  }
  const context = { input, state }

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const outcome = await runSemanticStep(context, step)
    if (outcome) return outcome
  }
  return fallback('The semantic step limit was reached.', state.handoffs)
}

async function runSemanticStep(
  context: SemanticLoopContext,
  step: number
): Promise<BrowserPlaywrightTaskResult | undefined> {
  const { input, state } = context
  input.signal?.throwIfAborted()
  await input.guard.waitUntilRunnable(input.signal)
  if (input.guard.isHalted) input.signal?.throwIfAborted()
  input.onProgress(step, 'thinking', 'Choosing the next semantic action')
  const modelLease = input.guard.currentActionLease()
  let decision: SemanticDecision
  try {
    decision = await (input.decide ?? decideBrowserSemanticAction)({
      goal: input.goal,
      plan: input.plan,
      snapshot: state.observation.text,
      step,
      maxSteps: MAX_STEPS,
      recoveryNote: state.recoveryNote,
      guidance: input.takeGuidance(),
      signal: combinedSignal(input.signal, modelLease.signal)
    })
  } catch (error) {
    if (!modelLease.signal.aborted) throw error
    input.onStep('discarded a model reply after input control changed')
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  if (!input.guard.ownsActionLease(modelLease.epoch)) {
    input.onStep('discarded a late model reply after input control changed')
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  state.recoveryNote = ''
  publishPhase(input, decision)
  const terminal = await terminalDecision(context, decision, step)
  if (terminal) return terminal
  if (
    decision.action === 'human_required' ||
    isPrivateSemanticTarget(decision, state.observation.text)
  ) {
    await performHumanHandoff(context, decision, step)
    return undefined
  }
  if (skipUnchangedDuplicate(input, state, decision)) {
    return state.noChangeCount >= MAX_NO_CHANGE
      ? fallback('Semantic control made no visible progress.', state.handoffs)
      : undefined
  }
  return performSemanticAction(context, decision, step)
}

function publishPhase(input: BrowserPlaywrightTaskInput, decision: SemanticDecision): void {
  if (decision.phase_id && input.plan.phases.some((phase) => phase.id === decision.phase_id)) {
    input.onPhase(decision.phase_id)
  }
}

async function terminalDecision(
  context: SemanticLoopContext,
  decision: SemanticDecision,
  step: number
): Promise<BrowserPlaywrightTaskResult | undefined> {
  const { input, state } = context
  if (decision.action === 'done') {
    const summary = decision.summary.trim() || 'The web task is complete.'
    if (!input.guard.beginVerification()) return undefined
    const verification = await observeWithCurrentLease(input)
    if (verification.isError) {
      input.guard.fail('The final page could not be verified.')
      return {
        ok: false,
        fallback: false,
        summary: 'The final page could not be verified.',
        handoffs: state.handoffs
      }
    }
    if (!completionEvidenceMatches(decision, verification.text)) {
      const failure = 'The final page no longer contained the evidence required for completion.'
      input.guard.fail(failure)
      input.onStep(`verification failed: ${failure}`)
      return { ok: false, fallback: false, summary: failure, handoffs: state.handoffs }
    }
    await publishObservation(input, { step, phase: 'complete', summary })
    if (!input.guard.complete()) return undefined
    input.onStep(`verified: ${summary}`)
    return { ok: true, fallback: false, summary, handoffs: state.handoffs }
  }
  return decision.action === 'fallback'
    ? fallback(decision.reason || 'The page needs visual control.', state.handoffs)
    : undefined
}

async function performHumanHandoff(
  context: SemanticLoopContext,
  decision: SemanticDecision,
  step: number
): Promise<void> {
  const { input, state } = context
  const why = decision.reason.trim() || 'This step needs your input in the watched page.'
  input.onStep(`waiting for you: ${why}`)
  await input.waitForUser(why, input.signal)
  state.handoffs += 1
  state.observation = await observeWithCurrentLease(input)
  await publishObservation(input, {
    step,
    phase: 'waiting',
    summary: 'Continued after user input'
  })
  state.lastFingerprint = fingerprint(state.observation.text)
  state.lastActionKey = ''
  state.noChangeCount = 0
}

function skipUnchangedDuplicate(
  input: BrowserPlaywrightTaskInput,
  state: SemanticLoopState,
  decision: SemanticDecision
): boolean {
  const duplicate =
    stableActionKey(decision) === state.lastActionKey &&
    fingerprint(state.observation.text) === state.lastFingerprint
  if (!duplicate) return false
  state.noChangeCount += 1
  state.recoveryNote =
    'The previous action was a duplicate on an unchanged page. Choose a different action.'
  input.onStep(`no change: skipped duplicate ${actionLabel(decision)}`)
  return true
}

async function performSemanticAction(
  context: SemanticLoopContext,
  decision: SemanticDecision,
  step: number
): Promise<BrowserPlaywrightTaskResult | undefined> {
  const { input, state } = context
  const actionKey = stableActionKey(decision)
  const lease = input.guard.currentActionLease()
  if (!input.guard.canActuate(lease.epoch)) {
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  await projectPlaywrightPointer(input.activeDriver(), decision, state.observation.text)
  if (!input.guard.canActuate(lease.epoch)) {
    input.onStep('skipped an action after input control changed')
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  input.guard.countStep()
  input.onProgress(step, 'acting', actionLabel(decision))
  let result: PlaywrightToolResult
  try {
    result = await executePlaywrightAction(
      input.session,
      decision,
      combinedSignal(input.signal, lease.signal)
    )
  } catch (error) {
    if (!lease.signal.aborted) throw error
    input.onStep('cancelled an in-flight action after input control changed')
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  if (!input.guard.ownsActionLease(lease.epoch)) {
    input.onStep('discarded a late action result after input control changed')
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  input.onStep(`${actionLabel(decision)}: ${result.isError ? 'not completed' : 'completed'}`)
  if (result.isError) return recoverActionError(input, state, result)

  const before = fingerprint(state.observation.text)
  state.observation = await observeWithCurrentLease(input)
  const recovery = await recoverObservationError(input, state)
  if (recovery === 'recovered') return undefined
  if (recovery) return recovery
  await publishObservation(input, { step, phase: 'checking', summary: actionLabel(decision) })
  updateProgressEvidence(context, { decision, actionKey, before })
  return state.noChangeCount >= MAX_NO_CHANGE
    ? fallback('Semantic control made no visible progress.', state.handoffs)
    : undefined
}

async function publishObservation(
  input: BrowserPlaywrightTaskInput,
  observation: BrowserSemanticObservation
): Promise<void> {
  if (!input.onObservation) return
  try {
    await input.onObservation(observation)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    input.onStep(`replay frame unavailable: ${compact(detail)}`)
  }
}

async function recoverActionError(
  input: BrowserPlaywrightTaskInput,
  state: SemanticLoopState,
  result: PlaywrightToolResult
): Promise<BrowserPlaywrightTaskResult | undefined> {
  if (state.crashRecoveries < 1 && isCrashedTarget(result)) {
    await recoverStateAfterCrash(input, state)
    return undefined
  }
  if (isStaleReference(result)) {
    state.observation = await observeWithCurrentLease(input)
    state.recoveryNote =
      'The element reference became stale. Use only a reference from this fresh snapshot.'
    input.onStep('re-observed the page after a stale element reference')
    return undefined
  }
  return fallback(`Semantic action failed: ${compact(result.text)}`, state.handoffs)
}

async function recoverObservationError(
  input: BrowserPlaywrightTaskInput,
  state: SemanticLoopState
): Promise<BrowserPlaywrightTaskResult | 'recovered' | undefined> {
  if (!state.observation.isError) return undefined
  if (state.crashRecoveries < 1 && isCrashedTarget(state.observation)) {
    await recoverStateAfterCrash(input, state)
    return 'recovered'
  }
  return fallback('The semantic page snapshot failed after the action.', state.handoffs)
}

async function recoverStateAfterCrash(
  input: BrowserPlaywrightTaskInput,
  state: SemanticLoopState
): Promise<void> {
  state.observation = await recoverCrashedTarget(input)
  if (state.observation.isError) {
    throw new Error(`The crashed page could not be reopened: ${compact(state.observation.text)}`)
  }
  state.crashRecoveries += 1
  state.recoveryNote = 'The page crashed and was reopened. Re-observe it before continuing.'
  state.lastActionKey = ''
  state.noChangeCount = 0
  input.onStep('reopened the page after its renderer crashed')
}

function updateProgressEvidence(
  context: SemanticLoopContext,
  evidence: { decision: SemanticDecision; actionKey: string; before: string }
): void {
  const { input, state } = context
  const { decision, actionKey, before } = evidence
  const after = fingerprint(state.observation.text)
  state.lastActionKey = actionKey
  state.lastFingerprint = after
  if (before !== after) {
    state.noChangeCount = 0
    return
  }
  state.noChangeCount += 1
  state.recoveryNote =
    'The last action did not change the page. Verify the goal or choose a different control.'
  input.onStep(`no visible change after ${actionLabel(decision)}`)
}
