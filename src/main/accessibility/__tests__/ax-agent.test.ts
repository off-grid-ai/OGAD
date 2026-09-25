/**
 * The element-picking loop's control flow, every boundary scripted: it clicks/
 * presses/types/keys by element number, prefers AXPress when available, re-
 * observes an unparsed reply or a missing element (never acts on a guess),
 * finishes on done, and stops at the step budget. Plus the fail-closed parser.
 */
import { describe, expect, it } from 'vitest'
import {
  actionSignature,
  buildElementDecisionContext,
  buildElementPrompt,
  observationStateSignature,
  parseElementStep,
  runElementTask,
  type ElementActuator,
  type ElementStepObservation,
  type ElementTaskDeps
} from '../ax-agent'
import type { AxElement, AxSnapshot } from '../ax-elements'
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
  it('runs hover, scroll, slider, and bounded wait actions', async () => {
    const slider = el(3, {
      role: 'AXSlider',
      name: 'Volume',
      valueSettable: true,
      minValue: 0,
      maxValue: 10
    })
    const w = world(
      [
        '{"action":"hover","index":1}',
        '{"action":"scroll","index":1,"direction":"down"}',
        '{"action":"set_value","index":3,"value":7}',
        '{"action":"wait","durationMs":0}',
        '{"action":"done","summary":"adjusted"}'
      ],
      [el(1), slider]
    )
    w.deps.actuator.hover = async (element) => void w.acted.push(`hover:${element.index}`)
    w.deps.actuator.scroll = async (element, direction) =>
      void w.acted.push(`scroll:${element.index}:${direction}`)
    w.deps.actuator.setValue = async (element, value) =>
      void w.acted.push(`value:${element.index}:${value}`)

    await expect(runElementTask('adjust volume', w.deps)).resolves.toMatchObject({
      ok: true,
      summary: 'adjusted'
    })
    expect(w.acted).toEqual(['hover:1', 'scroll:1:down', 'value:3:7'])
  })

  it('rejects unsafe typed and slider targets before actuation', async () => {
    const w = world(
      [
        '{"action":"type","index":1,"text":"secret"}',
        '{"action":"set_value","index":2,"value":99}',
        '{"action":"done","summary":"stopped safely"}'
      ],
      [el(1), el(2, { role: 'AXSlider', minValue: 0, maxValue: 10, valueSettable: true })]
    )
    let observation = 0
    w.deps.read = async () => ({
      windowTitle: `Controls ${observation++}`,
      elements: [el(1), el(2, { role: 'AXSlider', minValue: 0, maxValue: 10, valueSettable: true })]
    })

    const result = await runElementTask('change controls', {
      ...w.deps,
      recoverWithVision: async () => ({ ok: true })
    })
    expect(result.ok).toBe(true)
    expect(w.acted).toEqual([])
    expect(result.steps.join('\n')).toContain('non-editable element')
    expect(result.steps.join('\n')).toContain('value 99 is not valid')
  })

  it('uses deterministic verification and vision recovery results', async () => {
    const w = world([
      '{"action":"key","keys":"cmd 1"}',
      '{"action":"key","keys":"cmd 2"}',
      '{"action":"key","keys":"cmd 3"}'
    ])
    const verification = [
      { status: 'satisfied' as const, latencyMs: 1, samples: 1 },
      { status: 'timeout' as const, latencyMs: 2, samples: 2 },
      { status: 'unsatisfied' as const, latencyMs: 3, samples: 3 }
    ]
    const recoveries: string[] = []
    const result = await runElementTask('complete the task', {
      ...w.deps,
      verifyAction: async () => verification.shift()!,
      recoverWithVision: async ({ summary }) => {
        recoveries.push(summary)
        return { ok: true, completed: true, summary: 'visible result confirmed' }
      }
    })

    expect(result).toMatchObject({ ok: true, summary: 'visible result confirmed' })
    expect(recoveries).toEqual(['The action did not produce its required result.'])
    expect(result.steps.join('\n')).toContain('verification timeout')
  })

  it('advances planned milestones only after independent review', async () => {
    const w = world([])
    const replies = [
      '{"action":"key","keys":"Enter"}',
      '{"action":"milestone_complete","summary":"opened"}',
      '{"action":"key","keys":"Enter"}',
      '{"action":"milestone_complete","summary":"finished"}'
    ]
    w.deps.decideElement = async () => replies.shift()!
    w.deps.decide = async () => '{"action":"milestone_complete","summary":"verified"}'
    let observation = 0
    w.deps.read = async () => ({ windowTitle: `Milestone ${observation++}`, elements: [el(1)] })
    const result = await runElementTask('finish two milestones', {
      ...w.deps,
      plan: {
        version: 1,
        phases: [
          { id: 'phase-1', title: 'Open item' },
          { id: 'phase-2', title: 'Finish item' }
        ]
      }
    })

    expect(result).toMatchObject({ ok: true, summary: 'finished' })
    expect(result.steps.join('\n')).toContain('milestone complete: Open item')
  })

  it('accepts a completed vision recovery after repeated invalid decisions', async () => {
    const w = world(['bad', 'bad', 'bad'])
    const result = await runElementTask('find a visual control', {
      ...w.deps,
      recoverWithVision: async () => ({ ok: true, completed: true, summary: 'control opened' })
    })
    expect(result).toMatchObject({ ok: true, summary: 'control opened' })
  })

  it('keeps the active phase until completion and keeps private guidance out of evidence', async () => {
    const w = world(['{"action":"press","index":1}', '{"action":"done","summary":"sent"}'])
    const plan = {
      version: 1 as const,
      phases: [
        { id: 'phase-1', title: 'Open Messages' },
        { id: 'phase-2', title: 'Send the note' },
        { id: 'phase-3', title: 'Verify it was sent' }
      ]
    }
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
    expect(phases).toEqual(['phase-1', 'phase-3'])
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

  it('tells the typed decision path when text is waiting for submission', async () => {
    const w = world([])
    const pendingSubmitStates: Array<boolean | undefined> = []
    let decisionCount = 0
    w.deps.decideElement = async (_prompt, _snapshot, _phase, _allowCompletion, pendingSubmit) => {
      pendingSubmitStates.push(pendingSubmit)
      decisionCount += 1
      return decisionCount === 1
        ? '{"action":"type","index":2,"text":"https://example.com"}'
        : pendingSubmit
          ? '{"action":"key","keys":"Enter"}'
          : '{"action":"done","summary":"opened"}'
    }

    const result = await runElementTask('open example.com', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'opened' })
    expect(pendingSubmitStates).toEqual([false, true, false])
    expect(w.acted).toEqual(['type:2:https://example.com', 'keys:Enter'])
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

  it('Pause discards a completed model decision and re-observes after Resume', async () => {
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
    expect(w.acted).toEqual([])
    expect(result.steps.join('\n')).toContain(
      'control changed during model work; re-observing before the next action'
    )
  })

  it('give_up is an honest failure with the reason', async () => {
    const w = world(['{"action":"give_up","why":"this needs a login"}'])
    expect(await runElementTask('t', w.deps)).toMatchObject({
      ok: false,
      summary: 'this needs a login'
    })
  })

  it('continues the same accessibility loop after one visual recovery action', async () => {
    const w = world([
      '{"action":"vision_required","why":"The post tile has no accessible label."}',
      '{"action":"press","index":1}',
      '{"action":"done","summary":"post opened"}'
    ])
    const recoveries: string[] = []

    const result = await runElementTask('open the post', {
      ...w.deps,
      recoverWithVision: async (recovery) => {
        recoveries.push(recovery.summary)
        return { ok: true }
      }
    })

    expect(result).toMatchObject({ ok: true, summary: 'post opened' })
    expect(recoveries).toEqual(['The post tile has no accessible label.'])
    expect(w.acted).toEqual(['press:1'])
    expect(result.steps).toContain(
      'Vision recovery completed one action. Returning to accessibility control.'
    )
  })

  it('stops when vision recovery fails or repeats against unchanged state', async () => {
    const failed = world(['{"action":"vision_required","why":"Need pixels"}'])
    await expect(
      runElementTask('open the image', {
        ...failed.deps,
        recoverWithVision: async () => ({ ok: false, detail: 'grounder unavailable' })
      })
    ).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('grounder unavailable')
    })

    const repeated = world([
      '{"action":"vision_required","why":"Need pixels"}',
      '{"action":"vision_required","why":"Still need pixels"}'
    ])
    await expect(
      runElementTask('open the image', {
        ...repeated.deps,
        recoverWithVision: async () => ({ ok: true })
      })
    ).resolves.toMatchObject({
      ok: false,
      summary: expect.stringContaining('recovery already ran')
    })
  })

  it('advances the plan when vision recovery confirms a later phase', async () => {
    const w = world([
      '{"action":"vision_required","why":"Need pixels"}',
      '{"action":"press","index":1}',
      '{"action":"done","summary":"finished"}'
    ])
    const phases: string[] = []
    const result = await runElementTask('finish the task', {
      ...w.deps,
      plan: {
        version: 1,
        phases: [
          { id: 'phase-1', title: 'Open item' },
          { id: 'phase-2', title: 'Finish item' }
        ]
      },
      onPhase: (phase) => phases.push(phase),
      recoverWithVision: async () => ({ ok: true, activePhaseIndex: 1, submittedDraft: true })
    })

    expect(result).toMatchObject({ ok: true, summary: 'finished' })
    expect(phases).toContain('phase-2')
  })

  it('rejects milestone completion while text remains an unsent draft', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"draft"}',
      '{"action":"milestone_complete","summary":"sent"}',
      '{"action":"milestone_complete","summary":"sent"}',
      '{"action":"milestone_complete","summary":"sent"}'
    ])
    const result = await runElementTask('send a draft', {
      ...w.deps,
      plan: { version: 1, phases: [{ id: 'phase-1', title: 'Send the draft' }] },
      recoverWithVision: async () => ({ ok: true, completed: true, summary: 'sent safely' })
    })

    expect(result).toMatchObject({ ok: true, summary: 'sent safely' })
    expect(result.steps.join('\n')).toContain('milestone completion rejected')
  })

  it('keeps working when the heavy reasoner rejects a milestone', async () => {
    const w = world([])
    const decisions = [
      '{"action":"press","index":1}',
      '{"action":"milestone_complete","summary":"opened"}',
      '{"action":"press","index":1}',
      '{"action":"milestone_complete","summary":"opened"}'
    ]
    const reviews = [
      '{"action":"vision_required","why":"result is not visible"}',
      '{"action":"milestone_complete","summary":"verified"}'
    ]
    w.deps.decideElement = async () => decisions.shift()!
    w.deps.decide = async () => reviews.shift()!

    const result = await runElementTask('open the item', {
      ...w.deps,
      plan: { version: 1, phases: [{ id: 'phase-1', title: 'Open the item' }] }
    })

    expect(result).toMatchObject({ ok: true, summary: 'opened' })
    expect(result.steps.join('\n')).toContain(
      'milestone completion rejected by the heavy reasoner: result is not visible'
    )
  })

  it('defers final milestone completion until the session limit allows it', async () => {
    const w = world([
      '{"action":"press","index":1}',
      '{"action":"milestone_complete","summary":"first pass"}',
      '{"action":"key","keys":"Enter"}',
      '{"action":"milestone_complete","summary":"finished"}'
    ])
    let completionChecks = 0
    const result = await runElementTask('keep working', {
      ...w.deps,
      plan: { version: 1, phases: [{ id: 'phase-1', title: 'Work until time expires' }] },
      completionAllowed: () => ++completionChecks > 1
    })

    expect(result).toMatchObject({ ok: true, summary: 'finished' })
    expect(result.steps.join('\n')).toContain('completion deferred until the session limit')
  })

  it('requires a fresh observation before a controlled milestone completes', async () => {
    const w = world([])
    const guard = new VisionGuard({ taskId: 'ax-milestone-verification', kind: 'computer_use' })
    const decisions = [
      '{"action":"milestone_complete","summary":"opened"}',
      '{"action":"milestone_complete","summary":"opened"}'
    ]
    w.deps.decideElement = async () => decisions.shift()!
    w.deps.decide = async () => '{"action":"milestone_complete","summary":"verified"}'

    const result = await runElementTask('open item', {
      ...w.deps,
      control: guard,
      plan: { version: 1, phases: [{ id: 'phase-1', title: 'Open item' }] }
    })

    expect(result).toMatchObject({ ok: true, summary: 'opened' })
    expect(result.steps.join('\n')).toContain('verification requested: opened')
  })

  it('rejects done before a planned phase acts and defers it at a session limit', async () => {
    const w = world([
      '{"action":"done","summary":"too early"}',
      '{"action":"key","keys":"Enter"}',
      '{"action":"done","summary":"first pass"}',
      '{"action":"key","keys":"Tab"}',
      '{"action":"done","summary":"finished"}'
    ])
    let checks = 0
    const result = await runElementTask('work for the session', {
      ...w.deps,
      plan: { version: 1, phases: [{ id: 'phase-1', title: 'Do the work' }] },
      completionAllowed: () => ++checks > 1
    })

    expect(result).toMatchObject({ ok: true, summary: 'finished' })
    expect(result.steps.join('\n')).toContain(
      'completion rejected: the current phase has not executed an action'
    )
    expect(result.steps.join('\n')).toContain('completion deferred until the session limit')
  })

  it('refuses stale and repeated mutations without replaying them', async () => {
    const stale = world(['{"action":"press","index":1}', '{"action":"done","summary":"safe"}'])
    const staleResult = await runElementTask('press safely', {
      ...stale.deps,
      validateAction: async () => false
    })
    expect(staleResult.steps.join('\n')).toContain('stale action refused')
    expect(stale.acted).toEqual([])

    const repeated = world([
      '{"action":"key","keys":"cmd 1"}',
      '{"action":"key","keys":"cmd 2"}',
      '{"action":"key","keys":"cmd 1"}'
    ])
    const repeatedResult = await runElementTask('repeat safely', {
      ...repeated.deps,
      recoverWithVision: async () => ({ ok: true, completed: true, summary: 'recovered' })
    })
    expect(repeatedResult).toMatchObject({ ok: true, summary: 'recovered' })
    expect(repeated.acted).toEqual(['keys:cmd 1', 'keys:cmd 2'])
  })

  it('reports missing slider targets and unavailable pointer operations', async () => {
    const missing = world([
      '{"action":"set_value","index":99,"value":5}',
      '{"action":"done","summary":"safe"}'
    ])
    const missingResult = await runElementTask('set value', missing.deps)
    expect(missingResult.steps.join('\n')).toContain('no element [99]')

    const hover = world(['{"action":"hover","index":1}'])
    await expect(runElementTask('hover', hover.deps)).rejects.toThrow(
      'Pointer hover is unavailable'
    )
    const scroll = world(['{"action":"scroll","index":1,"direction":"down"}'])
    await expect(runElementTask('scroll', scroll.deps)).rejects.toThrow('Scrolling is unavailable')
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
    expect(result.steps.join('\n')).toMatch(/text is already entered/i)
  })

  it('tells the model to submit after it repeats a type action', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"hi"}',
      '{"action":"type","index":2,"text":"hi"}',
      '{"action":"key","keys":"Enter"}',
      '{"action":"done","summary":"sent"}'
    ])
    const prompts: string[] = []
    const originalDecide = w.deps.decide
    w.deps.decide = async (prompt) => {
      prompts.push(prompt)
      return originalDecide(prompt)
    }

    const result = await runElementTask('send hi', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'sent' })
    expect(w.acted).toEqual(['type:2:hi', 'keys:Enter'])
    expect(prompts[2]).toContain(
      'text is already entered; do not type it again; press Enter or click Send'
    )
  })

  it('rejects completion while typed text is still an unsent draft', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"hi"}',
      '{"action":"done","summary":"sent"}',
      '{"action":"key","keys":"Enter"}',
      '{"action":"done","summary":"sent"}'
    ])

    const result = await runElementTask('send hi', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'sent' })
    expect(w.acted).toEqual(['type:2:hi', 'keys:Enter'])
    expect(result.steps.join('\n')).toContain(
      'completion rejected: text is still a draft; press Enter or click Send'
    )
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

  it('parses the extended action vocabulary and validates its bounds', () => {
    expect(parseElementStep('{"action":"hover","index":2}')).toEqual({
      action: 'hover',
      index: 2
    })
    expect(parseElementStep('{"action":"scroll","index":2,"direction":"left"}')).toEqual({
      action: 'scroll',
      index: 2,
      direction: 'left'
    })
    expect(parseElementStep('{"action":"set_value","index":2,"value":3.5}')).toEqual({
      action: 'set_value',
      index: 2,
      value: 3.5
    })
    expect(parseElementStep('{"action":"wait","durationMs":5000}')).toEqual({
      action: 'wait',
      durationMs: 5000
    })
    expect(parseElementStep('{"action":"wait","durationMs":5001}')).toBeNull()
    expect(parseElementStep('{"action":"milestone_complete"}')).toEqual({
      action: 'milestone_complete',
      summary: 'milestone complete'
    })
    expect(parseElementStep('{"action":"human_required"}')).toEqual({
      action: 'human_required',
      why: 'Complete this step'
    })
    expect(parseElementStep('{"action":"vision_required"}')).toEqual({
      action: 'vision_required',
      why: 'Visual grounding is required'
    })
  })
})

describe('decision context signatures', () => {
  it('builds bounded state and stable action signatures', () => {
    const snapshot: AxSnapshot = {
      processId: 9,
      windowId: '4',
      processName: 'Settings',
      windowTitle: 'Sound',
      elements: [
        el(2, {
          stableId: 'volume',
          role: 'AXSlider',
          name: 'Volume',
          value: '7',
          focused: true,
          selected: true,
          checked: true
        }),
        el(1, { stableId: 'mute', name: 'Mute' })
      ]
    }
    const context = buildElementDecisionContext({
      goal: 'Prefix\nStructured task summary:\nAdjust the volume',
      milestone: 'Set volume',
      operation: { kind: 'set_value', target: 'Volume', value: '7' },
      snapshot,
      history: ['opened settings', 'selected sound'],
      guidance: ['Use the main output']
    })
    expect(context).toContain('Current milestone: Set volume')
    expect(context).toContain('Planned operation: kind=set_value')
    expect(context).toContain('Current structured state:')
    expect(context).toContain('Current authoritative guidance:')
    expect(observationStateSignature(snapshot)).toContain('"id":"volume"')
    expect(actionSignature({ action: 'scroll', index: 2, direction: 'up' })).toBe('scroll:2:up')
    expect(actionSignature({ action: 'set_value', index: 2, value: 7 })).toBe('set_value:2:7')
    expect(actionSignature({ action: 'done', summary: 'done' })).toBeNull()
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
    expect(prompt).toMatch(/human_required.*sign-in/i)
    expect(prompt).toMatch(/omit index.*focused/i)
    expect(prompt).toMatch(/"keys":"Enter".*submit/i)
    expect(prompt).toMatch(/match the exact target/i)
    expect(prompt).toMatch(/navigation fields are not content fields/i)
    expect(prompt).toMatch(/verify that the original item changed/i)
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
