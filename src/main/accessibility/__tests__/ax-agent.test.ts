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
  type ElementStepObservation,
  type ElementTaskDeps
} from '../ax-agent'
import type { AxElement, AxSnapshot } from '../ax-elements'
import { fallbackTaskExecutionPlan } from '../../../shared/task-execution-plan'
import { TASK_GUIDANCE_TRACE } from '../../tasks/task-guide'
import { VisionGuard } from '../../vision/vision-guard'

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
      decide: async () => replies.shift() ?? '{"action":"give_up","why":"script exhausted"}',
      waitForUser: async () => undefined
    }
  }
}

describe('runElementTask', () => {
  it('uses one execution plan, reports phases, and keeps private guidance out of evidence', async () => {
    const w = world(['{"action":"press","index":1}', '{"action":"done","summary":"sent"}'])
    const plan = fallbackTaskExecutionPlan('Messages', 'computer')
    const prompts: string[] = []
    const evidencePrompts: string[] = []
    const phases: string[] = []
    const privateGuidance = 'Send to the second Sam, private-839201'
    const guidance = [privateGuidance]
    const originalDecide = w.deps.decide
    w.deps.decide = async (prompt) => {
      prompts.push(prompt)
      return originalDecide(prompt)
    }
    w.deps.onObservation = (observation) => evidencePrompts.push(observation.prompt)

    const result = await runElementTask('send a message', {
      ...w.deps,
      plan,
      onPhase: (phaseId) => phases.push(phaseId),
      takeGuidance: () => guidance.splice(0)
    })

    expect(prompts[0]).toContain('Execution plan:')
    expect(prompts[0]).toContain(privateGuidance)
    expect(prompts[1]).toContain(privateGuidance)
    expect(evidencePrompts[0]).toContain(TASK_GUIDANCE_TRACE)
    expect(evidencePrompts.join('\n')).not.toContain(privateGuidance)
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
    expect(result.steps.filter((step) => step.includes('GUIDANCE'))).toEqual([])
  })

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

  it('stops after three consecutive invalid model replies instead of looping', async () => {
    const w = world(['not json', 'still not json', 'also not json', 'unused'])

    const result = await runElementTask('send a message', w.deps)

    expect(result).toMatchObject({
      ok: false,
      summary: 'The action model returned an invalid reply 3 times in a row.'
    })
    expect(result.steps.filter((step) => step.includes('did not parse'))).toHaveLength(3)
    expect(w.acted).toEqual([])
  })

  it('Stop during model work prevents later steps and actions', async () => {
    const w = world([])
    const guard = new VisionGuard({ taskId: 'ax-agent-test', kind: 'computer_use' })
    let finishDecision: ((reply: string) => void) | undefined
    let markDecisionStarted: (() => void) | undefined
    const decisionStarted = new Promise<void>((resolve) => {
      markDecisionStarted = resolve
    })
    w.deps.decide = () =>
      new Promise<string>((resolve) => {
        finishDecision = resolve
        markDecisionStarted?.()
      })
    const run = runElementTask('send a message', { ...w.deps, control: guard })
    await decisionStarted
    guard.halt('stopped from the supervisor')
    finishDecision?.('{"action":"press","index":1}')

    const result = await run

    expect(result).toMatchObject({ ok: false, summary: 'stopped' })
    expect(result.steps).toEqual([])
    expect(w.acted).toEqual([])
  })

  it('Pause parks a completed model decision before any action until Resume', async () => {
    const w = world([])
    const guard = new VisionGuard({ taskId: 'ax-agent-test', kind: 'computer_use' })
    let markPaused: (() => void) | undefined
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    let first = true
    w.deps.decide = async () => {
      if (!first) return '{"action":"done","summary":"sent"}'
      first = false
      guard.takeOver('you took over')
      markPaused?.()
      return '{"action":"press","index":1}'
    }
    const run = runElementTask('send a message', { ...w.deps, control: guard })
    await paused
    await Promise.resolve()
    await Promise.resolve()
    expect(w.acted).toEqual([])

    guard.resume()
    const result = await run

    expect(result.ok).toBe(true)
    expect(w.acted).toEqual(['press:1'])
  })

  it('give_up is an honest failure with the reason', async () => {
    const w = world(['{"action":"give_up","why":"this needs a login"}'])
    expect(await runElementTask('t', w.deps)).toMatchObject({
      ok: false,
      summary: 'this needs a login'
    })
  })

  it('hands a private step to the user and re-observes after Continue', async () => {
    const w = world([
      '{"action":"human_required","why":"Enter the one-time code"}',
      '{"action":"done","summary":"signed in"}',
      '{"action":"done","summary":"signed in"}'
    ])
    const guard = new VisionGuard({ taskId: 'ax-agent-test', kind: 'computer_use' })
    let reads = 0
    const reasons: string[] = []
    w.deps.read = async () => {
      reads += 1
      return { windowTitle: 'Sign in', elements: [] }
    }
    w.deps.waitForUser = async (why) => {
      reasons.push(why)
      guard.requestUser(why)
      const continued = guard.waitUntilRunnable()
      guard.resume()
      await continued
    }

    const result = await runElementTask('sign in', { ...w.deps, control: guard })

    expect(result).toMatchObject({ ok: true, summary: 'signed in' })
    expect(reasons).toEqual(['Enter the one-time code'])
    expect(reads).toBe(3)
    expect(result.steps.join('\n')).toContain('resumed by the user')
    expect(w.acted).toEqual([])
  })

  it('Stop remains terminal while the user step is parked', async () => {
    const w = world(['{"action":"human_required","why":"Enter the password"}'])
    const guard = new VisionGuard({ taskId: 'ax-agent-test', kind: 'computer_use' })
    let handoffStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      handoffStarted = resolve
    })
    w.deps.waitForUser = async (why) => {
      guard.requestUser(why)
      handoffStarted?.()
      await guard.waitUntilRunnable()
    }
    const run = runElementTask('sign in', { ...w.deps, control: guard })
    await started

    guard.halt('stopped by you')

    expect(await run).toMatchObject({ ok: false, summary: 'stopped' })
    expect(w.acted).toEqual([])
  })

  it('stops at the step budget', async () => {
    // Distinct keys each step so the runaway guard does not fire first.
    const w = world(Array.from({ length: 20 }, (_, i) => `{"action":"key","keys":"cmd ${i}"}`))
    const result = await runElementTask('t', { ...w.deps, maxSteps: 3 })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/stopped after 3 steps/)
    expect(w.acted).toHaveLength(3)
  })

  it('skips a repeated action so a live send never fires twice, but does NOT kill the task', async () => {
    // The model sent "hi", did not notice, and asked to send it again. The
    // duplicate is skipped (never actuated twice) but the task keeps going.
    const w = world([
      '{"action":"type","index":2,"text":"hi","keys":"Enter"}',
      '{"action":"type","index":2,"text":"hi","keys":"Enter"}', // identical -> skipped, not re-fired
      '{"action":"done","summary":"sent"}'
    ])
    const result = await runElementTask('send hi', w.deps)
    expect(result.ok).toBe(true) // the repeat did NOT kill the task
    expect(result.summary).toBe('sent')
    // Actuated exactly once - the message was not sent twice.
    expect(w.acted).toEqual(['type:2:hi', 'keys:Enter'])
    expect(result.steps.join('\n')).toMatch(/skipped a repeated action/i)
  })

  it('skips a re-typed text even at a different index (no double-send) but keeps going', async () => {
    // The Slack A-B-A-B loop: type link -> Enter -> type the SAME link at a new
    // index (the composer renumbers). The re-type is skipped, not re-sent, and
    // the task continues instead of dying.
    const w = world([
      '{"action":"type","index":2,"text":"github.com/x"}',
      '{"action":"key","keys":"Enter"}',
      '{"action":"type","index":1,"text":"github.com/x"}', // same text, new index -> skipped
      '{"action":"done","summary":"sent"}'
    ])
    const result = await runElementTask('send the link', w.deps)
    expect(result.ok).toBe(true)
    // The link was typed+sent exactly once; the duplicate never actuated.
    expect(w.acted).toEqual(['type:2:github.com/x', 'keys:Enter'])
    expect(result.steps.join('\n')).toMatch(/not sending it again/i)
  })

  it('does NOT halt when consecutive actions differ (no false positive)', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"hi","keys":"Enter"}',
      '{"action":"press","index":1}', // different action -> allowed
      '{"action":"done","summary":"ok"}'
    ])
    const result = await runElementTask('t', w.deps)
    expect(result.ok).toBe(true)
    expect(w.acted).toEqual(['type:2:hi', 'keys:Enter', 'press:1'])
  })

  it('checkpoints after the selected number of planning steps', async () => {
    const w = world(Array.from({ length: 8 }, (_, i) => `{"action":"key","keys":"cmd ${i}"}`))
    const checkpoints: number[] = []
    await runElementTask('t', {
      ...w.deps,
      maxSteps: 8,
      checkpointInterval: 8,
      onCheckpoint: (step) => checkpoints.push(step)
    })
    expect(checkpoints).toEqual([8])
  })

  it('observes the exact prompt, raw reply, parsed action, result, and timing for each plan', async () => {
    const prompts: string[] = []
    const w = world([
      'not json',
      '{"action":"key","keys":"Enter"}',
      '{"action":"done","summary":"open"}'
    ])
    const observations: ElementStepObservation[] = []
    let clock = 100
    await runElementTask('open the item', {
      ...w.deps,
      retrievedFacts: ['Earlier task opened the list'],
      decide: async (prompt) => {
        prompts.push(prompt)
        return (
          ['not json', '{"action":"key","keys":"Enter"}', '{"action":"done","summary":"open"}'][
            prompts.length - 1
          ] ?? '{"action":"give_up","why":"script exhausted"}'
        )
      },
      now: () => (clock += 5),
      onObservation: (observation) => observations.push(observation)
    })

    expect(observations).toHaveLength(3)
    expect(observations.map((entry) => entry.result)).toEqual([
      'parse_failed',
      'actuated',
      'terminal'
    ])
    expect(observations[0]).toMatchObject({
      step: 1,
      prompt: prompts[0],
      rawResponse: 'not json',
      parsedAction: null,
      retrievedFacts: ['Earlier task opened the list'],
      durationMs: 5
    })
    expect(observations[1]).toMatchObject({
      prompt: prompts[1],
      rawResponse: '{"action":"key","keys":"Enter"}',
      parsedAction: { action: 'key', keys: 'Enter' },
      durationMs: 5
    })
    expect(observations[2]?.prompt).toContain('Previous steps:')
    expect(observations[2]?.prompt).toContain('key Enter')
  })

  it('observes an actuator failure once with its model evidence', async () => {
    const w = world(['{"action":"key","keys":"Enter"}'])
    const observations: ElementStepObservation[] = []
    w.deps.actuator.keys = async () => {
      throw new Error('input driver stopped')
    }

    await expect(
      runElementTask('submit', {
        ...w.deps,
        onObservation: (observation) => observations.push(observation)
      })
    ).rejects.toThrow('input driver stopped')
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      result: 'error',
      rawResponse: '{"action":"key","keys":"Enter"}',
      parsedAction: { action: 'key', keys: 'Enter' },
      error: 'input driver stopped'
    })
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
    const prompt = buildElementPrompt({
      goal: 'send hi to sidd',
      snapshot: { windowTitle: 'Slack', elements: [el(1)] },
      history: []
    })
    expect(prompt).toContain('Task: send hi to sidd')
    expect(prompt).toContain('[1] AXButton')
    expect(prompt).toMatch(/sign-in.*human_required/i)
    // The type rule must teach the optional-index + trailing-submit shape a
    // general model needs, or it re-observes forever (the Slack regression).
    expect(prompt).toMatch(/omit "index".*focused/i)
    expect(prompt).toMatch(/"keys":"Enter".*send/i)
    // Messaging guidance (the Slack live-test fixes): open the DM via the quick
    // switcher (a sidebar-search Enter only filters), then type into the labeled
    // composer by number - not by assuming focus.
    expect(prompt).toMatch(/cmd k/i)
    expect(prompt).toMatch(/Message to <name>/i)
    expect(prompt).toMatch(/only FILTERS|does NOT open/i)
    // Completion coaching: stop the instant the goal is achieved (a playing
    // video is done) - the over-acting seen when it clicked past a playing video.
    expect(prompt).toMatch(/STOP as soon as the goal is achieved/i)
    expect(prompt).toMatch(/already playing is done/i)
    // File-picker coaching: the native dialog is a separate window - drive it
    // with Go-to-Folder + full path, and never click Open with nothing selected
    // (the Slack file-attach loop on "Open"/"search").
    expect(prompt).toMatch(/cmd shift g/i)
    expect(prompt).toMatch(/never click "open".*before a file is selected/i)
  })

  it('includes optional older outcomes as text and keeps bounded recent history', () => {
    const prompt = buildElementPrompt({
      goal: 'open settings',
      snapshot: { windowTitle: 'App', elements: [el(1)] },
      history: ['old'.repeat(2_000), 'current step'],
      retrievedFacts: ['Earlier task: opened Settings'],
      contextTokens: 512
    })
    expect(prompt).toContain('Earlier task: opened Settings')
    expect(prompt).toContain('current step')
    expect(prompt).not.toContain('oldoldold')
  })
})
