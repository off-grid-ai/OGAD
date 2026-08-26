/**
 * The vision loop's control flow, every boundary scripted: it actuates under
 * the guard, finishes on the model's `finished`, hands off on `call_user`,
 * pauses after an explicit takeover and resumes after, re-observes an
 * unparseable action, and stops the moment the kill switch or step budget
 * closes the guard - never actuating past it.
 */
import { describe, expect, it } from 'vitest'
import {
  RecoverableVisionError,
  runVisionTask,
  type VisionScreen,
  type VisionStepObservation,
  type VisionTaskDeps
} from '../vision-agent'
import { VisionGuard } from '../vision-guard'
import { parseVisionAction, type Bounds } from '../vision-action'
import { dispatchVisionAction } from '../vision-actuation'
import type { VisionPolicyDecision } from '../model-adapters/types'
import type { ActuationPort } from '../../input/actuation'
import { sanitizeComputerUseStepDetail } from '../../tasks/task-step-details'
import { PRIVATE_INPUT_HANDOFF } from '../secure-input-policy'
import { fallbackTaskExecutionPlan } from '../../../shared/task-execution-plan'
import { TASK_GUIDANCE_TRACE } from '../../tasks/task-guide'

const bounds = { width: 1000, height: 1000 }

function parseScriptedDecision(response: string, target: Bounds): VisionPolicyDecision {
  const action = parseVisionAction(response, target)
  if (!action) {
    return { kind: 'invalid', actionText: response, error: 'scripted action did not parse' }
  }
  if (action.type === 'finished') {
    return { kind: 'done', actionText: 'done', summary: action.content || 'done' }
  }
  if (action.type === 'call_user') {
    return { kind: 'handoff', actionText: 'user handoff', reason: action.content }
  }
  if (action.type === 'wait') {
    return { kind: 'wait', actionText: 'wait', durationMs: action.durationMs ?? 1_000 }
  }
  return {
    kind: 'actions',
    actionText: action.type === 'type' ? 'type text' : response,
    actions: [action]
  }
}

const world = (
  replies: string[],
  guard = new VisionGuard()
): {
  deps: VisionTaskDeps
  actuated: string[]
  userWaits: string[]
  guard: VisionGuard
} => {
  const actuated: string[] = []
  const userWaits: string[] = []
  const screen: VisionScreen = {
    capture: async () => ({ image: 'png', bounds }),
    actuate: async (action) => {
      actuated.push(action.type)
    }
  }
  return {
    actuated,
    userWaits,
    guard,
    deps: {
      screen,
      guard,
      ground: async () => replies.shift() ?? "finished(content='script exhausted')",
      // This suite owns the loop state machine. The strict JSON adapter has its
      // own contract suite, so scripted actions enter through the injected seam.
      parseResponse: parseScriptedDecision,
      waitForUser: async (why) => {
        userWaits.push(why)
      }
    }
  }
}

describe('runVisionTask', () => {
  it('uses one execution plan, reports phases, and keeps private guidance authoritative', async () => {
    const w = world(["click(point='<point>500 500</point>')", "finished(content='done')"])
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
    const originalGround = w.deps.ground
    w.deps.ground = async (input) => {
      groundingInputs.push({
        goal: input.goal,
        history: input.history,
        guidance: input.guidance,
        verifiedActions: input.verifiedActions ?? []
      })
      return originalGround(input)
    }

    const result = await runVisionTask('update a note', w.deps)

    expect(groundingInputs[0]?.history.join('\n')).toContain('Execution plan:')
    expect(groundingInputs[0]?.guidance).toEqual([privateGuidance])
    expect(groundingInputs[1]?.guidance).toEqual([privateGuidance])
    expect(groundingInputs[0]?.goal).toContain('Original request: update a note')
    expect(groundingInputs[0]?.goal).toContain(privateGuidance)
    expect(groundingInputs[1]?.goal).toContain(privateGuidance)
    expect(groundingInputs[0]?.verifiedActions).toEqual([])
    expect(groundingInputs[1]?.verifiedActions).toEqual(['click at (500, 500)'])
    // Low-level actions and a terminal claim must not manufacture milestone
    // progress. Only explicit verified phase signals advance the plan.
    expect(phases).toEqual(['phase-1'])
    expect(JSON.stringify(groundingInputs[0]?.history)).not.toContain(privateGuidance)
    expect(JSON.stringify(observations)).not.toContain(privateGuidance)
    expect(TASK_GUIDANCE_TRACE).not.toContain(privateGuidance)
    expect(result.steps.filter((step) => step.includes('GUIDANCE'))).toEqual([])
  })

  it('uses guidance received after start in the next and all later visual decisions', async () => {
    const w = world([
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
    const originalGround = w.deps.ground
    w.deps.ground = async (input) => {
      objectives.push(input.goal)
      return originalGround(input)
    }

    const result = await runVisionTask(
      'Open Skyscanner and ask me for route, dates, and budget',
      w.deps
    )

    expect(result.ok).toBe(true)
    expect(objectives[0]).not.toContain(guidance)
    expect(objectives[1]).toContain(guidance)
    expect(objectives[2]).toContain(guidance)
  })

  it('actuates a click then finishes, reporting the summary', async () => {
    const w = world([
      "click(point='<point>500 500</point>')",
      "finished(content='shared the file')"
    ])
    const result = await runVisionTask('share the file', w.deps)
    expect(result).toMatchObject({ ok: true, summary: 'shared the file', handoffs: 0 })
    expect(w.actuated).toEqual(['click'])
    expect(w.guard.snapshot().steps).toBe(1)
  })

  it('advances milestones only on an explicit verified completion signal', async () => {
    const w = world(['phase', 'phase', "finished(content='done')"])
    const phases: string[] = []
    w.deps.plan = fallbackTaskExecutionPlan('Notes', 'computer')
    w.deps.onPhase = (phaseId) => phases.push(phaseId)
    w.deps.parseResponse = (response) =>
      response === 'phase'
        ? { kind: 'phase_complete', actionText: 'Opened Notes', summary: 'Opened Notes' }
        : { kind: 'done', actionText: 'done', summary: 'done' }

    const result = await runVisionTask('update a note', w.deps)

    expect(result.ok).toBe(true)
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
    expect(w.actuated).toEqual([])
    expect(result.steps).toContain('milestone complete: Open Notes')
  })

  it('publishes one next-phase transition for one phase_complete verdict', async () => {
    const w = world(['phase', "finished(content='done')"])
    const phases: string[] = []
    const milestones: Array<string | undefined> = []
    w.deps.plan = fallbackTaskExecutionPlan('Notes', 'computer')
    w.deps.onPhase = (phaseId) => phases.push(phaseId)
    const originalGround = w.deps.ground
    w.deps.ground = async (input) => {
      milestones.push(input.currentMilestone)
      return originalGround(input)
    }
    w.deps.parseResponse = (response) =>
      response === 'phase'
        ? {
            kind: 'phase_complete',
            actionText: 'Milestone complete',
            summary: 'Notes is open.'
          }
        : { kind: 'done', actionText: 'done', summary: 'done' }

    await runVisionTask('update a note', w.deps)

    expect(phases).toEqual(['phase-1', 'phase-2'])
    expect(milestones).toEqual(['Open Notes', 'Complete the requested work'])
    expect(w.actuated).toEqual([])
  })

  it('finishes when the judge completes the final milestone', async () => {
    const w = world(['phase', 'phase', 'phase'])
    const phases: string[] = []
    w.deps.plan = fallbackTaskExecutionPlan('Notes', 'computer')
    w.deps.onPhase = (phaseId) => phases.push(phaseId)
    w.deps.parseResponse = () => ({
      kind: 'phase_complete',
      actionText: 'Milestone complete',
      summary: 'The requested result is visible.'
    })

    const result = await runVisionTask('update a note', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'The requested result is visible.' })
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
    expect(w.actuated).toEqual([])
    expect(result.steps.filter((step) => step.startsWith('milestone complete:'))).toHaveLength(3)
  })

  it('call_user hands off and resumes after the user acts', async () => {
    const w = world([
      "call_user(content='enter your PIN')",
      "finished(content='done after the PIN')"
    ])
    const result = await runVisionTask('pay', w.deps)
    expect(result.handoffs).toBe(1)
    expect(w.userWaits).toEqual(['enter your PIN'])
    expect(result.steps.join('\n')).toContain('resumed by the user')
  })

  it('pauses only after explicit takeover and resumes from the same task', async () => {
    const guard = new VisionGuard()
    const w = world(["click(point='<point>1 1</point>')", "finished(content='ok')"], guard)
    guard.pauseForUser('you selected Take Over')
    w.deps.onProgress = (progress) => {
      if (progress.phase === 'paused') guard.resume()
    }
    const result = await runVisionTask('t', w.deps)
    expect(w.userWaits).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.steps.join('\n')).toContain('paused: you selected Take Over')
  })

  it('stops immediately when the kill switch is down, actuating nothing', async () => {
    const guard = new VisionGuard()
    guard.halt('stopped with Esc')
    const w = world(["click(point='<point>1 1</point>')"], guard)
    const result = await runVisionTask('t', w.deps)
    expect(result).toMatchObject({ ok: false, summary: 'stopped with Esc' })
    expect(w.actuated).toEqual([])
  })

  it('an unparseable action is re-observed, never actuated blind', async () => {
    const w = world(['not an action', "finished(content='ok')"])
    const result = await runVisionTask('t', w.deps)
    expect(result.ok).toBe(true)
    expect(w.actuated).toEqual([])
    expect(result.steps.join('\n')).toContain('did not parse')
  })

  it('re-observes a recoverable focus miss without failing the task or milestone', async () => {
    const w = world(["type(content='Pune')", "finished(content='done')"])
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

    const result = await runVisionTask('enter the destination', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'done' })
    expect(captures).toBe(2)
    expect(w.guard.snapshot().steps).toBe(0)
    expect(result.steps).toContain(
      'rejected action: No editable field is focused. Take a new screenshot and click the intended input before typing.'
    )
    expect(observations[0]).toMatchObject({
      phase: 'checking',
      result: 'blocked',
      parsedAction: { type: 'type', content: 'Pune' }
    })
  })

  it('takes a fresh screenshot after a recoverable capture boundary failure', async () => {
    const w = world(["finished(content='done')"])
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

    const result = await runVisionTask('continue browsing', w.deps)

    expect(result).toMatchObject({ ok: true, summary: 'done' })
    expect(captures).toBe(2)
    expect(result.steps).toContain('rejected observation: The browser target was detached.')
    expect(observations[0]).toMatchObject({ result: 'blocked', phase: 'checking' })
    expect(observations[1]).toMatchObject({ result: 'terminal' })
  })

  it('stops invalid planning loops at the model step cap', async () => {
    const w = world(['bad', 'bad', 'bad'])
    w.deps.maxPlanningSteps = 2
    const result = await runVisionTask('t', w.deps)
    expect(result).toMatchObject({
      ok: false,
      summary: 'Computer use stopped after 2 planning steps.'
    })
    expect(w.actuated).toEqual([])
  })

  it('records the exact redacted policy message projection from the grounder', async () => {
    const w = world([])
    const observations: VisionStepObservation[] = []
    w.deps.ground = async () => ({
      response: "finished(content='ok')",
      modelInput: '[exact adapter messages; screenshot redacted]'
    })
    w.deps.onObservation = (observation) => observations.push(observation)
    await runVisionTask('t', w.deps)
    expect(observations[0]?.promptContext).toBe('[exact adapter messages; screenshot redacted]')
  })

  it('does not expose typed text in progress or task notes', async () => {
    const secret = '839201-private'
    const w = world([`type(content='${secret}')`, "finished(content='ok')"])
    const progress: string[] = []
    w.deps.onProgress = (item) => progress.push(item.action)

    const result = await runVisionTask('enter the code', w.deps)

    expect(progress.join('\n')).not.toContain(secret)
    expect(result.steps.join('\n')).not.toContain(secret)
    expect(progress).toContain('type text')
    expect(result.steps).toContain('type text')
  })

  it('turns an execution-boundary credential block into a content-free handoff', async () => {
    const secret = '839201-private-value'
    const w = world([`type(content='${secret}')`, "finished(content='ok')"])
    const typed: string[] = []
    const port = {
      typeText: async (text: string) => void typed.push(text)
    } as ActuationPort
    const observations: VisionStepObservation[] = []
    w.deps.screen.actuate = (action) =>
      dispatchVisionAction({
        actuation: port,
        action,
        goal: 'Enter the verification code',
        inspectFocused: async () => ({ state: 'unknown' })
      })
    w.deps.onObservation = (observation) => observations.push(observation)

    const result = await runVisionTask('Enter the verification code', w.deps)
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
    const w = world([])
    const observations: VisionStepObservation[] = []
    w.deps.ground = async () => 'ordered actions'
    w.deps.parseResponse = () => ({
      kind: 'actions',
      actionText: 'two clicks',
      actions: [
        { type: 'click', point: { x: 10, y: 10 } },
        { type: 'click', point: { x: 20, y: 20 } }
      ]
    })
    let actuation = 0
    w.deps.screen.actuate = async (action) => {
      actuation += 1
      if (actuation === 2) throw new Error('second click failed')
      return { mappedAction: action }
    }
    w.deps.onObservation = (observation) => observations.push(observation)

    await expect(runVisionTask('t', w.deps)).rejects.toThrow('second click failed')
    expect(observations[0]).toMatchObject({
      result: 'error',
      failedActionIndex: 1,
      parsedAction: { type: 'click', point: { x: 20, y: 20 } },
      mappedActions: [{ type: 'click', point: { x: 10, y: 10 } }]
    })
  })

  it('the step budget stops the run after its cap', async () => {
    const guard = new VisionGuard(2)
    const w = world(
      [
        "click(point='<point>1 1</point>')",
        "click(point='<point>2 2</point>')",
        "click(point='<point>3 3</point>')"
      ],
      guard
    )
    const result = await runVisionTask('t', w.deps)
    expect(result.ok).toBe(false)
    expect(w.actuated).toHaveLength(2)
    expect(result.summary).toMatch(/2-step limit/)
  })

  it('re-checks the guard right before dispatch - a kill mid-decision actuates nothing more', async () => {
    const guard = new VisionGuard()
    const w = world(["click(point='<point>1 1</point>')"], guard)
    const phases: string[] = []
    // Ground resolves, THEN the user hits Esc before dispatch.
    w.deps.ground = async () => {
      guard.halt('stopped with Esc')
      return "click(point='<point>1 1</point>')"
    }
    w.deps.onProgress = ({ phase }) => phases.push(phase)
    const result = await runVisionTask('t', w.deps)
    expect(w.actuated).toEqual([])
    expect(result.summary).toBe('stopped with Esc')
    expect(phases.at(-1)).toBe('stopped')
  })

  it('uses one current screenshot per planning step and passes older outcomes as text', async () => {
    const w = world(["click(point='<point>1 1</point>')", "finished(content='ok')"])
    let captures = 0
    const factsSeen: string[][] = []
    w.deps.screen.capture = async () => {
      captures += 1
      return { image: `current-${captures}.png`, bounds }
    }
    w.deps.retrievedFacts = ['Earlier task: opened Settings']
    w.deps.ground = async ({ image, retrievedFacts: facts }) => {
      factsSeen.push(facts)
      expect(image).toBe(`current-${factsSeen.length}.png`)
      return factsSeen.length === 1 ? "click(point='<point>1 1</point>')" : "finished(content='ok')"
    }

    await runVisionTask('t', w.deps)
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
        : `click(point='<point>${index + 1} ${index + 1}</point>')`
    )
    const w = world(replies)
    const observations: VisionStepObservation[] = []
    const checkpoints: number[] = []
    w.deps.checkpointInterval = 8
    w.deps.onObservation = (observation) => observations.push(observation)
    w.deps.onCheckpoint = (step) => checkpoints.push(step)

    await runVisionTask('t', w.deps)

    expect(checkpoints).toEqual([8])
    expect(observations).toHaveLength(8)
    expect(observations[0]).toMatchObject({
      step: 1,
      rawResponse: "click(point='<point>1 1</point>')",
      parsedAction: { type: 'click' },
      result: 'actuated'
    })
    expect(observations[7]).toMatchObject({ step: 8, result: 'terminal' })
  })
})
