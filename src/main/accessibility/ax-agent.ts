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
} from '@offgrid/automation'
import { DEFAULT_COMPUTER_USE_STEP_BUDGET } from '@offgrid/automation'
import type { TaskExecutionPlan } from '@offgrid/automation'
import {
  createTaskPhaseReporter,
  formatTaskExecutionPlanContext
} from '../tasks/task-execution-plan-service'
import { TASK_GUIDANCE_TRACE } from '../tasks/task-guide'
import { TaskBrief } from '@offgrid/automation'
import type { GuardSnapshot } from '../vision/vision-guard'

export interface ElementActuator {
  /** Click at the element's center. */
  click(el: AxElement): Promise<void>
  /** AXPress the element (preferred when it exposes a press action). */
  press(el: AxElement): Promise<void>
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
  /** goal + the numbered elements + history in, one step decision out. */
  decide: (prompt: string) => Promise<string>
  onStep?: (note: string) => void
  onObservation?: (observation: ElementStepObservation) => void
  onCheckpoint?: (step: number, steps: readonly string[]) => void
  maxSteps?: number
  contextTokens?: number
  checkpointInterval?: number
  retrievedFacts?: string[]
  now?: () => number
  plan?: TaskExecutionPlan
  onPhase?: (phaseId: string) => void
  takeGuidance?: () => readonly string[]
  /** Park this same task when a private step needs the user. Continue returns
   * the loop to a fresh Accessibility observation. */
  waitForUser: (why: string, signal?: AbortSignal) => Promise<void>
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
}

export type ElementStep =
  | { action: 'click'; index: number }
  | { action: 'press'; index: number }
  // index is OPTIONAL: a general model often cannot pick the compose box out of
  // the list and types into the focused field. submitKeys carries a trailing
  // "Enter" so "type hi and send" lands in one step (how the model phrases it).
  | { action: 'type'; index?: number; text: string; submitKeys?: string }
  | { action: 'key'; keys: string }
  | { action: 'human_required'; why: string }
  | { action: 'done'; summary: string }
  | { action: 'give_up'; why: string }

export interface ElementStepObservation {
  step: number
  prompt: string
  retrievedFacts: string[]
  rawResponse?: string
  parsedAction?: ElementStep | null
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
          enum: ['click', 'press', 'type', 'key', 'human_required', 'done', 'give_up']
        },
        index: { type: 'integer' },
        text: { type: 'string' },
        keys: { type: 'string' },
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
    case 'press':
      return idx !== undefined ? { action: 'press', index: idx } : null
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
    case 'done':
      return { action: 'done', summary: str('summary') ?? 'done' }
    case 'human_required':
      return { action: 'human_required', why: str('why') ?? 'Complete this step' }
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
  )
  return [
    'You are completing a task by operating an app one step at a time.',
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
    'Rules - one action per reply, using an element [number]:',
    '- Click: {"action":"click","index":N} or {"action":"press","index":N}',
    '- Type: {"action":"type","index":N,"text":"..."} - omit "index" to type into the field that is already focused; add "keys":"Enter" to send.',
    '- Key: {"action":"key","keys":"Enter"} (or "cmd k").',
    '- Sign-in, password, one-time code, or payment: {"action":"human_required","why":"..."}. The user completes the step, then you continue this same task from a fresh screen.',
    '- Task complete: {"action":"done","summary":"..."}. Cannot be done: {"action":"give_up","why":"..."}.',
    '- STOP as soon as the goal is achieved: the instant the target is open or PLAYING, the message is sent, or the file is attached, reply {"action":"done"}. Do NOT keep clicking once the visible end-state is reached - a video that is already playing is done, not a cue to click more.',
    'Messaging a person in a chat app (Slack, etc.), in order:',
    '  1) Open their conversation with the quick switcher: {"action":"key","keys":"cmd k"}, then type their name, then {"action":"key","keys":"Enter"}. (Typing in the left sidebar "Search"/"Channel or user name" box only FILTERS the list - Enter there does NOT open the chat; you would have to CLICK the matching result.)',
    '  2) THEN type the message into the box labeled "Message to <name>" (or "Message #<channel>") by ITS [number], and add "keys":"Enter" to send. Do not assume the message box is focused.',
    'If Previous steps says the text was typed but not submitted, NEVER type it again. Press Enter or click the visible Send control.',
    'A Search / "Channel or user name" / "To" field is for navigation only - never put the message text there.',
    'Attaching or uploading a file, AFTER an Attach/Upload opens the system file dialog (the dialog runs in its own window - drive it with keys, not the app search box):',
    '  1) Open "Go to Folder": {"action":"key","keys":"cmd shift g"}.',
    '  2) Type the FULL path and go: {"action":"type","text":"~/Documents/<file>","keys":"Enter"} - this navigates to the folder AND selects that exact file. Build the path from the task (the Documents folder is ~/Documents).',
    '  3) Confirm: {"action":"key","keys":"Enter"} (or click "Open"). NEVER click "Open"/"search" before a file is selected - with nothing selected it does nothing and you will loop.',
    'If a step changed nothing (the same field still holds your text), do something different - do not repeat it.',
    'Reply with ONLY the JSON for your next action.'
  ]
    .filter(Boolean)
    .join('\n')
}

const DEFAULT_MAX_STEPS = DEFAULT_COMPUTER_USE_STEP_BUDGET
const MAX_CONSECUTIVE_PARSE_FAILURES = 3

/** A stable signature of an actuating step, used to detect a runaway loop. Two
 *  consecutive identical signatures mean the model is repeating itself (it sent
 *  the message, did not notice, and is sending it again) - the rail halts rather
 *  than actuate the duplicate. Terminal actions (done/give_up) have none. */
export function actionSignature(step: ElementStep): string | null {
  switch (step.action) {
    case 'click':
      return `click:${step.index}`
    case 'press':
      return `press:${step.index}`
    case 'type':
      return `type:${step.index ?? 'focus'}:${step.text}:${step.submitKeys ?? ''}`
    case 'key':
      return `key:${step.keys}`
    default:
      return null
  }
}

function isSubmitKey(keys: string): boolean {
  return /(^|\s)(enter|return)(\s|$)/i.test(keys)
}

function isSubmitElement(element: AxElement): boolean {
  return /\b(send|submit|post)\b/i.test(`${element.name} ${element.role}`)
}

/* eslint-disable complexity -- one state machine; per-action helpers would hide
   the observe/act/stop control flow the tests pin down. */
export async function runElementTask(
  goal: string,
  deps: ElementTaskDeps
): Promise<ElementTaskResult> {
  const { read, actuator, decide, onStep } = deps
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const checkpointInterval = Math.max(1, Math.floor(deps.checkpointInterval ?? 9))
  const retrievedFacts = deps.retrievedFacts ?? []
  const now = deps.now ?? Date.now
  const steps: string[] = []
  const reportPhase = createTaskPhaseReporter(deps.plan, deps.onPhase)
  reportPhase(0)
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
  const taskBrief = new TaskBrief(goal)
  let consecutiveParseFailures = 0
  const requireFreshVerification = (): void => {
    if (deps.control && !deps.control.isVerifying) deps.control.beginVerification()
  }

  const waitForControl = async (): Promise<ElementTaskResult | null> => {
    const before = deps.control?.snapshot()
    const after =
      before?.status === 'paused' || before?.status === 'waiting_for_user'
        ? await deps.control?.waitUntilRunnable(deps.signal)
        : before
    if (!after || !['completed', 'failed', 'stopped'].includes(after.status)) return null
    const summary = after.reason || 'stopped'
    return { ok: false, summary, steps }
  }

  for (let step = 0; step < maxSteps; step += 1) {
    const stoppedBeforeStep = await waitForControl()
    if (stoppedBeforeStep) return stoppedBeforeStep
    const planningStep = step + 1
    reportPhase(step)
    const startedAt = now()
    let prompt = ''
    let modelPrompt = ''
    let rawResponse: string | undefined
    let decision: ElementStep | null | undefined
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
      const stoppedAfterRead = await waitForControl()
      if (stoppedAfterRead) return stoppedAfterRead
      if (deps.control && !deps.control.markObservationReady()) continue
      taskBrief.accept(deps.takeGuidance?.() ?? [])
      modelPrompt = buildElementPrompt({
        goal: taskBrief.objective,
        snapshot,
        history: steps,
        retrievedFacts,
        contextTokens: deps.contextTokens,
        plan: deps.plan
      })
      prompt = taskBrief.guidance.reduce(
        (safePrompt, privateText) => safePrompt.split(privateText).join(TASK_GUIDANCE_TRACE),
        modelPrompt
      )
      const decisionLeaseEpoch = deps.control?.snapshot().inputLease.epoch
      rawResponse = await decide(modelPrompt)
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
          const summary = `The action model returned an invalid reply ${MAX_CONSECUTIVE_PARSE_FAILURES} times in a row.`
          note(summary)
          return { ok: false, summary, steps }
        }
        continue
      }
      consecutiveParseFailures = 0
      const action = parsedDecision
      if (action.action === 'done') {
        if (draftAwaitingSubmit) {
          observe('skipped')
          note('completion rejected: text is still a draft; press Enter or click Send')
          checkpoint()
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
        reportPhase((deps.plan?.phases.length ?? 1) - 1)
        observe('terminal')
        note(`gave up: ${action.why}`)
        checkpoint()
        return { ok: false, summary: action.why, steps }
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
      if (sig !== null && sig === lastActionSig) {
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
        continue
      }
      lastActionSig = sig
      if (action.action === 'key') {
        await actuator.keys(action.keys)
        if (isSubmitKey(action.keys)) draftAwaitingSubmit = false
        requireFreshVerification()
        observe('actuated')
        note(`key ${action.keys}`)
        checkpoint()
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
        }
        await actuator.type(target, action.text)
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
        } else if (typed.length > 0) {
          draftAwaitingSubmit = true
        }
        requireFreshVerification()
        observe('actuated')
        checkpoint()
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
      // click or press: prefer AXPress when the element exposes it.
      if (action.action === 'press' || el.actionable) {
        await actuator.press(el)
        note(`pressed [${el.index}] ${el.name || el.role}`)
      } else {
        await actuator.click(el)
        note(`clicked [${el.index}] ${el.name || el.role}`)
      }
      if (isSubmitElement(el)) draftAwaitingSubmit = false
      requireFreshVerification()
      observe('actuated')
      checkpoint()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'accessibility step failed'
      observe('error', message)
      checkpoint()
      throw error
    }
  }

  note('ran out of steps')
  const summary = `stopped after ${maxSteps} steps without finishing`
  return { ok: false, summary, steps }
}
/* eslint-enable complexity */
