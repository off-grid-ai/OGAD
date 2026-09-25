/**
 * The element-picking loop (R5 T1b): snapshot the interactive elements ->
 * the model picks one by number -> act, until done, given up, or out of steps.
 * The same shape as the browser rail's web-task loop, but over an element list
 * instead of a web page - so it drives the accessibility rail AND, later, the
 * set-of-marks tier (a detected box is just an element with no AX role). One
 * loop, two surfaces; do not fork a third.
 *
 * Every boundary injected - the reader (elements), the model (decide), the
 * actuator - so the control flow is fully unit-tested without a screen. The
 * model picks by LABEL (a text task), which is exactly what lets a normal chat
 * model drive this without a grounder.
 */
import type { AxElement, AxSnapshot } from './ax-elements'
import { formatAxElementsForModel } from './ax-elements'
import { extractJsonObject } from '../json-extract'
import {
  computerUseHistoryTokenBudget,
  tailWithinTokenBudget
} from '../../shared/computer-use-settings'
import {
  taskExecutionPlanProgress,
  type TaskExecutionPhase,
  type TaskExecutionPlan
} from '../../shared/task-execution-plan'
import {
  createTaskPhaseReporter,
  formatTaskExecutionPlanContext
} from '../tasks/task-execution-plan-service'
import { TASK_GUIDANCE_TRACE } from '../tasks/task-guide'
import { CurrentTaskBrief } from '../tasks/current-task-brief'
import type { GuardSnapshot } from '../vision/vision-guard'
import type { ComputerUseVerificationResult } from './ax-state'

export interface ElementActuator {
  /** Click at the element's center. */
  click(el: AxElement): Promise<void>
  /** Move the pointer to the element without clicking, for nested menus. */
  hover?(el: AxElement): Promise<void>
  /** AXPress the element (preferred when it exposes a press action). */
  press(el: AxElement): Promise<void>
  /** Scroll the view under the element. The element is an anchor, not a click target. */
  scroll?(el: AxElement, direction: 'up' | 'down' | 'left' | 'right'): Promise<void>
  /** Set a native value-aware control without guessing a pointer coordinate. */
  setValue?(el: AxElement, value: number): Promise<void>
  /** Type text. With an element, focus it first (click its center); a null
   *  element types into whatever the app already has focused - which is how a
   *  general model drives a compose box it cannot pick out of the element list. */
  type(el: AxElement | null, text: string): Promise<void>
  /** A key or combo to the focused UI: "Enter", "cmd k", "cmd shift g". */
  keys(combo: string): Promise<void>
}

export interface ElementTaskDeps {
  read(): Promise<AxSnapshot>
  actuator: ElementActuator
  /** Goal + numbered elements + the current frame in, one step decision out. */
  decide: (prompt: string, screenshotPath?: string) => Promise<string>
  /** Optional typed-decision path. It receives the exact observation so it
   * does not need to parse the rendered element list back into controls. */
  decideElement?: (
    prompt: string,
    snapshot: AxSnapshot,
    phase?: TaskExecutionPhase,
    allowCompletion?: boolean,
    pendingSubmit?: boolean
  ) => Promise<string>
  /** Re-read the bound window before mutation. False rejects a stale action. */
  validateAction?: (snapshot: AxSnapshot, step: ElementStep) => Promise<boolean>
  /** Deterministic bounded postcondition verification after one mutation. */
  verifyAction?: (snapshot: AxSnapshot, step: ElementStep) => Promise<ComputerUseVerificationResult>
  screenshotPath?: () => string | undefined
  onStep?: (note: string) => void
  onObservation?: (observation: ElementStepObservation) => void
  onCheckpoint?: (step: number, steps: readonly string[]) => void
  maxSteps?: number
  contextTokens?: number
  checkpointInterval?: number
  retrievedFacts?: string[]
  now?: () => number
  plan?: TaskExecutionPlan
  resumedSteps?: readonly string[]
  initialStep?: number
  onPhase?: (phaseId: string) => void
  takeGuidance?: () => readonly string[]
  /** Long-running tasks can require continued useful work until their session
   *  boundary. Model completion claims are deferred while this returns false. */
  completionAllowed?: () => boolean
  /** Park this same task when a private step needs the user. Continue returns
   * the loop to a fresh Accessibility observation. */
  waitForUser: (why: string, signal?: AbortSignal) => Promise<void>
  /** Use vision for one recovery action, then continue this same AX loop. */
  recoverWithVision?: (recovery: {
    summary: string
    steps: readonly string[]
    guidance: readonly string[]
    currentStep: number
  }) => Promise<{
    ok: boolean
    detail?: string
    activePhaseIndex?: number
    completed?: boolean
    summary?: string
    submittedDraft?: boolean
  }>
  signal?: AbortSignal
  /** The Computer Use task owner. The loop checks it after every external wait,
   *  so Pause parks before another action and Stop cannot be overwritten by a
   *  late observation or model reply. */
  control?: ElementTaskControl
}

export interface ElementTaskControl {
  snapshot(): Pick<GuardSnapshot, 'status' | 'reason' | 'inputLease'>
  waitUntilRunnable(signal?: AbortSignal): Promise<Pick<GuardSnapshot, 'status' | 'reason'>>
  markObservationReady(): boolean
  readonly isVerifying: boolean
  beginVerification(): boolean
  complete(): boolean
  fail(message: string): boolean
}

export interface ElementTaskResult {
  ok: boolean
  summary: string
  steps: string[]
  recovery?: 'vision'
  guidance?: readonly string[]
}

export type ElementStep =
  | { action: 'click'; index: number }
  | { action: 'hover'; index: number }
  | { action: 'press'; index: number }
  | { action: 'scroll'; index: number; direction: 'up' | 'down' | 'left' | 'right' }
  | { action: 'set_value'; index: number; value: number }
  // index is OPTIONAL: a general model often cannot pick the compose box out of
  // the list and types into the focused field. submitKeys carries a trailing
  // "Enter" so "type hi and send" lands in one step (how the model phrases it).
  | { action: 'type'; index?: number; text: string; submitKeys?: string }
  | { action: 'key'; keys: string }
  | { action: 'wait'; durationMs: number }
  | { action: 'human_required'; why: string }
  | { action: 'vision_required'; why: string }
  | { action: 'milestone_complete'; summary: string }
  | { action: 'done'; summary: string }
  | { action: 'give_up'; why: string }

export interface ElementStepObservation {
  step: number
  prompt: string
  retrievedFacts: string[]
  rawResponse?: string
  parsedAction?: ElementStep | null
  verification?: ComputerUseVerificationResult
  durationMs: number
  result:
    | 'parse_failed'
    | 'actuated'
    | 'terminal'
    | 'handoff'
    | 'skipped'
    | 'invalid_target'
    | 'error'
  error?: string
}

/** Grammar the model is constrained to (llama.cpp -> GBNF): always parses or
 *  the call fails, never free text. */
export const ELEMENT_STEP_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'element_step',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'click',
            'hover',
            'press',
            'scroll',
            'set_value',
            'type',
            'key',
            'wait',
            'human_required',
            'vision_required',
            'milestone_complete',
            'done',
            'give_up'
          ]
        },
        index: { type: 'integer' },
        text: { type: 'string' },
        keys: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        value: { type: 'number' },
        durationMs: { type: 'integer' },
        summary: { type: 'string' },
        why: { type: 'string' }
      },
      required: ['action']
    }
  }
} as const

/** Fail-closed parse: unknown shapes are null; the loop re-observes rather than
 *  acting on a guess. Tolerant of a reasoning/fence wrapper (see
 *  extractJsonObject) so a general chat model drives this, not just a grounder. */
export function parseElementStep(raw: string): ElementStep | null {
  const json = extractJsonObject(raw)
  if (json === null) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const value = parsed as Record<string, unknown>
  const idx = typeof value.index === 'number' ? value.index : undefined
  const str = (k: string): string | undefined =>
    typeof value[k] === 'string' && (value[k] as string).length > 0
      ? (value[k] as string)
      : undefined
  switch (value.action) {
    case 'click':
      return idx !== undefined ? { action: 'click', index: idx } : null
    case 'hover':
      return idx !== undefined ? { action: 'hover', index: idx } : null
    case 'press':
      return idx !== undefined ? { action: 'press', index: idx } : null
    case 'scroll': {
      const direction = str('direction')
      return idx !== undefined &&
        (direction === 'up' ||
          direction === 'down' ||
          direction === 'left' ||
          direction === 'right')
        ? { action: 'scroll', index: idx, direction }
        : null
    }
    case 'set_value': {
      const targetValue = typeof value.value === 'number' ? value.value : undefined
      return idx !== undefined && targetValue !== undefined && Number.isFinite(targetValue)
        ? { action: 'set_value', index: idx, value: targetValue }
        : null
    }
    case 'type': {
      // text is required; index is OPTIONAL (type into the focused field when
      // omitted). A "keys"/"key" on a type step is a trailing submit ("Enter").
      const text = typeof value.text === 'string' ? value.text : undefined
      if (text === undefined) {
        return null
      }
      const submitKeys = str('keys') ?? str('key')
      return {
        action: 'type',
        text,
        ...(idx !== undefined ? { index: idx } : {}),
        ...(submitKeys ? { submitKeys } : {})
      }
    }
    case 'key': {
      const keys = str('keys')
      return keys ? { action: 'key', keys } : null
    }
    case 'wait': {
      const durationMs = typeof value.durationMs === 'number' ? value.durationMs : undefined
      return durationMs !== undefined &&
        Number.isInteger(durationMs) &&
        durationMs >= 0 &&
        durationMs <= 5_000
        ? { action: 'wait', durationMs }
        : null
    }
    case 'done':
      return { action: 'done', summary: str('summary') ?? 'done' }
    case 'milestone_complete':
      return { action: 'milestone_complete', summary: str('summary') ?? 'milestone complete' }
    case 'human_required':
      return { action: 'human_required', why: str('why') ?? 'Complete this step' }
    case 'vision_required':
      return { action: 'vision_required', why: str('why') ?? 'Visual grounding is required' }
    case 'give_up':
      return { action: 'give_up', why: str('why') ?? 'could not finish' }
    default:
      return null
  }
}

export function buildElementPrompt(input: {
  goal: string
  snapshot: AxSnapshot
  history: string[]
  retrievedFacts?: readonly string[]
  contextTokens?: number
  plan?: TaskExecutionPlan
  guidance?: readonly string[]
}): string {
  const { goal, snapshot, history } = input
  const retrievedFacts = input.retrievedFacts ?? []
  const contextTokens = input.contextTokens ?? 2_048
  const boundedHistory = tailWithinTokenBudget(
    history,
    computerUseHistoryTokenBudget(contextTokens)
  ).slice(-4)
  return [
    'Operate the supplied app one step at a time.',
    `Task: ${goal}`,
    input.plan ? formatTaskExecutionPlanContext(input.plan) : '',
    input.guidance?.length
      ? `Authoritative user guidance for the next decision:\n${input.guidance.map((item) => `- ${item}`).join('\n')}`
      : '',
    '',
    formatAxElementsForModel(snapshot),
    '',
    retrievedFacts.length
      ? `Older task outcomes (text only; may be stale):\n${retrievedFacts.join('\n')}`
      : '',
    boundedHistory.length ? `Previous steps:\n${boundedHistory.join('\n')}` : '',
    'Return exactly one JSON action:',
    '- Click or press an element: {"action":"click","index":N} or {"action":"press","index":N}.',
    '- Scroll the view under an element: {"action":"scroll","index":N,"direction":"up"}.',
    '- Enter text: {"action":"type","index":N,"text":"..."}. Omit index only when the correct field is already focused. Add "keys":"Enter" to submit.',
    '- Send keys: {"action":"key","keys":"Enter"}.',
    '- Wait only while the interface is changing: {"action":"wait","durationMs":250}.',
    '- Use human_required for sign-in, passwords, one-time codes, or payment.',
    '- Use vision_required when the next safe step needs visual grounding or free-form text entry.',
    '- Use done only when the goal is visibly complete. Use give_up only when it cannot be completed.',
    '- For an edit, change, or replacement, verify that the original item changed. A new copy elsewhere is not completion.',
    'Match the exact target and intended control. Navigation fields are not content fields.',
    'If text is already entered, submit it without typing it again. If an action had no effect, choose a different action.',
    'Reply with JSON only.'
  ]
    .filter(Boolean)
    .join('\n')
}

const DECISION_OBJECTIVE_CHARS = 480
const DECISION_GUIDANCE_CHARS = 120
const DECISION_HISTORY_CHARS = 160
const DECISION_STATE_CHARS = 280

function boundedDecisionText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

function decisionObjective(goal: string): string {
  const marker = 'Structured task summary:\n'
  const summary = goal.includes(marker)
    ? goal.slice(goal.lastIndexOf(marker) + marker.length)
    : goal
  return boundedDecisionText(summary, DECISION_OBJECTIVE_CHARS)
}

/** Preserve compact observable state for the small local decider. Values,
 * focus, selection, and checked state describe what is true now without
 * semantically choosing a control or action for the model. */
function decisionState(snapshot: AxSnapshot): string {
  const state = snapshot.elements
    .filter(
      (element) =>
        element.enabled &&
        element.executable !== false &&
        ((Boolean(element.value) && typeof element.checked !== 'boolean') ||
          element.focused === true ||
          element.selected === true ||
          element.checked === true)
    )
    .slice(0, 4)
    .map((element) => {
      const identity = [element.role, element.name ? JSON.stringify(element.name) : '']
        .filter(Boolean)
        .join(' ')
      const facts = [
        element.value ? `value=${JSON.stringify(boundedDecisionText(element.value, 80))}` : '',
        element.focused === true ? 'focused' : '',
        element.selected === true ? 'selected' : '',
        element.checked === true ? 'checked=true' : ''
      ].filter(Boolean)
      return `${identity} ${facts.join(' ')}`.trim()
    })
  return boundedDecisionText(state.join('; '), DECISION_STATE_CHARS)
}

/** Keep the A-J Decider packet within Laya's small useful context. The selected
 * decision level supplies its complete choices, so the AX tree must not be
 * repeated in the context. */
export function buildElementDecisionContext(input: {
  goal: string
  milestone?: string
  operation?: TaskExecutionPhase['operation']
  snapshot: AxSnapshot
  history: readonly string[]
  guidance?: readonly string[]
}): string {
  const target = [input.snapshot.processName, input.snapshot.windowTitle]
    .filter(Boolean)
    .join(' / ')
  const previous = input.history.slice(-2)
  const guidance = (input.guidance ?? []).map((item) => item.trim()).filter(Boolean)
  const operation = input.operation
    ? [
        `kind=${input.operation.kind}`,
        input.operation.target ? `target=${JSON.stringify(input.operation.target)}` : '',
        input.operation.value ? `value=${JSON.stringify(input.operation.value)}` : ''
      ]
        .filter(Boolean)
        .join(' ')
    : ''
  const currentState = decisionState(input.snapshot)
  return [
    `Current milestone: ${boundedDecisionText(input.milestone ?? decisionObjective(input.goal), DECISION_OBJECTIVE_CHARS)}`,
    operation ? `Planned operation: ${operation}` : '',
    target ? `Target application/window: ${target}` : '',
    currentState ? `Current structured state: ${currentState}` : '',
    `Available structured controls: ${input.snapshot.elements.filter((element) => element.enabled && element.executable !== false).length}`,
    previous.length
      ? `Previous action and verification: ${boundedDecisionText(previous.join(' | '), DECISION_HISTORY_CHARS)}`
      : '',
    guidance.length
      ? `Current authoritative guidance: ${boundedDecisionText(guidance.join(' | '), DECISION_GUIDANCE_CHARS)}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

const MAX_CONSECUTIVE_PARSE_FAILURES = 3
const MAX_CONSECUTIVE_NO_PROGRESS = 3
export const AX_INVALID_REPLY_SUMMARY = `The action model returned an invalid reply ${MAX_CONSECUTIVE_PARSE_FAILURES} times in a row.`
export const AX_NO_PROGRESS_SUMMARY = 'The action did not produce its required result.'

/** A stable signature of an actuating step, used to detect a runaway loop. Two
 *  consecutive identical signatures mean the model is repeating itself (it sent
 *  the message, did not notice, and is sending it again) - the rail halts rather
 *  than actuate the duplicate. Terminal actions (done/give_up) have none. */
export function actionSignature(step: ElementStep): string | null {
  switch (step.action) {
    case 'click':
      return `click:${step.index}`
    case 'hover':
      return `hover:${step.index}`
    case 'press':
      return `press:${step.index}`
    case 'scroll':
      return `scroll:${step.index}:${step.direction}`
    case 'set_value':
      return `set_value:${step.index}:${step.value}`
    case 'type':
      return `type:${step.index ?? 'focus'}:${step.text}:${step.submitKeys ?? ''}`
    case 'key':
      return `key:${step.keys}`
    case 'wait':
      return `wait:${step.durationMs}`
    default:
      return null
  }
}

/** Identify equivalent actionable state without relying on a transient display
 * index or observation revision. Focus is omitted because it can change as a
 * side effect without proving progress toward the task. */
export function observationStateSignature(snapshot: AxSnapshot): string {
  const elements = snapshot.elements
    .map((element) => ({
      id:
        element.stableId ??
        `${element.role}:${element.name}:${element.x ?? element.cx}:${element.y ?? element.cy}`,
      role: element.role,
      name: element.name,
      value: element.value,
      checked: element.checked,
      selected: element.selected,
      enabled: element.enabled,
      executable: element.executable !== false
    }))
    .sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify({
    processId: snapshot.processId,
    windowId: snapshot.windowId,
    title: snapshot.windowTitle,
    elements
  })
}

function boundMutationSignature(snapshot: AxSnapshot, step: ElementStep): string | null {
  const signature = actionSignature(step)
  if (!signature || step.action === 'wait') return null
  if (
    step.action !== 'click' &&
    step.action !== 'hover' &&
    step.action !== 'press' &&
    step.action !== 'scroll' &&
    step.action !== 'set_value' &&
    step.action !== 'type'
  ) {
    return signature
  }
  if (step.index === undefined) return signature
  const target = snapshot.elements.find((element) => element.index === step.index)
  if (!target) return signature
  return `${step.action}:${target.stableId ?? `${target.role}:${target.name}:${target.cx}:${target.cy}`}${
    step.action === 'type'
      ? `:${step.text}:${step.submitKeys ?? ''}`
      : step.action === 'set_value'
        ? `:${step.value}`
        : ''
  }`
}

function isSubmitKey(keys: string): boolean {
  return /(^|\s)(enter|return)(\s|$)/i.test(keys)
}

function isEditableElement(element: AxElement): boolean {
  return /^(?:AXTextField|AXTextArea|Edit|Document|ComboBox)$/i.test(element.role)
}

/* eslint-disable complexity -- one state machine; per-action helpers would hide
   the observe/act/stop control flow the tests pin down. */
export async function runElementTask(
  goal: string,
  deps: ElementTaskDeps
): Promise<ElementTaskResult> {
  const { read, actuator, decide, onStep } = deps
  const maxSteps = deps.maxSteps ?? Number.POSITIVE_INFINITY
  const checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
  const retrievedFacts = deps.retrievedFacts ?? []
  const now = deps.now ?? Date.now
  const steps: string[] = [...(deps.resumedSteps ?? [])]
  const reportPhase = createTaskPhaseReporter(deps.plan, deps.onPhase)
  let activePhaseIndex = taskExecutionPlanProgress(steps)?.activePhaseIndex ?? 0
  let continuingAfterFinalPhase = false
  let activePhaseActed = false
  reportPhase(activePhaseIndex)
  const note = (line: string): void => {
    steps.push(line)
    onStep?.(line)
  }
  let lastActionSig: string | null = null
  // Texts already typed this run. Re-typing the SAME text - even into a
  // different index - means the model already sent it and is looping; the
  // signature guard misses this because the composer's index changes after each
  // send (type[74]->Enter->type[71]->Enter...), an A-B-A-B loop the consecutive
  // check can't see.
  const typedTexts = new Set<string>()
  // A type action without Enter only changes the draft. Do not accept a model
  // claim that the task is done until a later action submits that draft.
  let draftAwaitingSubmit = false
  const taskBrief = new CurrentTaskBrief(goal)
  let consecutiveParseFailures = 0
  let consecutiveNoProgress = 0
  let currentObservationKey = ''
  const recoveredObservationKeys = new Set<string>()
  const attemptedMutations = new Set<string>()
  const recoverWithVision = async (
    summary: string,
    currentStep: number
  ): Promise<ElementTaskResult | null> => {
    if (!deps.recoverWithVision) {
      return {
        ok: false,
        summary,
        steps,
        recovery: 'vision',
        guidance: [...taskBrief.guidance]
      }
    }
    if (currentObservationKey && recoveredObservationKeys.has(currentObservationKey)) {
      return {
        ok: false,
        summary: 'Computer Use stopped because recovery already ran for this unchanged state.',
        steps
      }
    }
    if (currentObservationKey) recoveredObservationKeys.add(currentObservationKey)
    const recovery = await deps.recoverWithVision({
      summary,
      steps,
      guidance: [...taskBrief.guidance],
      currentStep
    })
    if (!recovery.ok) {
      return {
        ok: false,
        summary: `Computer Use could not make progress. Vision recovery could not continue${recovery.detail ? `: ${recovery.detail}` : '.'}`,
        steps
      }
    }
    if (recovery.completed) {
      const summary = recovery.summary ?? 'The requested result is visible.'
      note(`done: ${summary}`)
      return { ok: true, summary, steps }
    }
    let advancedPhase = false
    if (deps.plan && recovery.activePhaseIndex !== undefined) {
      const recoveredPhaseIndex = Math.max(
        0,
        Math.min(recovery.activePhaseIndex, deps.plan.phases.length - 1)
      )
      if (recoveredPhaseIndex > activePhaseIndex) {
        advancedPhase = true
        activePhaseIndex = recoveredPhaseIndex
        activePhaseActed = false
        reportPhase(activePhaseIndex)
      }
    }
    if (recovery.submittedDraft || advancedPhase) draftAwaitingSubmit = false
    // The recovery action belongs to the phase that just completed. A newly
    // activated phase still needs its own action before it can complete.
    if (!advancedPhase) activePhaseActed = true
    note('Vision recovery completed one action. Returning to accessibility control.')
    consecutiveParseFailures = 0
    consecutiveNoProgress = 0
    lastActionSig = null
    return null
  }
  const requireFreshVerification = (): void => {
    if (deps.control && !deps.control.isVerifying) deps.control.beginVerification()
  }
  const handleVerification = async (
    verification: ComputerUseVerificationResult | undefined,
    currentStep: number
  ): Promise<ElementTaskResult | 'recovered' | null> => {
    if (!verification) return null
    if (verification.status === 'satisfied') {
      consecutiveNoProgress = 0
      note('action effect confirmed; re-observe the required milestone result')
      return null
    }
    consecutiveNoProgress += 1
    if (verification.status === 'unknown' || verification.status === 'timeout') {
      note(
        `verification ${verification.status}; the mutation will not be replayed; re-observing after the unconfirmed result`
      )
      return null
    }
    note(`verification ${verification.status}; the mutation will not be replayed`)
    note(AX_NO_PROGRESS_SUMMARY)
    const failedRecovery = await recoverWithVision(AX_NO_PROGRESS_SUMMARY, currentStep)
    return failedRecovery ?? 'recovered'
  }

  const waitForControl = async (): Promise<ElementTaskResult | null> => {
    const before = deps.control?.snapshot()
    const after =
      before?.status === 'paused' || before?.status === 'waiting_for_user'
        ? await deps.control?.waitUntilRunnable(deps.signal)
        : before
    if (!after || !['completed', 'failed', 'stopped'].includes(after.status)) return null
    const summary = after.reason || 'stopped'
    return { ok: after.status === 'completed', summary, steps }
  }

  const initialStep = Math.max(0, Math.floor(deps.initialStep ?? 0))
  for (let step = initialStep; step < maxSteps; step += 1) {
    const stoppedBeforeStep = await waitForControl()
    if (stoppedBeforeStep) return stoppedBeforeStep
    const planningStep = step + 1
    const startedAt = now()
    let prompt = ''
    let modelPrompt = ''
    let rawResponse: string | undefined
    let decision: ElementStep | null | undefined
    let verificationResult: ComputerUseVerificationResult | undefined
    let observed = false
    const observe = (result: ElementStepObservation['result'], error?: string): void => {
      if (observed) return
      observed = true
      deps.onObservation?.({
        step: planningStep,
        prompt,
        retrievedFacts,
        rawResponse,
        parsedAction: decision,
        ...(verificationResult ? { verification: verificationResult } : {}),
        durationMs: now() - startedAt,
        result,
        error
      })
    }
    const checkpoint = (): void => {
      if (planningStep % checkpointInterval === 0) {
        deps.onCheckpoint?.(planningStep, steps)
      }
    }
    try {
      const snapshot = await read()
      currentObservationKey = observationStateSignature(snapshot)
      const stoppedAfterRead = await waitForControl()
      if (stoppedAfterRead) return stoppedAfterRead
      if (deps.control && !deps.control.markObservationReady()) continue
      taskBrief.accept(deps.takeGuidance?.() ?? [])
      const activePhase = continuingAfterFinalPhase
        ? undefined
        : deps.plan?.phases[activePhaseIndex]
      const activeMilestone = activePhase?.title
      modelPrompt = buildElementPrompt({
        goal: taskBrief.objective,
        snapshot,
        history: steps,
        retrievedFacts,
        contextTokens: deps.contextTokens,
        plan: deps.plan
      })
      const decisionPrompt = deps.decideElement
        ? buildElementDecisionContext({
            goal: taskBrief.objective,
            milestone: activeMilestone,
            operation: activePhase?.operation,
            snapshot,
            history: steps,
            guidance: taskBrief.guidance
          })
        : modelPrompt
      prompt = taskBrief.guidance.reduce(
        (safePrompt, privateText) => safePrompt.split(privateText).join(TASK_GUIDANCE_TRACE),
        decisionPrompt
      )
      const decisionLeaseEpoch = deps.control?.snapshot().inputLease.epoch
      rawResponse = deps.decideElement
        ? await deps.decideElement(
            decisionPrompt,
            snapshot,
            activePhase,
            activePhaseActed,
            draftAwaitingSubmit
          )
        : await decide(modelPrompt, deps.screenshotPath?.())
      const stoppedAfterDecision = await waitForControl()
      if (stoppedAfterDecision) return stoppedAfterDecision
      const controlAfterDecision = deps.control?.snapshot()
      if (
        decisionLeaseEpoch !== undefined &&
        controlAfterDecision &&
        (controlAfterDecision.inputLease.epoch !== decisionLeaseEpoch ||
          controlAfterDecision.inputLease.owner !== 'agent')
      ) {
        observe('skipped')
        note('control changed during model work; re-observing before the next action')
        checkpoint()
        continue
      }
      const parsedDecision = parseElementStep(rawResponse)
      decision = parsedDecision
      if (!parsedDecision) {
        consecutiveParseFailures += 1
        observe('parse_failed')
        note('model reply did not parse; re-observing')
        checkpoint()
        if (consecutiveParseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
          const summary = AX_INVALID_REPLY_SUMMARY
          note(summary)
          const failedRecovery = await recoverWithVision(summary, planningStep)
          if (failedRecovery) return failedRecovery
          continue
        }
        continue
      }
      consecutiveParseFailures = 0
      const action = parsedDecision
      if (action.action === 'milestone_complete') {
        const verifiedFieldValue =
          deps.plan?.phases[activePhaseIndex]?.completion?.kind === 'field_value'
        if (draftAwaitingSubmit && !verifiedFieldValue) {
          observe('skipped')
          note('milestone completion rejected: text is still a draft')
          checkpoint()
          consecutiveNoProgress += 1
          if (consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
            note(AX_NO_PROGRESS_SUMMARY)
            const failedRecovery = await recoverWithVision(AX_NO_PROGRESS_SUMMARY, planningStep)
            if (failedRecovery) return failedRecovery
          }
          continue
        }
        // Laya can propose completion, but it must not verify its own semantic
        // claim. Ask the heavy reasoner to review fresh evidence before the
        // lifecycle owner advances the plan. The grounding specialist remains
        // reserved for target localization and recovery actions.
        if (deps.decideElement) {
          const reviewLeaseEpoch = deps.control?.snapshot().inputLease.epoch
          const reviewPrompt = [
            'Independently verify the current milestone from fresh visible evidence.',
            'Do not infer completion from an attempted action or from a generic UI change.',
            `Task: ${taskBrief.objective}`,
            activePhase ? `Current milestone: ${activePhase.title}` : '',
            activePhase?.operation
              ? `Required operation: ${JSON.stringify(activePhase.operation)}`
              : '',
            activePhase?.completion
              ? `Completion condition: ${JSON.stringify(activePhase.completion)}`
              : '',
            formatAxElementsForModel(snapshot, 60),
            'If the evidence proves the milestone, return {"action":"milestone_complete","summary":"..."}.',
            'Otherwise return {"action":"vision_required","why":"the missing evidence"}.',
            'Return JSON only.'
          ]
            .filter(Boolean)
            .join('\n')
          const reviewRaw = await decide(reviewPrompt, deps.screenshotPath?.())
          const stoppedAfterReview = await waitForControl()
          if (stoppedAfterReview) return stoppedAfterReview
          const controlAfterReview = deps.control?.snapshot()
          if (
            reviewLeaseEpoch !== undefined &&
            controlAfterReview &&
            (controlAfterReview.inputLease.epoch !== reviewLeaseEpoch ||
              controlAfterReview.inputLease.owner !== 'agent')
          ) {
            observe('skipped')
            note('control changed during milestone review; re-observing')
            checkpoint()
            continue
          }
          const review = parseElementStep(reviewRaw)
          if (review?.action !== 'milestone_complete') {
            activePhaseActed = false
            consecutiveNoProgress += 1
            observe('skipped')
            note(
              `milestone completion rejected by the heavy reasoner${
                review?.action === 'vision_required' ? `: ${review.why}` : ''
              }`
            )
            checkpoint()
            continue
          }
        }
        if (verifiedFieldValue) draftAwaitingSubmit = false
        const phaseCount = deps.plan?.phases.length ?? 1
        const completed = deps.plan?.phases[activePhaseIndex]?.title ?? action.summary
        if (activePhaseIndex + 1 < phaseCount) {
          activePhaseIndex += 1
          activePhaseActed = false
          reportPhase(activePhaseIndex)
          lastActionSig = null
          consecutiveNoProgress = 0
          observe('terminal')
          note(`milestone complete: ${completed}`)
          checkpoint()
          continue
        }
        if (deps.completionAllowed && !deps.completionAllowed()) {
          observe('skipped')
          note('completion deferred until the session limit; continue with another useful action')
          checkpoint()
          continuingAfterFinalPhase = true
          lastActionSig = null
          consecutiveNoProgress = 0
          continue
        }
        if (deps.control && !deps.control.isVerifying) {
          observe('terminal')
          note(`verification requested: ${action.summary}`)
          checkpoint()
          deps.control.beginVerification()
          continue
        }
        deps.control?.complete()
        reportPhase(phaseCount - 1)
        observe('terminal')
        note(`done: ${action.summary}`)
        checkpoint()
        return { ok: true, summary: action.summary, steps }
      }
      if (action.action === 'done') {
        if (deps.plan && !activePhaseActed) {
          observe('skipped')
          note('completion rejected: the current phase has not executed an action')
          checkpoint()
          continue
        }
        if (draftAwaitingSubmit) {
          observe('skipped')
          note('completion rejected: text is still a draft; press Enter or click Send')
          checkpoint()
          consecutiveNoProgress += 1
          if (consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
            note(AX_NO_PROGRESS_SUMMARY)
            const failedRecovery = await recoverWithVision(AX_NO_PROGRESS_SUMMARY, planningStep)
            if (failedRecovery) return failedRecovery
          }
          continue
        }
        if (deps.completionAllowed && !deps.completionAllowed()) {
          observe('skipped')
          note('completion deferred until the session limit; continue with another useful action')
          checkpoint()
          continuingAfterFinalPhase = true
          lastActionSig = null
          consecutiveNoProgress = 0
          continue
        }
        if (deps.control && !deps.control.isVerifying) {
          observe('terminal')
          note(`verification requested: ${action.summary}`)
          checkpoint()
          deps.control.beginVerification()
          continue
        }
        deps.control?.complete()
        reportPhase((deps.plan?.phases.length ?? 1) - 1)
        observe('terminal')
        note(`done: ${action.summary}`)
        checkpoint()
        return { ok: true, summary: action.summary, steps }
      }
      if (action.action === 'give_up') {
        deps.control?.fail(action.why)
        reportPhase((deps.plan?.phases.length ?? 1) - 1)
        observe('terminal')
        note(`gave up: ${action.why}`)
        checkpoint()
        return { ok: false, summary: action.why, steps }
      }
      if (action.action === 'vision_required') {
        observe('handoff')
        note(`vision required: ${action.why}`)
        checkpoint()
        const failedRecovery = await recoverWithVision(action.why, planningStep)
        if (failedRecovery) return failedRecovery
        continue
      }
      if (action.action === 'human_required') {
        observe('handoff')
        note(`handoff: ${action.why}`)
        checkpoint()
        await deps.waitForUser(action.why, deps.signal)
        const stoppedAfterHandoff = await waitForControl()
        if (stoppedAfterHandoff) return stoppedAfterHandoff
        note('resumed by the user')
        continue
      }
      // Runaway guard: the model just asked to repeat the EXACT action it already
      // did (e.g. send "hi" again). Stop before actuating the duplicate - a live
      // action like a message must never fire twice because the model looped.
      const sig = actionSignature(action)
      if (sig !== null && sig === lastActionSig && action.action !== 'scroll') {
        // Repeat of the last action: SKIP re-firing it (so a live action never
        // fires twice) but keep going - a repeat should not kill the task. The
        // user can stop a run that does not make useful progress.
        observe('skipped')
        note(
          action.action === 'type'
            ? 'text is already entered; do not type it again; press Enter or click Send if submission is required'
            : 'skipped a repeated action; choose a different action'
        )
        checkpoint()
        consecutiveNoProgress += 1
        if (consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
          note(AX_NO_PROGRESS_SUMMARY)
          const failedRecovery = await recoverWithVision(AX_NO_PROGRESS_SUMMARY, planningStep)
          if (failedRecovery) return failedRecovery
          continue
        }
        continue
      }
      lastActionSig = sig
      if (action.action === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, action.durationMs))
        observe('skipped')
        note(`waited ${action.durationMs} ms; re-observing`)
        checkpoint()
        continue
      }
      if (deps.validateAction && !(await deps.validateAction(snapshot, action))) {
        observe(
          'invalid_target',
          'The target window or observation revision changed before actuation.'
        )
        note('stale action refused; re-observing the target window')
        checkpoint()
        continue
      }
      const mutation = boundMutationSignature(snapshot, action)
      const boundMutation = mutation ? `${currentObservationKey}\n${mutation}` : null
      if (boundMutation && attemptedMutations.has(boundMutation)) {
        observe('skipped')
        note('refused a mutation that already ran against this unchanged state')
        checkpoint()
        const failedRecovery = await recoverWithVision(AX_NO_PROGRESS_SUMMARY, planningStep)
        if (failedRecovery) return failedRecovery
        continue
      }
      if (boundMutation) attemptedMutations.add(boundMutation)
      if (action.action === 'key') {
        await actuator.keys(action.keys)
        activePhaseActed = true
        if (isSubmitKey(action.keys)) draftAwaitingSubmit = false
        requireFreshVerification()
        verificationResult = await deps.verifyAction?.(snapshot, action)
        const verificationOutcome = await handleVerification(verificationResult, planningStep)
        observe('actuated')
        note(`key ${action.keys}`)
        checkpoint()
        if (verificationOutcome && verificationOutcome !== 'recovered') return verificationOutcome
        continue
      }
      if (action.action === 'type') {
        // A re-type of the same non-empty text is a loop (it already sent it and
        // did not notice); stop before actuating the duplicate, so a message is
        // never sent twice.
        const typed = action.text.trim()
        if (typed.length > 0 && typedTexts.has(typed)) {
          // Already sent this text: SKIP re-typing it (so a message is never sent
          // twice) but keep going instead of killing the task.
          observe('skipped')
          note('already typed this text; not sending it again')
          checkpoint()
          consecutiveNoProgress += 1
          if (consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS) {
            note(AX_NO_PROGRESS_SUMMARY)
            const failedRecovery = await recoverWithVision(AX_NO_PROGRESS_SUMMARY, planningStep)
            if (failedRecovery) return failedRecovery
            continue
          }
          continue
        }
        if (typed.length > 0) {
          typedTexts.add(typed)
        }
        // index is optional: focus the named field if given, else type into the
        // field the app already has focused (the common case a general model hits).
        let target: AxElement | null = null
        if (action.index !== undefined) {
          const targetIndex = action.index
          target = snapshot.elements.find((candidate) => candidate.index === targetIndex) ?? null
          if (!target) {
            observe('invalid_target')
            note(`no element [${targetIndex}] on this screen`)
            checkpoint()
            continue
          }
          if (!isEditableElement(target)) {
            const summary = `The action model tried to type into non-editable element [${targetIndex}].`
            observe('invalid_target', summary)
            note(summary)
            checkpoint()
            const failedRecovery = await recoverWithVision(summary, planningStep)
            if (failedRecovery) return failedRecovery
            continue
          }
        }
        await actuator.type(target, action.text)
        activePhaseActed = true
        note(
          target
            ? `typed into [${target.index}] ${target.name || target.role}`
            : 'typed text into the focused field'
        )
        // A trailing submit key ("Enter") sends the message in the same step.
        if (action.submitKeys) {
          await actuator.keys(action.submitKeys)
          note(`key ${action.submitKeys}`)
          if (isSubmitKey(action.submitKeys)) draftAwaitingSubmit = false
        } else {
          draftAwaitingSubmit = typed.length > 0
        }
        requireFreshVerification()
        verificationResult = await deps.verifyAction?.(snapshot, action)
        const verificationOutcome = await handleVerification(verificationResult, planningStep)
        observe('actuated')
        checkpoint()
        if (verificationOutcome && verificationOutcome !== 'recovered') return verificationOutcome
        continue
      }
      if (action.action === 'set_value') {
        const target = snapshot.elements.find((candidate) => candidate.index === action.index)
        if (!target) {
          observe('invalid_target')
          note(`no element [${action.index}] on this screen`)
          checkpoint()
          continue
        }
        if (
          !/Slider/i.test(target.role) ||
          !target.valueSettable ||
          (typeof target.minValue === 'number' && action.value < target.minValue) ||
          (typeof target.maxValue === 'number' && action.value > target.maxValue) ||
          !actuator.setValue
        ) {
          observe('invalid_target')
          note(
            `value ${action.value} is not valid for [${target.index}] ${target.name || target.role}`
          )
          checkpoint()
          continue
        }
        await actuator.setValue(target, action.value)
        activePhaseActed = true
        note(`set [${target.index}] ${target.name || target.role} to ${action.value}`)
        requireFreshVerification()
        verificationResult = await deps.verifyAction?.(snapshot, action)
        const verificationOutcome = await handleVerification(verificationResult, planningStep)
        observe('actuated')
        checkpoint()
        if (verificationOutcome && verificationOutcome !== 'recovered') return verificationOutcome
        continue
      }
      const targetIndex = action.index
      const el = snapshot.elements.find((candidate) => candidate.index === targetIndex)
      if (!el) {
        observe('invalid_target')
        note(`no element [${targetIndex}] on this screen`)
        checkpoint()
        continue
      }
      // A submenu opener needs pointer movement without selection. Other
      // controls prefer AXPress when the element exposes it.
      if (action.action === 'hover') {
        if (!actuator.hover) {
          throw new Error('Pointer hover is unavailable for this actuator.')
        }
        await actuator.hover(el)
        note(`hovered [${el.index}] ${el.name || el.role}`)
      } else if (action.action === 'scroll') {
        if (!actuator.scroll) {
          throw new Error('Scrolling is unavailable for this actuator.')
        }
        await actuator.scroll(el, action.direction)
        note(`scrolled ${action.direction} over [${el.index}] ${el.name || el.role}`)
      } else if (action.action === 'press' || el.actionable) {
        await actuator.press(el)
        note(`pressed [${el.index}] ${el.name || el.role}`)
      } else {
        await actuator.click(el)
        note(`clicked [${el.index}] ${el.name || el.role}`)
      }
      activePhaseActed = true
      if (draftAwaitingSubmit && (action.action === 'click' || action.action === 'press')) {
        draftAwaitingSubmit = false
      }
      requireFreshVerification()
      verificationResult = await deps.verifyAction?.(snapshot, action)
      const verificationOutcome = await handleVerification(verificationResult, planningStep)
      observe('actuated')
      checkpoint()
      if (verificationOutcome && verificationOutcome !== 'recovered') return verificationOutcome
    } catch (error) {
      const message = error instanceof Error ? error.message : 'accessibility step failed'
      observe('error', message)
      checkpoint()
      throw error
    }
  }

  note('ran out of steps')
  const summary = `stopped after ${maxSteps} steps without finishing`
  deps.control?.fail(summary)
  return { ok: false, summary, steps }
}
/* eslint-enable complexity */
