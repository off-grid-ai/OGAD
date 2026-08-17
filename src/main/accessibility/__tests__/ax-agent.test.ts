/**
 * The element-picking loop's control flow, every boundary scripted: it clicks/
 * presses/types/keys by element number, prefers AXPress when available, re-
 * observes an unparsed reply or a missing element (never acts on a guess),
 * finishes on done, and stops at the step budget. Plus the fail-closed parser.
 */
import { describe, expect, it } from 'vitest'
import {
  buildElementPrompt,
  parseElementStep,
  runElementTask,
  type ElementActuator,
  type ElementTaskDeps
} from '../ax-agent'
import type { AxElement, AxSnapshot } from '../ax-elements'

const el = (index: number, over: Partial<AxElement> = {}): AxElement => ({
  index,
  role: 'AXButton',
  name: `el${index}`,
  value: '',
  cx: 10,
  cy: 10,
  actionable: true,
  enabled: true,
  ...over
})

const world = (
  replies: string[],
  elements: AxElement[] = [
    el(1, { name: 'Send' }),
    el(2, { role: 'AXTextField', name: 'Message', actionable: false })
  ]
): { deps: ElementTaskDeps; acted: string[] } => {
  const acted: string[] = []
  const actuator: ElementActuator = {
    click: async (e) => void acted.push(`click:${e.index}`),
    press: async (e) => void acted.push(`press:${e.index}`),
    type: async (e, text) => void acted.push(`type:${e ? e.index : 'focus'}:${text}`),
    keys: async (combo) => void acted.push(`keys:${combo}`)
  }
  const snapshot: AxSnapshot = { windowTitle: 'App', elements }
  return {
    acted,
    deps: {
      read: async () => snapshot,
      actuator,
      decide: async () => replies.shift() ?? '{"action":"give_up","why":"script exhausted"}'
    }
  }
}

describe('runElementTask', () => {
  it('presses an actionable element, types into a field, then finishes', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"hi"}',
      '{"action":"press","index":1}',
      '{"action":"done","summary":"sent"}'
    ])
    const result = await runElementTask('send hi', w.deps)
    expect(result).toMatchObject({ ok: true, summary: 'sent' })
    expect(w.acted).toEqual(['type:2:hi', 'press:1'])
  })

  it('prefers AXPress over a click when the element is actionable', async () => {
    const w = world(['{"action":"click","index":1}', '{"action":"done","summary":"ok"}'])
    await runElementTask('t', w.deps)
    // asked to "click", but element 1 exposes AXPress -> press wins
    expect(w.acted).toEqual(['press:1'])
  })

  it('falls back to a real click when the element has no press action', async () => {
    const w = world(
      ['{"action":"click","index":1}', '{"action":"done","summary":"ok"}'],
      [el(1, { actionable: false })]
    )
    await runElementTask('t', w.deps)
    expect(w.acted).toEqual(['click:1'])
  })

  it('sends a key combo without needing an element', async () => {
    const w = world(['{"action":"key","keys":"cmd k"}', '{"action":"done","summary":"ok"}'])
    await runElementTask('t', w.deps)
    expect(w.acted).toEqual(['keys:cmd k'])
  })

  it('types into the FOCUSED field (no index) and submits with a trailing key', async () => {
    // Exactly how a general model drives a compose box it cannot pick out of the
    // list: {"action":"type","text":"hi","keys":"Enter"} - type at focus, send.
    const w = world([
      '{"action":"type","text":"hi","keys":"Enter"}',
      '{"action":"done","summary":"sent"}'
    ])
    const result = await runElementTask('send hi to sidd', w.deps)
    expect(result).toMatchObject({ ok: true, summary: 'sent' })
    expect(w.acted).toEqual(['type:focus:hi', 'keys:Enter'])
  })

  it('re-observes an unparsed reply and a missing element, acting on neither', async () => {
    const w = world([
      'click the send button',
      '{"action":"press","index":99}',
      '{"action":"done","summary":"ok"}'
    ])
    const result = await runElementTask('t', w.deps)
    expect(result.ok).toBe(true)
    expect(w.acted).toEqual([])
    expect(result.steps.join('\n')).toMatch(/did not parse/)
    expect(result.steps.join('\n')).toMatch(/no element \[99\]/)
  })

  it('give_up is an honest failure with the reason', async () => {
    const w = world(['{"action":"give_up","why":"this needs a login"}'])
    expect(await runElementTask('t', w.deps)).toMatchObject({
      ok: false,
      summary: 'this needs a login'
    })
  })

  it('stops at the step budget', async () => {
    const w = world(Array.from({ length: 20 }, () => '{"action":"key","keys":"Tab"}'))
    const result = await runElementTask('t', { ...w.deps, maxSteps: 3 })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/stopped after 3 steps/)
    expect(w.acted).toHaveLength(3)
  })
})

describe('parseElementStep', () => {
  it('accepts each action and fails closed on junk', () => {
    expect(parseElementStep('{"action":"click","index":3}')).toEqual({ action: 'click', index: 3 })
    expect(parseElementStep('{"action":"type","index":1,"text":""}')).toEqual({
      action: 'type',
      index: 1,
      text: ''
    })
    expect(parseElementStep('{"action":"key","keys":"Enter"}')).toEqual({
      action: 'key',
      keys: 'Enter'
    })
    for (const junk of [
      'not json',
      '{"action":"teleport"}',
      '{"action":"click"}', // no index
      '{"action":"type","index":1}', // no text
      '{"action":"key"}' // no keys
    ]) {
      expect(parseElementStep(junk)).toBeNull()
    }
  })

  it('types with an OPTIONAL index and a trailing submit key (how a general model phrases it)', () => {
    // No index -> type into the focused field; "keys" is a trailing submit.
    expect(parseElementStep('{"action":"type","text":"hi","keys":"Enter"}')).toEqual({
      action: 'type',
      text: 'hi',
      submitKeys: 'Enter'
    })
    // With an index, target that field; no submit key.
    expect(parseElementStep('{"action":"type","index":4,"text":"hello"}')).toEqual({
      action: 'type',
      index: 4,
      text: 'hello'
    })
    // "key" (singular) is accepted for the submit too.
    expect(parseElementStep('{"action":"type","text":"x","key":"Enter"}')).toEqual({
      action: 'type',
      text: 'x',
      submitKeys: 'Enter'
    })
  })

  it('tolerates a general chat model wrapping the JSON (fences, reasoning, prose)', () => {
    // A non-grounder often does not emit bare JSON even under a grammar hint -
    // markdown fences, a <think> channel, or a sentence around it. The rail must
    // still drive, so the parser extracts the object.
    expect(parseElementStep('```json\n{"action":"click","index":5}\n```')).toEqual({
      action: 'click',
      index: 5
    })
    expect(
      parseElementStep('<think>I should press Search first</think>\n{"action":"press","index":7}')
    ).toEqual({ action: 'press', index: 7 })
    expect(
      parseElementStep('Sure - here is the next step: {"action":"type","index":2,"text":"hi"} done')
    ).toEqual({ action: 'type', index: 2, text: 'hi' })
  })
})

describe('buildElementPrompt', () => {
  it('anchors on the task, lists the elements, and routes credentials to give_up', () => {
    const prompt = buildElementPrompt(
      'send hi to sidd',
      { windowTitle: 'Slack', elements: [el(1)] },
      []
    )
    expect(prompt).toContain('Task: send hi to sidd')
    expect(prompt).toContain('[1] AXButton')
    expect(prompt).toMatch(/sign-in.*give_up/i)
    // The type rule must teach the optional-index + trailing-submit shape a
    // general model needs, or it re-observes forever (the Slack regression).
    expect(prompt).toMatch(/omit "index".*focused/i)
    expect(prompt).toMatch(/"keys":"Enter".*send/i)
  })
})
