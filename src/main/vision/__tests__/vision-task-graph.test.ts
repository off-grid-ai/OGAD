import { describe, expect, it } from 'vitest'
import {
  fallbackTaskExecutionPlan,
  type TaskExecutionPlan
} from '../../../shared/task-execution-plan'
import type { ActuationPort } from '../../input/actuation'
import { sanitizeComputerUseStepDetail } from '../../tasks/task-step-details'
import { TASK_GUIDANCE_TRACE } from '../../tasks/task-guide'
import type { VisionPolicyDecision } from '../model-adapters/types'
import { parseVisionAction, type Bounds } from '../vision-action'
import { dispatchVisionAction } from '../vision-actuation'
import {
  RecoverableVisionError,
  type VisionStepObservation,
  type VisionTaskProgress
} from '../vision-agent'
import { VisionGuard } from '../vision-guard'
import { PRIVATE_INPUT_HANDOFF } from '../secure-input-policy'
import { runVisionTaskGraph, type VisionTaskGraphDeps } from '../vision-task-graph'

const bounds = { width: 1000, height: 1000 }
const plan: TaskExecutionPlan = {
  version: 1,
  phases: [
    { id: 'phase-1', title: 'Navigate to the site' },
    { id: 'phase-2', title: 'Enter the requested details' }
  ]
}

function complete(summary = 'The milestone result is visible.'): VisionPolicyDecision {
  return {
    kind: 'phase_complete',
    actionText: 'Milestone complete',
    summary,
    decisionRationale: 'The required result is visible.'
  }
}

function action(point = { x: 100, y: 295 }): VisionPolicyDecision {
  return {
    kind: 'actions',
    actionText: 'Click the visible control',
    actions: [{ type: 'click', point }],
    decisionRationale: 'The point is visibly inside the named control.'
  }
}

function done(summary = 'The task is complete.'): VisionPolicyDecision {
  return {
    kind: 'done',
    actionText: 'Task complete',
    summary,
    decisionRationale: 'The requested result is visible.'
  }
}

function workflow(decisions: VisionPolicyDecision[]): {
  deps: VisionTaskGraphDeps
  observations: VisionStepObservation[]
  phases: string[]
  actuated: string[]
  policyHistory: string[][]
  decisionCalls: number
} {
  const observations: VisionStepObservation[] = []
  const phases: string[] = []
  const actuated: string[] = []
  const policyHistory: string[][] = []
  const queue = [...decisions]
  const state = {
    observations,
    phases,
    actuated,
    policyHistory,
    decisionCalls: 0,
    deps: {} as VisionTaskGraphDeps
  }
  state.deps = {
    screen: {
      capture: async () => ({ image: '/tmp/current-frame.png', bounds }),
      actuate: async (nextAction) => {
        const point = 'point' in nextAction ? `${nextAction.point.x},${nextAction.point.y}` : ''
        actuated.push(`${nextAction.type}:${point}`)
      }
    },
    guard: new VisionGuard(),
    decide: async (input) => {
      state.decisionCalls += 1
      policyHistory.push(input.policyHistory.map((step) => step.actionText))
      return { response: `decision-${state.decisionCalls}`, modelInput: 'one visual request' }
    },
    parseResponse: () =>
      queue.shift() ?? {
        kind: 'invalid',
        actionText: '',
        error: 'The model action did not parse.'
      },
    waitForUser: async () => undefined,
    plan,
    onPhase: (phaseId) => phases.push(phaseId),
    onObservation: (observation) => observations.push(observation)
  }
  return state
}

describe('runVisionTaskGraph', () => {
  it('records and advances every completed milestone exactly once without an action request', async () => {
    const w = workflow([complete('Site visible.'), complete('Details visible.')])

    const result = await runVisionTaskGraph('Complete both milestones.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.decisionCalls).toBe(2)
    expect(w.phases).toEqual(['phase-1', 'phase-2'])
    expect(result.steps.filter((step) => step.startsWith('milestone complete:'))).toEqual([
      'milestone complete: Navigate to the site',
      'milestone complete: Enter the requested details'
    ])
    expect(w.actuated).toEqual([])
    expect(w.observations.map((item) => item.result)).toEqual(['terminal', 'terminal'])
  })

  it('starts each milestone with a fresh model trajectory', async () => {
    const w = workflow([action(), complete('Site visible.'), complete('Details visible.')])

    const result = await runVisionTaskGraph('Complete both milestones.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.policyHistory).toEqual([[], ['Click the visible control'], []])
    expect(w.phases).toEqual(['phase-1', 'phase-2'])
  })

  it('does not let a model-level done verdict skip remaining execution-plan milestones', async () => {
    const w = workflow([done('Everything is complete.'), complete('Final result verified.')])

    const result = await runVisionTaskGraph('Complete both milestones.', w.deps)

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('Final result verified.')
    expect(w.decisionCalls).toBe(2)
    expect(w.phases).toEqual(['phase-1', 'phase-2'])
    expect(result.steps).toContain('milestone complete: Navigate to the site')
    expect(result.steps).not.toContain('done: Everything is complete.')
  })

  it('keeps model-level done as a terminal result when no execution plan exists', async () => {
    const w = workflow([done('Unplanned task complete.')])
    w.deps.plan = undefined

    const result = await runVisionTaskGraph('Complete the task.', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'Unplanned task complete.' })
    expect(w.decisionCalls).toBe(1)
    expect(result.steps).toContain('done: Unplanned task complete.')
  })

  it('uses one decision call for one approved action and preserves screenshot coordinates', async () => {
    const w = workflow([action(), complete()])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Use the visible control' }] }

    const result = await runVisionTaskGraph('Use the visible control.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.decisionCalls).toBe(2)
    expect(w.actuated).toEqual(['click:100,295'])
    expect(w.policyHistory).toEqual([[], ['Click the visible control']])
    expect(w.observations.map((item) => item.result)).toEqual(['reviewed', 'actuated', 'terminal'])
  })

  it('blocks a nearby repeated click and recovers with a different visible target', async () => {
    const w = workflow([
      action(),
      action({ x: 118, y: 304 }),
      action({ x: 300, y: 295 }),
      complete()
    ])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Use the visible control' }] }

    const result = await runVisionTaskGraph('Use the visible control.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.decisionCalls).toBe(4)
    expect(w.actuated).toEqual(['click:100,295', 'click:300,295'])
    expect(result.steps).toContain(
      'Repeated click region blocked at (118, 304). The previous click marker shows where the earlier attempt landed.'
    )
    expect(w.observations.map((item) => item.result)).toEqual([
      'reviewed',
      'actuated',
      'blocked',
      'reviewed',
      'actuated',
      'terminal'
    ])
  })

  it('stops after one fresh observation when nearby clicks keep failing to focus', async () => {
    const w = workflow([
      action(),
      action({ x: 114, y: 302 }),
      action({ x: 89, y: 310 }),
      complete()
    ])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Enter text in the control' }] }

    const result = await runVisionTaskGraph('Enter text in the visible control.', w.deps)

    expect(result).toMatchObject({
      ok: false,
      summary:
        'Computer use could not focus the intended control after a fresh observation. Use Take Over to complete this step.'
    })
    expect(w.decisionCalls).toBe(3)
    expect(w.actuated).toEqual(['click:100,295'])
    expect(w.observations.map((item) => item.result)).toEqual([
      'reviewed',
      'actuated',
      'blocked',
      'blocked'
    ])
  })

  it('publishes reasoning through the separated live channel and closes that state', async () => {
    const w = workflow([complete()])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Confirm the result' }] }
    const reasoning: Array<{ step: number; content: string; live: boolean }> = []
    w.deps.onReasoning = (event) => reasoning.push(event)
    w.deps.decide = async (input) => {
      input.reportReasoning?.('The result page ')
      input.reportReasoning?.('is visible.')
      return { response: 'complete', modelInput: 'one visual request' }
    }

    await runVisionTaskGraph('Confirm the result.', w.deps)

    expect(reasoning).toEqual([
      { step: 1, content: '', live: true },
      { step: 1, content: 'The result page ', live: true },
      { step: 1, content: 'The result page is visible.', live: true },
      { step: 1, content: 'The result page is visible.', live: false }
    ])
  })

  it('does not tell the model that a rejected action was executed', async () => {
    const w = workflow([action(), complete()])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Use the visible control' }] }
    w.deps.screen.actuate = async () => ({ rejected: 'The captured viewport changed.' })

    const result = await runVisionTaskGraph('Use the visible control.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.policyHistory).toEqual([[], []])
    expect(w.observations.map((item) => item.result)).toEqual(['reviewed', 'blocked', 'terminal'])
  })

  it('never routes a complete_milestone transition through the execution node', async () => {
    const w = workflow([complete()])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Confirm the result' }] }

    await runVisionTaskGraph('Confirm the result.', w.deps)

    expect(w.decisionCalls).toBe(1)
    expect(w.actuated).toEqual([])
  })

  it.each(['aligned', 'off_course'] as const)(
    're-observes a %s rethink verdict without actuation',
    async (direction) => {
      const w = workflow([
        {
          kind: 'rethink',
          actionText: 'rethink',
          summary: 'The proposed point is not verified.',
          direction,
          decisionRationale: 'The point is outside the named control.'
        },
        complete()
      ])
      w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Use the control' }] }

      const result = await runVisionTaskGraph('Use the control.', w.deps)

      expect(result.ok).toBe(true)
      expect(w.decisionCalls).toBe(2)
      expect(w.actuated).toEqual([])
      expect(result.steps).toContain(`${direction}: The proposed point is not verified.`)
    }
  )

  it('takes a fresh observation when a transition command is malformed', async () => {
    const w = workflow([
      { kind: 'invalid', actionText: '', error: 'The model command did not parse.' },
      complete()
    ])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Use the visible control' }] }

    const result = await runVisionTaskGraph('Use the visible control.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.decisionCalls).toBe(2)
    expect(w.actuated).toEqual([])
    expect(w.observations.map((item) => item.result)).toEqual(['parse_failed', 'terminal'])
  })
})

/** Interpret a scripted UI-TARS-style reply as a policy decision. This suite
 * owns the workflow state machine; the adapters have their own contract
 * suites, so scripted actions enter through the injected parse seam. */
function parseScriptedDecision(response: string, target: Bounds): VisionPolicyDecision {
  const parsed = parseVisionAction(response, target)
  if (!parsed) {
    return { kind: 'invalid', actionText: response, error: 'scripted action did not parse' }
  }
  if (parsed.type === 'finished') {
    return { kind: 'done', actionText: 'done', summary: parsed.content || 'done' }
  }
  if (parsed.type === 'call_user') {
    return { kind: 'handoff', actionText: 'user handoff', reason: parsed.content }
  }
  if (parsed.type === 'wait') {
    return { kind: 'wait', actionText: 'wait', durationMs: parsed.durationMs ?? 1_000 }
  }
  return {
    kind: 'actions',
    actionText: parsed.type === 'type' ? 'type text' : response,
    actions: [parsed]
  }
}

function scripted(
  replies: string[],
  guard = new VisionGuard()
): {
  deps: VisionTaskGraphDeps
  actuated: string[]
  userWaits: string[]
  guard: VisionGuard
} {
  const actuated: string[] = []
  const userWaits: string[] = []
  return {
    actuated,
    userWaits,
    guard,
    deps: {
      screen: {
        capture: async () => ({ image: 'png', bounds }),
        actuate: async (nextAction) => {
          actuated.push(nextAction.type)
        }
      },
      guard,
      decide: async () => ({
        response: replies.shift() ?? "finished(content='script exhausted')",
        modelInput: '[scripted adapter messages]'
      }),
      parseResponse: parseScriptedDecision,
      waitForUser: async (why) => {
        userWaits.push(why)
      }
    }
  }
}

describe('runVisionTaskGraph with a scripted action model', () => {
  it('keeps private guidance authoritative without leaking it into durable state', async () => {
    const w = scripted(["click(point='<point>500 500</point>')", "finished(content='done')"])
    const plan = fallbackTaskExecutionPlan('Notes', 'computer')
    const phases: string[] = []
    const observations: VisionStepObservation[] = []
    const groundingInputs: Array<{
      goal: string
      history: string[]
      guidance: readonly string[]
      verifiedActions: readonly string[]
    }> = []
    const privateGuidance = 'Use the second note, private-839201'
    const guidance = [privateGuidance]
    w.deps.plan = plan
    w.deps.onPhase = (phaseId) => phases.push(phaseId)
    w.deps.onObservation = (observation) => observations.push(observation)
    w.deps.takeGuidance = () => guidance.splice(0)
    const originalDecide = w.deps.decide
    w.deps.decide = async (input) => {
      groundingInputs.push({
        goal: input.goal,
        history: input.history,
        guidance: input.guidance,
        verifiedActions: input.verifiedActions ?? []
      })
      return originalDecide(input)
    }

    const result = await runVisionTaskGraph('update a note', w.deps)

    expect(result.ok).toBe(true)
    expect(groundingInputs[0]?.history.join('\n')).toContain('Execution plan:')
    expect(groundingInputs[0]?.guidance).toEqual([privateGuidance])
    expect(groundingInputs[1]?.guidance).toEqual([privateGuidance])
    expect(groundingInputs[0]?.goal).toContain('Original request: update a note')
    expect(groundingInputs[0]?.goal).toContain(privateGuidance)
    expect(groundingInputs[1]?.goal).toContain(privateGuidance)
    expect(groundingInputs[0]?.verifiedActions).toEqual([])
    expect(groundingInputs[1]?.verifiedActions).toEqual(['click at (500, 500)'])
    // A model-level done verdict advances one milestone at a time to the end.
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
    expect(JSON.stringify(groundingInputs[0]?.history)).not.toContain(privateGuidance)
    expect(JSON.stringify(observations)).not.toContain(privateGuidance)
    expect(TASK_GUIDANCE_TRACE).not.toContain(privateGuidance)
    expect(result.steps.filter((step) => step.includes('GUIDANCE'))).toEqual([])
  })

  it('uses guidance received after start in the next and all later visual decisions', async () => {
    const w = scripted([
      "click(point='<point>500 500</point>')",
      "click(point='<point>600 500</point>')",
      "finished(content='ready')"
    ])
    const guidance = 'From San Francisco to Pune on September 1, budget $500-$3000'
    const objectives: string[] = []
    let decision = 0
    w.deps.takeGuidance = () => {
      decision += 1
      return decision === 2 ? [guidance] : []
    }
    const originalDecide = w.deps.decide
    w.deps.decide = async (input) => {
      objectives.push(input.goal)
      return originalDecide(input)
    }

    const result = await runVisionTaskGraph(
      'Open Skyscanner and ask me for route, dates, and budget',
      w.deps
    )

    expect(result.ok).toBe(true)
    expect(objectives[0]).not.toContain(guidance)
    expect(objectives[1]).toContain(guidance)
    expect(objectives[2]).toContain(guidance)
  })

  it('actuates a click then finishes, reporting the summary', async () => {
    const w = scripted([
      "click(point='<point>500 500</point>')",
      "finished(content='shared the file')"
    ])
    const result = await runVisionTaskGraph('share the file', w.deps)
    expect(result).toMatchObject({ ok: true, summary: 'shared the file', handoffs: 0 })
    expect(w.actuated).toEqual(['click'])
    expect(w.guard.snapshot().steps).toBe(1)
  })

  it('call_user hands off and resumes after the user acts', async () => {
    const w = scripted([
      "call_user(content='enter your PIN')",
      "finished(content='done after the PIN')"
    ])
    const result = await runVisionTaskGraph('pay', w.deps)
    expect(result.handoffs).toBe(1)
    expect(w.userWaits).toEqual(['enter your PIN'])
    expect(result.steps.join('\n')).toContain('resumed by the user')
  })

  it('pauses only after explicit takeover and resumes from the same task', async () => {
    const guard = new VisionGuard()
    const w = scripted(["click(point='<point>1 1</point>')", "finished(content='ok')"], guard)
    guard.pauseForUser('you selected Take Over')
    w.deps.onProgress = (progress) => {
      if (progress.phase === 'paused') guard.resume()
    }
    const result = await runVisionTaskGraph('t', w.deps)
    expect(w.userWaits).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.steps.join('\n')).toContain('paused: you selected Take Over')
  })

  it('stops immediately when the kill switch is down, actuating nothing', async () => {
    const guard = new VisionGuard()
    guard.halt('stopped with Esc')
    const w = scripted(["click(point='<point>1 1</point>')"], guard)
    const result = await runVisionTaskGraph('t', w.deps)
    expect(result).toMatchObject({ ok: false, summary: 'stopped with Esc' })
    expect(w.actuated).toEqual([])
  })

  it('re-observes a recoverable focus miss without failing the task or milestone', async () => {
    const w = scripted(["type(content='Pune')", "finished(content='done')"])
    const observations: VisionStepObservation[] = []
    let captures = 0
    w.deps.screen.capture = async () => {
      captures += 1
      return { image: `frame-${captures}.png`, bounds }
    }
    w.deps.screen.actuate = async () => ({
      rejected:
        'No editable field is focused. Take a new screenshot and click the intended input before typing.'
    })
    w.deps.onObservation = (observation) => observations.push(observation)

    const result = await runVisionTaskGraph('enter the destination', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'done' })
    expect(captures).toBe(2)
    expect(w.guard.snapshot().steps).toBe(0)
    expect(result.steps).toContain(
      'rejected action: No editable field is focused. Take a new screenshot and click the intended input before typing.'
    )
    expect(observations.map((item) => item.result)).toContain('blocked')
  })

  it('recovers from rejected focus with one fresh frame and a changed target strategy', async () => {
    const w = scripted([
      "click(point='<point>100 295</point>')",
      "type(content='Pune')",
      "click(point='<point>118 304</point>')",
      "click(point='<point>300 295</point>')",
      "type(content='Pune')",
      "finished(content='destination entered')"
    ])
    const actuated: string[] = []
    let typeAttempts = 0
    let captures = 0
    w.deps.screen.capture = async () => {
      captures += 1
      return { image: `frame-${captures}.png`, bounds }
    }
    w.deps.screen.actuate = async (nextAction) => {
      if (nextAction.type === 'type' && typeAttempts++ === 0) {
        return {
          rejected:
            'No editable field is focused. Take a new screenshot and click the intended input before typing.'
        }
      }
      actuated.push(
        'point' in nextAction
          ? `${nextAction.type}:${nextAction.point.x},${nextAction.point.y}`
          : nextAction.type
      )
      return undefined
    }

    const result = await runVisionTaskGraph('enter the destination', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'destination entered' })
    expect(captures).toBe(6)
    expect(actuated).toEqual(['click:100,295', 'click:300,295', 'type'])
    expect(result.steps).toContain(
      'Repeated click region blocked at (118, 304). The previous click marker shows where the earlier attempt landed.'
    )
  })

  it('takes a fresh screenshot after a recoverable capture boundary failure', async () => {
    const w = scripted(["finished(content='done')"])
    const observations: VisionStepObservation[] = []
    let captures = 0
    w.deps.screen.capture = async () => {
      captures += 1
      if (captures === 1) {
        throw new RecoverableVisionError('The browser target was detached.')
      }
      return { image: `frame-${captures}.png`, bounds }
    }
    w.deps.onObservation = (observation) => observations.push(observation)

    const result = await runVisionTaskGraph('continue browsing', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'done' })
    expect(captures).toBe(2)
    expect(result.steps).toContain('rejected observation: The browser target was detached.')
    expect(observations[0]).toMatchObject({ result: 'blocked', phase: 'checking' })
    expect(observations.at(-1)).toMatchObject({ result: 'terminal' })
  })

  it('stops invalid planning loops at the model step cap', async () => {
    const w = scripted(['bad', 'bad', 'bad'])
    w.deps.maxPlanningSteps = 2
    const result = await runVisionTaskGraph('t', w.deps)
    expect(result).toMatchObject({
      ok: false,
      summary: 'Computer use stopped after 2 planning steps.'
    })
    expect(w.actuated).toEqual([])
  })

  it('records the exact redacted policy message projection from the decision', async () => {
    const w = scripted([])
    const observations: VisionStepObservation[] = []
    w.deps.decide = async () => ({
      response: "finished(content='ok')",
      modelInput: '[exact adapter messages; screenshot redacted]'
    })
    w.deps.onObservation = (observation) => observations.push(observation)
    await runVisionTaskGraph('t', w.deps)
    expect(observations[0]?.promptContext).toBe('[exact adapter messages; screenshot redacted]')
  })

  it('does not expose typed text in progress or task notes', async () => {
    const secret = '839201-private'
    const w = scripted([`type(content='${secret}')`, "finished(content='ok')"])
    const progress: string[] = []
    w.deps.onProgress = (item: VisionTaskProgress) => progress.push(item.action)

    const result = await runVisionTaskGraph('enter the code', w.deps)

    expect(progress.join('\n')).not.toContain(secret)
    expect(result.steps.join('\n')).not.toContain(secret)
    expect(progress).toContain('type text')
    expect(result.steps).toContain('type text')
  })

  it('turns an execution-boundary credential block into a content-free handoff', async () => {
    const secret = '839201-private-value'
    const w = scripted([`type(content='${secret}')`, "finished(content='ok')"])
    const typed: string[] = []
    const port = {
      typeText: async (text: string) => void typed.push(text)
    } as ActuationPort
    const observations: VisionStepObservation[] = []
    w.deps.screen.actuate = (nextAction) =>
      dispatchVisionAction({
        actuation: port,
        action: nextAction,
        goal: 'Enter the verification code',
        inspectFocused: async () => ({ state: 'unknown' })
      })
    w.deps.onObservation = (observation) => observations.push(observation)

    const result = await runVisionTaskGraph('Enter the verification code', w.deps)
    const durableProjection = observations.map((observation) =>
      sanitizeComputerUseStepDetail({
        stepId: String(observation.step),
        at: 1,
        modelInput: observation.promptContext,
        rawResponse: observation.rawResponse,
        decisionSummary: observation.decisionSummary,
        mappedAction: observation.parsedAction
          ? JSON.stringify(observation.parsedAction)
          : undefined,
        execution: { status: 'complete', result: observation.result }
      })
    )

    expect(typed).toEqual([])
    expect(w.userWaits).toEqual([PRIVATE_INPUT_HANDOFF])
    expect(result.handoffs).toBe(1)
    expect(result.steps.join('\n')).not.toContain(secret)
    expect(JSON.stringify(durableProjection)).not.toContain(secret)
  })

  it('records completed actions and the failing action when an ordered response fails', async () => {
    const w = scripted([])
    const observations: VisionStepObservation[] = []
    w.deps.decide = async () => ({ response: 'ordered actions', modelInput: '[scripted]' })
    w.deps.parseResponse = () => ({
      kind: 'actions',
      actionText: 'two clicks',
      actions: [
        { type: 'click', point: { x: 10, y: 10 } },
        { type: 'click', point: { x: 20, y: 20 } }
      ]
    })
    let actuation = 0
    w.deps.screen.actuate = async (nextAction) => {
      actuation += 1
      if (actuation === 2) throw new Error('second click failed')
      return { mappedAction: nextAction }
    }
    w.deps.onObservation = (observation) => observations.push(observation)

    const result = await runVisionTaskGraph('t', w.deps)

    expect(result).toMatchObject({ ok: false, summary: 'second click failed' })
    expect(observations.at(-1)).toMatchObject({
      result: 'error',
      failedActionIndex: 1,
      parsedAction: { type: 'click', point: { x: 20, y: 20 } },
      mappedActions: [{ type: 'click', point: { x: 10, y: 10 } }]
    })
  })

  it('the step budget stops the run after its cap', async () => {
    const guard = new VisionGuard(2)
    const w = scripted(
      [
        "click(point='<point>100 100</point>')",
        "click(point='<point>300 300</point>')",
        "click(point='<point>500 500</point>')"
      ],
      guard
    )
    const result = await runVisionTaskGraph('t', w.deps)
    expect(result.ok).toBe(false)
    expect(w.actuated).toHaveLength(2)
    expect(result.summary).toMatch(/2-step limit/)
  })

  it('re-checks the guard right before dispatch - a kill mid-decision actuates nothing more', async () => {
    const guard = new VisionGuard()
    const w = scripted(["click(point='<point>1 1</point>')"], guard)
    const phases: string[] = []
    // The decision resolves, THEN the user hits Esc before dispatch.
    w.deps.decide = async () => {
      guard.halt('stopped with Esc')
      return { response: "click(point='<point>1 1</point>')", modelInput: '[scripted]' }
    }
    w.deps.onProgress = ({ phase }) => phases.push(phase)
    const result = await runVisionTaskGraph('t', w.deps)
    expect(w.actuated).toEqual([])
    expect(result.summary).toBe('stopped with Esc')
    expect(phases.at(-1)).toBe('stopped')
  })

  it('uses one current screenshot per planning step and passes older outcomes as text', async () => {
    const w = scripted([])
    let captures = 0
    const factsSeen: string[][] = []
    w.deps.screen.capture = async () => {
      captures += 1
      return { image: `current-${captures}.png`, bounds }
    }
    w.deps.retrievedFacts = ['Earlier task: opened Settings']
    w.deps.decide = async ({ image, retrievedFacts: facts }) => {
      factsSeen.push([...facts])
      expect(image).toBe(`current-${factsSeen.length}.png`)
      return {
        response:
          factsSeen.length === 1 ? "click(point='<point>1 1</point>')" : "finished(content='ok')",
        modelInput: '[scripted]'
      }
    }

    await runVisionTaskGraph('t', w.deps)
    expect(captures).toBe(2)
    expect(factsSeen).toEqual([
      ['Earlier task: opened Settings'],
      ['Earlier task: opened Settings']
    ])
  })

  it('emits typed step details and checkpoints at the selected interval', async () => {
    const replies = Array.from({ length: 8 }, (_, index) =>
      index === 7
        ? "finished(content='ok')"
        : `click(point='<point>${50 + index * 120} ${50 + index * 120}</point>')`
    )
    const w = scripted(replies)
    const observations: VisionStepObservation[] = []
    const checkpoints: number[] = []
    w.deps.checkpointInterval = 8
    w.deps.onObservation = (observation) => observations.push(observation)
    w.deps.onCheckpoint = (step) => checkpoints.push(step)

    await runVisionTaskGraph('t', w.deps)

    expect(checkpoints).toEqual([8])
    expect(w.actuated).toHaveLength(7)
    expect(observations[0]).toMatchObject({
      step: 1,
      rawResponse: "click(point='<point>50 50</point>')",
      result: 'reviewed'
    })
    expect(observations.at(-1)).toMatchObject({ step: 8, result: 'terminal' })
  })
})
