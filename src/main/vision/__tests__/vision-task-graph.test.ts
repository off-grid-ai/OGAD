import { describe, expect, it } from 'vitest'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import type { VisionPolicyDecision } from '../model-adapters/types'
import type { VisionStepObservation } from '../vision-agent'
import { VisionGuard } from '../vision-guard'
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

function action(): VisionPolicyDecision {
  return {
    kind: 'actions',
    actionText: 'Click the visible control',
    actions: [{ type: 'click', point: { x: 100, y: 295 } }],
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

  it('blocks an identical repeated click and asks the next judge pass for another target', async () => {
    const w = workflow([action(), action(), complete()])
    w.deps.plan = { version: 1, phases: [{ id: 'only', title: 'Use the visible control' }] }

    const result = await runVisionTaskGraph('Use the visible control.', w.deps)

    expect(result.ok).toBe(true)
    expect(w.decisionCalls).toBe(3)
    expect(w.actuated).toEqual(['click:100,295'])
    expect(result.steps).toContain(
      'Repeated click blocked at (100, 295). The previous click marker shows where it landed; choose a different visible target or rethink.'
    )
    expect(w.observations.map((item) => item.result)).toEqual([
      'reviewed',
      'actuated',
      'blocked',
      'terminal'
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
