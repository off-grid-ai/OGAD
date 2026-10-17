import { isUncertainPageResult } from '../extension-bridge/bridge-socket-protocol'
import type { PlaywrightToolResult } from './playwright-mcp-session'
import { InvalidDecisionError, NoSupportedActionError } from './semantic-candidates'
import {
  completionEvidenceMatches,
  decideBrowserSemanticAction,
  type SemanticDecision
} from './browser-playwright-policy'
import {
  executePlaywrightAction,
  isNavigateToCurrentPage,
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
  isInputAction,
  isUncertainActionTimeout,
  UNCERTAIN_ACTION_NOTE,
  uncertainActionKey,
  observeWithCurrentLease,
  recoverCrashedTarget,
  semanticSnapshotDiagnostics,
  stableActionKey
} from './browser-playwright-task-support'

const MAX_STEPS = 24
/**
 * Steps in a row without progress (no change, a failed or unusable action) before the task
 * stops. browser-use stops at 5 consecutive failures; 2 stopped tasks a small model would have
 * finished. From the third, the model is told to change approach.
 */
const MAX_NO_CHANGE = 5
const REPLAN_AFTER = 3
/** The model's own recent steps and what each did, as browser-use and Nanobrowser show them. */
const MAX_HISTORY = 8

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
  uncertainCount: number
  uncertainActions: Set<string>
  /** What the last steps did, oldest first: the model's memory of this task. */
  history: string[]
  /** Everything the user has told this task: kept for every step, not used once. */
  guidance: string[]
}

/** One step's outcome into the model's memory, keeping the newest few. */
function remember(state: SemanticLoopState, entry: string): void {
  state.history.push(compact(entry))
  if (state.history.length > MAX_HISTORY) state.history.shift()
}

/** The note for a step without progress; from the third, a push to change approach. */
/** New guidance joins what the user said before; the newest five go to the model. */
function rememberGuidance(state: SemanticLoopState, fresh: readonly string[]): string[] {
  state.guidance.push(...fresh)
  return state.guidance.slice(-5)
}

function stallNote(state: SemanticLoopState, note: string): string {
  return state.noChangeCount >= REPLAN_AFTER
    ? `${note} You have made no progress for ${state.noChangeCount} steps. Do something different from the steps above: another control, scrolling, or human_required if only the user can do it.`
    : note
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
    console.warn('[web-use][semantic] loop failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      error: compact(detail)
    })
    return {
      ok: false,
      fallback: false,
      summary: `Web Use stopped: ${compact(detail)}`,
      handoffs: 0
    }
  }
}

async function runSemanticLoop(
  input: BrowserPlaywrightTaskInput
): Promise<BrowserPlaywrightTaskResult> {
  let observation = await observeUntilLoaded(input)
  console.log('[web-use][semantic] initial snapshot', {
    isError: observation.isError,
    ...semanticSnapshotDiagnostics(observation.text)
  })
  let crashRecoveries = 0
  if (observation.isError && isCrashedTarget(observation)) {
    console.warn('[web-use][semantic] crashed target detected; recovering')
    observation = await recoverCrashedTarget(input)
    crashRecoveries += 1
    console.log('[web-use][semantic] recovered snapshot', {
      isError: observation.isError,
      ...semanticSnapshotDiagnostics(observation.text)
    })
  }
  if (observation.isError || !hasSemanticReferences(observation.text)) {
    console.warn('[web-use][semantic] snapshot rejected', {
      reason: observation.isError ? 'mcp-result-error' : 'no-semantic-references',
      isError: observation.isError,
      ...semanticSnapshotDiagnostics(observation.text)
    })
    return fallback(
      observation.isError
        ? `The page could not be read: ${compact(observation.text)}`
        : 'The page did not expose usable semantic controls.'
    )
  }
  await publishObservation(input, { step: 0, phase: 'observing', summary: 'Initial page' })

  const state: SemanticLoopState = {
    observation,
    handoffs: 0,
    noChangeCount: 0,
    lastActionKey: '',
    lastFingerprint: fingerprint(observation.text),
    recoveryNote: '',
    crashRecoveries,
    uncertainCount: 0,
    uncertainActions: new Set(),
    history: [],
    guidance: []
  }
  const context = { input, state }

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const outcome = await runSemanticStep(context, step)
    if (outcome) return outcome
  }
  return fallback('The semantic step limit was reached.', state.handoffs)
}

/** Reads of a page that shows no controls yet before the task gives up on it. */
const LOAD_READS = 5
const LOAD_READ_MS = 1000

/**
 * The first read of a page still loading shows no controls. Found live: a task gave up at once
 * with "The page did not expose usable semantic controls" on a page that loaded a second later.
 * browser-use waits on an empty page before it treats it as a problem.
 */
export async function observeUntilLoaded(
  input: BrowserPlaywrightTaskInput
): Promise<PlaywrightToolResult> {
  let observation = await observeWithCurrentLease(input)
  for (
    let read = 1;
    read < LOAD_READS && !observation.isError && !hasSemanticReferences(observation.text);
    read += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, LOAD_READ_MS))
    observation = await observeWithCurrentLease(input)
  }
  return observation
}

async function runSemanticStep(
  context: SemanticLoopContext,
  step: number
): Promise<BrowserPlaywrightTaskResult | undefined> {
  const { input, state } = context
  input.signal?.throwIfAborted()
  await input.guard.waitUntilRunnable(input.signal)
  if (input.guard.isHalted) input.signal?.throwIfAborted()
  input.onProgress(step, 'thinking', 'Deciding the next step')
  const modelLease = input.guard.currentActionLease()
  let decision: SemanticDecision
  try {
    decision = await decideBrowserSemanticAction({
      goal: input.goal,
      plan: input.plan,
      snapshot: state.observation.text,
      step,
      maxSteps: MAX_STEPS,
      recoveryNote: state.recoveryNote,
      guidance: rememberGuidance(state, input.takeGuidance()),
      history: state.history,
      signal: combinedSignal(input.signal, modelLease.signal)
    })
  } catch (error) {
    if (error instanceof InvalidDecisionError) {
      remember(state, `(your reply could not run: ${error.detail})`)
      return reobserveForRetry(input, state, {
        note: `Your last reply was not an action that can run: ${error.detail}. Reply with one valid action for this fresh snapshot.`,
        step: `re-observed the page after an action that could not run: ${error.detail}`,
        stop: `Stopped: the model kept proposing actions that cannot run (${error.detail}).`
      })
    }
    if (error instanceof NoSupportedActionError) {
      return reobserveForRetry(input, state, {
        note: 'The Decision model rejected every proposed action as unsafe or unsupported. Propose different actions from this fresh snapshot.',
        step: 're-observed the page after the Decision model rejected every proposal',
        stop: 'Stopped: the model proposed no action it could run on this page.'
      })
    }
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
  if (state.uncertainActions.has(uncertainActionKey(decision))) {
    state.recoveryNote = `${UNCERTAIN_ACTION_NOTE} Do not repeat that action; it may have run.`
    input.onStep('Skipped an action that the page did not confirm.')
    return undefined
  }
  if (isNavigateToCurrentPage(decision, input.activeUrl())) {
    return stayOnPage(input, state, decision)
  }
  if (skipUnchangedDuplicate(input, state, decision)) {
    return state.noChangeCount >= MAX_NO_CHANGE
      ? fallback(
          `Stopped: the model kept repeating "${stepLabel(decision)}" on a page that did not change.`,
          state.handoffs
        )
      : undefined
  }
  return performSemanticAction(context, decision, step)
}

/** Not reloading the page the task is on: what was filled stays. Counts as no progress. */
function stayOnPage(
  input: BrowserPlaywrightTaskInput,
  state: SemanticLoopState,
  decision: SemanticDecision
): BrowserPlaywrightTaskResult | undefined {
  state.noChangeCount += 1
  state.recoveryNote =
    'You are already on that page. Do not navigate or reload it; act on this snapshot.'
  input.onStep(`stayed on the page instead of reloading it (${stepLabel(decision)})`)
  remember(state, `${stepLabel(decision)} -> not done: you are already on that page`)
  return state.noChangeCount >= MAX_NO_CHANGE
    ? fallback(
        'Stopped: the model kept trying to reload the page it is already on.',
        state.handoffs
      )
    : undefined
}

/**
 * What the user reads when the task is done: the answer itself. Found live: "Found the title of
 * the top story" with the title only in the evidence. browser-use's done carries the final
 * answer; here the proven evidence joins the summary when the summary does not already hold it.
 */
/**
 * Evidence as a person reads it: a snapshot line such as `strong [ref=e2079]: 117.6k` becomes
 * `117.6k` (found live in an answer).
 */
export function readableEvidence(raw: string | null | undefined): string {
  const text = (raw ?? '').trim()
  const value = /\[ref=[^\]]+\]\s*:\s*(.+)$/.exec(text)?.[1] ?? text
  return value
    .replace(/\s*\[ref=[^\]]+\]/g, '')
    .replace(/^"(.*)"$/, '$1')
    .trim()
}

export function completionSummary(
  decision: Pick<SemanticDecision, 'summary' | 'evidence_text'>
): string {
  const summary = decision.summary.trim() || 'The web task is complete.'
  const evidence = readableEvidence(decision.evidence_text)
  return evidence && !summary.toLowerCase().includes(evidence.toLowerCase())
    ? `${summary}\n"${evidence}"`
    : summary
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
    const summary = completionSummary(decision)
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
  remember(state, `handed to the user: ${why} -> the user has finished; check the page`)
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
  state.recoveryNote = stallNote(
    state,
    'The previous action was a duplicate on an unchanged page. Choose a different action.'
  )
  input.onStep(`no change: skipped duplicate ${actionLabel(decision)}`)
  remember(state, `${stepLabel(decision)} -> skipped: the same as the last action, page unchanged`)
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
    const text = error instanceof Error ? error.message : String(error)
    if (!lease.signal.aborted && isUncertainActionTimeout(decision, text)) {
      result = { text, isError: false, uncertain: true }
    } else {
      if (!lease.signal.aborted) throw error
      input.onStep('cancelled an in-flight action after input control changed')
      state.observation = await observeWithCurrentLease(input)
      return undefined
    }
  }
  if (!input.guard.ownsActionLease(lease.epoch)) {
    input.onStep('discarded a late action result after input control changed')
    state.observation = await observeWithCurrentLease(input)
    return undefined
  }
  if (
    isUncertainPageResult(result) ||
    (result.isError && isUncertainActionTimeout(decision, result.text))
  ) {
    await handleUncertainAction(context, decision, step)
    return undefined
  }
  state.uncertainCount = 0
  const label = stepLabel(decision)
  input.onStep(`${label}: ${result.isError ? 'not completed' : 'completed'}`)
  if (result.isError) {
    remember(state, `${label} -> failed: ${result.text}`)
    return recoverActionError(input, state, result)
  }

  const before = fingerprint(state.observation.text)
  state.observation = await observeWithCurrentLease(input)
  const recovery = await recoverObservationError(input, state)
  if (recovery === 'recovered') return undefined
  if (recovery) return recovery
  await publishObservation(input, { step, phase: 'checking', summary: actionLabel(decision) })
  updateProgressEvidence(context, { decision, actionKey, before })
  remember(
    state,
    `${label} -> ${fingerprint(state.observation.text) === before ? 'no visible change' : 'the page changed'}`
  )
  return state.noChangeCount >= MAX_NO_CHANGE
    ? fallback(
        `Stopped: the page did not change for ${MAX_NO_CHANGE} steps in a row. Last: "${label}".`,
        state.handoffs
      )
    : undefined
}

async function handleUncertainAction(
  context: SemanticLoopContext,
  decision: SemanticDecision,
  step: number
): Promise<void> {
  const { input, state } = context
  state.uncertainActions.add(uncertainActionKey(decision))
  remember(state, `${stepLabel(decision)} -> not confirmed by the page; it may have run`)
  state.uncertainCount = isInputAction(decision) ? state.uncertainCount + 1 : 0
  input.onStep(UNCERTAIN_ACTION_NOTE)
  state.observation = await observeWithCurrentLease(input)
  if (state.observation.isError) {
    throw new Error(
      `The page could not be checked after an uncertain action: ${compact(state.observation.text)}`
    )
  }
  await publishObservation(input, { step, phase: 'checking', summary: UNCERTAIN_ACTION_NOTE })
  if (state.uncertainCount >= 2) {
    await performHumanHandoff(
      context,
      {
        ...decision,
        reason: 'The page did not confirm two actions. Check the page and tell me how to continue.'
      },
      step
    )
    state.uncertainCount = 0
  }
  state.recoveryNote = `${UNCERTAIN_ACTION_NOTE} Do not repeat the action; it may have run.`
}

/** The model writes its summary as a sentence; drop its full stop before a status joins it. */
function stepLabel(decision: SemanticDecision): string {
  return actionLabel(decision).replace(/[.!]+$/, '')
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

/**
 * Re-observe and let the model try again with a recovery note. On a page that did not change
 * this counts as no progress, so a model that keeps citing a ref the page never had, or a
 * Decision model that keeps rejecting every proposal, stops at the no-progress limit instead
 * of using every step.
 */
async function reobserveForRetry(
  input: BrowserPlaywrightTaskInput,
  state: SemanticLoopState,
  why: { readonly note: string; readonly step: string; readonly stop: string }
): Promise<BrowserPlaywrightTaskResult | undefined> {
  state.observation = await observeWithCurrentLease(input)
  const after = fingerprint(state.observation.text)
  state.noChangeCount = after === state.lastFingerprint ? state.noChangeCount + 1 : 0
  state.lastFingerprint = after
  if (state.noChangeCount >= MAX_NO_CHANGE) {
    return fallback(why.stop, state.handoffs)
  }
  state.recoveryNote = stallNote(state, why.note)
  input.onStep(why.step)
  return undefined
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
    return reobserveForRetry(input, state, {
      note: 'The element reference became stale. Use only a reference from this fresh snapshot.',
      step: 're-observed the page after a stale element reference',
      stop: 'Stopped: the model kept acting on page elements that are no longer there.'
    })
  }
  // A refused or failed action (a disabled button, a field the agent may not type in, a
  // Playwright timeout) usually leaves the page as it was. Say why and let the model choose
  // again; the no-progress limit still ends a task that keeps failing.
  const why = compact(result.text)
  return reobserveForRetry(input, state, {
    note: `The last action failed: ${why} Choose a different action from this fresh snapshot.`,
    step: `re-observed the page after the action failed: ${why}`,
    stop: `Stopped: ${why}`
  })
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
  return fallback(
    `The page could not be read after the action: ${compact(state.observation.text)}`,
    state.handoffs
  )
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
  state.recoveryNote = stallNote(
    state,
    'The last action did not change the page. Verify the goal or choose a different control.'
  )
  input.onStep(`no visible change after ${actionLabel(decision)}`)
}
