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
  maxSteps?: number
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
  | { action: 'done'; summary: string }
  | { action: 'give_up'; why: string }

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
        action: { type: 'string', enum: ['click', 'press', 'type', 'key', 'done', 'give_up'] },
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
    case 'give_up':
      return { action: 'give_up', why: str('why') ?? 'could not finish' }
    default:
      return null
  }
}

export function buildElementPrompt(goal: string, snapshot: AxSnapshot, history: string[]): string {
  return [
    'You are completing a task by operating an app one step at a time.',
    `Task: ${goal}`,
    '',
    formatAxElementsForModel(snapshot),
    '',
    history.length ? `Previous steps:\n${history.slice(-6).join('\n')}` : '',
    'Rules - one action per reply, using an element [number]:',
    '- Click: {"action":"click","index":N} or {"action":"press","index":N}',
    '- Type: {"action":"type","index":N,"text":"..."} - omit "index" to type into the field that is already focused; add "keys":"Enter" to send.',
    '- Key: {"action":"key","keys":"Enter"} (or "cmd k").',
    '- Sign-in, one-time code, or payment: {"action":"give_up","why":"..."} and let the user act.',
    '- Task complete: {"action":"done","summary":"..."}. Cannot be done: {"action":"give_up","why":"..."}.',
    '- STOP as soon as the goal is achieved: the instant the target is open or PLAYING, the message is sent, or the file is attached, reply {"action":"done"}. Do NOT keep clicking once the visible end-state is reached - a video that is already playing is done, not a cue to click more.',
    'Messaging a person in a chat app (Slack, etc.), in order:',
    '  1) Open their conversation with the quick switcher: {"action":"key","keys":"cmd k"}, then type their name, then {"action":"key","keys":"Enter"}. (Typing in the left sidebar "Search"/"Channel or user name" box only FILTERS the list - Enter there does NOT open the chat; you would have to CLICK the matching result.)',
    '  2) THEN type the message into the box labeled "Message to <name>" (or "Message #<channel>") by ITS [number], and add "keys":"Enter" to send. Do not assume the message box is focused.',
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

const DEFAULT_MAX_STEPS = 14

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

/* eslint-disable complexity -- one state machine; per-action helpers would hide
   the observe/act/stop control flow the tests pin down. */
export async function runElementTask(
  goal: string,
  deps: ElementTaskDeps
): Promise<ElementTaskResult> {
  const { read, actuator, decide, onStep } = deps
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS
  const steps: string[] = []
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

  for (let step = 0; step < maxSteps; step += 1) {
    const snapshot = await read()
    const decision = parseElementStep(await decide(buildElementPrompt(goal, snapshot, steps)))
    if (!decision) {
      note('model reply did not parse; re-observing')
      continue
    }
    if (decision.action === 'done') {
      note(`done: ${decision.summary}`)
      return { ok: true, summary: decision.summary, steps }
    }
    if (decision.action === 'give_up') {
      note(`gave up: ${decision.why}`)
      return { ok: false, summary: decision.why, steps }
    }
    // Runaway guard: the model just asked to repeat the EXACT action it already
    // did (e.g. send "hi" again). Stop before actuating the duplicate - a live
    // action like a message must never fire twice because the model looped.
    const sig = actionSignature(decision)
    if (sig !== null && sig === lastActionSig) {
      // Repeat of the last action: SKIP re-firing it (so a live action never
      // fires twice) but keep going - a repeat should not kill the task; the
      // step budget still bounds a genuinely stuck run.
      note('skipped a repeated action; moving on')
      continue
    }
    lastActionSig = sig
    if (decision.action === 'key') {
      await actuator.keys(decision.keys)
      note(`key ${decision.keys}`)
      continue
    }
    if (decision.action === 'type') {
      // A re-type of the same non-empty text is a loop (it already sent it and
      // did not notice); stop before actuating the duplicate, so a message is
      // never sent twice.
      const typed = decision.text.trim()
      if (typed.length > 0 && typedTexts.has(typed)) {
        // Already sent this text: SKIP re-typing it (so a message is never sent
        // twice) but keep going instead of killing the task.
        note('already typed this text; not sending it again')
        continue
      }
      if (typed.length > 0) {
        typedTexts.add(typed)
      }
      // index is optional: focus the named field if given, else type into the
      // field the app already has focused (the common case a general model hits).
      let target: AxElement | null = null
      if (decision.index !== undefined) {
        target = snapshot.elements.find((candidate) => candidate.index === decision.index) ?? null
        if (!target) {
          note(`no element [${decision.index}] on this screen`)
          continue
        }
      }
      await actuator.type(target, decision.text)
      note(
        target
          ? `typed into [${target.index}] ${target.name || target.role}`
          : `typed "${decision.text}" into the focused field`
      )
      // A trailing submit key ("Enter") sends the message in the same step.
      if (decision.submitKeys) {
        await actuator.keys(decision.submitKeys)
        note(`key ${decision.submitKeys}`)
      }
      continue
    }
    const el = snapshot.elements.find((candidate) => candidate.index === decision.index)
    if (!el) {
      note(`no element [${decision.index}] on this screen`)
      continue
    }
    // click or press: prefer AXPress when the element exposes it.
    if (decision.action === 'press' || el.actionable) {
      await actuator.press(el)
      note(`pressed [${el.index}] ${el.name || el.role}`)
    } else {
      await actuator.click(el)
      note(`clicked [${el.index}] ${el.name || el.role}`)
    }
  }

  note('ran out of steps')
  return { ok: false, summary: `stopped after ${maxSteps} steps without finishing`, steps }
}
/* eslint-enable complexity */
