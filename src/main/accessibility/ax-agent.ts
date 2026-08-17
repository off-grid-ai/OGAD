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

/** Pull the JSON object out of a model reply that may wrap it in a reasoning
 *  channel or a markdown fence. A grammar-constrained model returns bare JSON,
 *  but a general chat model (no grounder) often prefixes `<think>…</think>` or
 *  fences it in ```json - so we drop the reasoning, then take the first `{` to
 *  the last `}`. Returns null when there is no object at all. */
function extractJsonObject(raw: string): string | null {
  let text = raw
  const thinkClose = text.lastIndexOf('</think>')
  if (thinkClose !== -1) {
    text = text.slice(thinkClose + '</think>'.length)
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    return null
  }
  return text.slice(start, end + 1)
}

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
    'Messaging a person in a chat app (Slack, etc.), in order:',
    '  1) Open their conversation with the quick switcher: {"action":"key","keys":"cmd k"}, then type their name, then {"action":"key","keys":"Enter"}. (Typing in the left sidebar "Search"/"Channel or user name" box only FILTERS the list - Enter there does NOT open the chat; you would have to CLICK the matching result.)',
    '  2) THEN type the message into the box labeled "Message to <name>" (or "Message #<channel>") by ITS [number], and add "keys":"Enter" to send. Do not assume the message box is focused.',
    'A Search / "Channel or user name" / "To" field is for navigation only - never put the message text there.',
    'If a step changed nothing (the same field still holds your text), do something different - do not repeat it.',
    'Reply with ONLY the JSON for your next action.'
  ]
    .filter(Boolean)
    .join('\n')
}

const DEFAULT_MAX_STEPS = 14

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
    if (decision.action === 'key') {
      await actuator.keys(decision.keys)
      note(`key ${decision.keys}`)
      continue
    }
    if (decision.action === 'type') {
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
