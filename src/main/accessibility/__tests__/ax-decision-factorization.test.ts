import { describe, expect, it } from 'vitest'
import {
  chooseFactorizedElementStep,
  elementDecisionCandidates,
  type ScoreOptions
} from '../ax-decision'
import type { AxElement, AxSnapshot } from '../ax-elements'

function element(index: number): AxElement {
  return {
    index,
    role: 'AXButton',
    name: `Target ${index}`,
    value: '',
    x: index * 10,
    y: 20,
    width: 8,
    height: 8,
    cx: index * 10 + 4,
    cy: 24,
    stableId: `target-${index}`,
    source: 'ax',
    processId: 5,
    windowId: 'window-5',
    revision: 1,
    actionable: true,
    enabled: true
  }
}

function snapshot(count: number, focusedEditor = false): AxSnapshot {
  return {
    windowTitle: 'Targets',
    processId: 5,
    processName: 'Targets',
    windowId: 'window-5',
    windowBounds: { x: 0, y: 0, width: 1_000, height: 800 },
    revision: 1,
    elements: [
      ...Array.from({ length: count }, (_, index) => element(index + 1)),
      ...(focusedEditor
        ? [
            {
              ...element(count + 1),
              role: 'AXTextField',
              name: 'Notes',
              value: 'ready',
              focused: true
            }
          ]
        : [])
    ]
  }
}

function scorer(choices: number[], confidence = 0.9): ScoreOptions {
  return async (_context, _question, options) => {
    const choice = Math.min(choices.shift() ?? 0, options.length - 1)
    const probabilities = options.map((_, index) =>
      index === choice ? confidence : (1 - confidence) / Math.max(1, options.length - 1)
    )
    return { choice, confidence: probabilities[choice]!, probabilities }
  }
}

describe('factorized AX decisions', () => {
  it('keeps executable controls reachable after evidence-only items', () => {
    const current = snapshot(0)
    current.elements = [
      ...Array.from({ length: 130 }, (_, index) => ({
        ...element(index + 1),
        role: 'AXStaticText',
        name: `Evidence ${index + 1}`,
        executable: false
      })),
      element(131)
    ]

    expect(elementDecisionCandidates(current).map((candidate) => candidate.step)).toContainEqual({
      action: 'press',
      index: 131
    })
  })

  it('keeps executable controls beyond the former 120-control cap', () => {
    const current = snapshot(130)

    expect(elementDecisionCandidates(current).map((candidate) => candidate.step)).toContainEqual({
      action: 'press',
      index: 130
    })
  })

  it('attaches nearby visible content to generic control choices', () => {
    const current = snapshot(1)
    current.elements[0]!.name = 'Like'
    current.elements.push({
      ...element(2),
      role: 'AXStaticText',
      name: 'Private on-device language models',
      executable: false,
      actionable: false,
      x: 20,
      y: 24,
      cx: 60,
      cy: 30
    })

    expect(elementDecisionCandidates(current)[0]?.description).toContain(
      'Private on-device language models'
    )
  })

  it('chooses action kind before target noise', async () => {
    const decision = await chooseFactorizedElementStep('goal', snapshot(40, true), scorer([2, 0]))
    expect(decision.step).toEqual({ action: 'key', keys: 'Enter' })
    expect(decision.result.distributions).toHaveLength(2)
    expect(decision.result.distributions[0]?.labels).toContain('press_key')
  })

  it('offers Enter for text typed by the previous action when AX omits focus', async () => {
    const current = snapshot(0)
    current.elements.push({
      ...element(1),
      role: 'AXTextField',
      name: 'Address and search bar',
      value: 'https://www.instagram.com/explore/search/',
      focused: false
    })

    const phase = {
      id: 'phase-1',
      title: 'Open the Instagram search page',
      operation: {
        kind: 'navigate' as const,
        value: 'https://www.instagram.com/explore/search/'
      }
    }
    const decision = await chooseFactorizedElementStep(
      'Open the Instagram search page.',
      current,
      async () => {
        throw new Error('The navigation submit rule must not call the decision model.')
      },
      phase,
      true,
      Date.now,
      new Set(),
      true
    )

    expect(decision.step).toEqual({ action: 'key', keys: 'Enter' })
    expect(decision.result.backend).toBe('rules')
  })

  it('does not offer Enter for an unfocused field without a pending submission', async () => {
    const current = snapshot(0)
    current.elements.push({
      ...element(1),
      role: 'AXTextField',
      name: 'Address and search bar',
      value: 'https://www.instagram.com/explore/search/',
      focused: false
    })

    const decision = await chooseFactorizedElementStep(
      'Open the Instagram search page.',
      current,
      scorer([]),
      {
        id: 'phase-1',
        title: 'Open the Instagram search page',
        operation: {
          kind: 'navigate',
          value: 'https://www.instagram.com/explore/search/'
        }
      }
    )

    expect(decision.step).not.toEqual({ action: 'key', keys: 'Enter' })
  })

  it('routes an unfocused editable field through the writer before submit controls', async () => {
    const current = snapshot(1)
    current.elements[0]!.name = 'Submit'
    current.elements.push({
      ...element(2),
      role: 'AXTextField',
      name: 'Message',
      actionable: false,
      focused: false
    })

    const decision = await chooseFactorizedElementStep(
      'Enter the requested message and submit it.',
      current,
      scorer([1])
    )

    expect(decision.step).toEqual({
      action: 'vision_required',
      why: 'A bounded free-text writer is required.'
    })
    expect(decision.writerTargetIndex).toBe(2)
    expect(decision.result.backend).toBe('rules')
    expect(decision.result.distributions).toEqual([])

    const activation = await chooseFactorizedElementStep(
      'Submit the completed form.',
      current,
      scorer([0])
    )
    expect(activation.step).toEqual({ action: 'press', index: 1 })
  })

  it('routes a relative ordinal target to structured recovery', async () => {
    const current = snapshot(4)
    current.elements[0]!.name = 'Search'
    current.elements[1]!.name = 'First result'
    current.elements[2]!.name = 'Second result'
    current.elements[3]!.name = 'Next page'

    const decision = await chooseFactorizedElementStep(
      'Find and activate the fourth result.',
      current,
      scorer([])
    )

    expect(decision.step).toEqual({
      action: 'vision_required',
      why: 'The target depends on a relative position or relationship.'
    })
    expect(decision.result.family).toBe('visual_recovery')
    expect(decision.result.backend).toBe('rules')
  })

  it('retains full group and target distributions and combines confidence', async () => {
    const decision = await chooseFactorizedElementStep('goal', snapshot(25), scorer([0, 3, 1], 0.9))
    expect(decision.result.distributions).toHaveLength(2)
    expect(decision.result.distributions[0]?.probabilities).toHaveLength(9)
    expect(decision.result.distributions[1]?.probabilities.length).toBeGreaterThan(1)
    expect(decision.result.combinedConfidence).toBeCloseTo(0.9)
    expect(decision.step.action).toMatch(/press|click/)
  })

  it('keeps coarse groups bounded while preserving full final candidates', async () => {
    const current = snapshot(25)
    current.elements.forEach((item) => {
      item.name = `Repeated target with a deliberately long accessible label ${item.index}`
    })
    const calls: Array<{ question: string; options: readonly string[] }> = []
    const score: ScoreOptions = async (_context, question, options) => {
      calls.push({ question, options })
      return {
        choice: 0,
        confidence: 0.9,
        probabilities: options.map((_, index) => (index === 0 ? 0.9 : 0.1 / (options.length - 1)))
      }
    }

    await chooseFactorizedElementStep('goal', current, score)

    const groupCall = calls.find((call) => call.question.includes('target group'))
    const targetCall = calls.find((call) => call.question.includes('single listed control'))
    expect(groupCall?.options.join(' ')).not.toContain('Activate control')
    expect(groupCall?.options.join(' ').length).toBeGreaterThan(2_000)
    expect(groupCall?.options.join(' ').length).toBeLessThan(8_000)
    expect(targetCall?.options.join(' ')).toContain('Activate control')
  })

  it('abstains when hierarchical confidence is below the family gate', async () => {
    const decision = await chooseFactorizedElementStep('goal', snapshot(25), scorer([0, 0], 0.4))
    expect(decision.step).toMatchObject({ action: 'vision_required' })
    expect(decision.result.abstentionReason).toBe('confidence_below_family_threshold')
    expect(decision.result.probabilityMargin).toBeGreaterThan(0)
    expect(decision.result.entropy).toBeGreaterThan(0)
  })

  it('uses the stricter completion gate', async () => {
    const decision = await chooseFactorizedElementStep(
      'Verification satisfied',
      snapshot(2),
      scorer([1, 1], 0.8)
    )
    expect(decision.result.family).toBe('completion')
    expect(decision.step).toMatchObject({ action: 'vision_required' })
  })

  it('does not complete a satisfied phase before a timed session permits completion', async () => {
    const current = snapshot(2)
    current.windowTitle = 'Instagram'
    const decision = await chooseFactorizedElementStep(
      'Continue useful work toward the overall task.',
      current,
      scorer([0, 0]),
      {
        id: 'phase-1',
        title: 'Open Instagram',
        operation: { kind: 'navigate', target: 'Instagram' },
        completion: { kind: 'visible_identity', value: 'Instagram' }
      },
      false
    )

    expect(decision.step.action).not.toBe('milestone_complete')
    expect(decision.result.family).not.toBe('completion')
  })
})
