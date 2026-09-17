import { describe, expect, it } from 'vitest'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import { mapActionToScreen } from '../../input/coordinate-mapping'
import { parseGeneralVisionToolResponse } from '../model-adapters/general-vision-tools'
import type { VisionPolicyResponse } from '../model-adapters/types'
import { VisionGuard } from '../vision-guard'
import { runVisionTaskGraph } from '../vision-task-graph'
import { runElementTask, type ElementActuator } from '../../accessibility/ax-agent'
import { uiMateAdapter } from '../model-adapters/ui-mate'

const plan: TaskExecutionPlan = {
  version: 1,
  phases: [{ id: 'open-control', title: 'Open the visible control' }]
}

function toolResponse(name: string, argumentsValue: Record<string, unknown>): VisionPolicyResponse {
  return {
    content: '',
    toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(argumentsValue) }]
  }
}

describe('macOS Computer Use journey', () => {
  it('submits one captured frame with the AX list to a vision-capable planner', async () => {
    let submittedPrompt = ''
    let submittedScreenshot: string | undefined
    const result = await runElementTask('Open the visible control', {
      read: async () => ({
        windowTitle: 'Native app',
        elements: [
          {
            index: 1,
            role: 'AXButton',
            name: 'Visible control',
            value: '',
            cx: 200,
            cy: 180,
            actionable: true,
            enabled: true
          }
        ]
      }),
      screenshotPath: () => '/tmp/current-screen.png',
      actuator: {
        click: async () => undefined,
        press: async () => undefined,
        type: async () => undefined,
        keys: async () => undefined
      },
      decide: async (prompt, screenshotPath) => {
        submittedPrompt = prompt
        submittedScreenshot = screenshotPath
        return '{"action":"done","summary":"The control is open."}'
      },
      waitForUser: async () => undefined
    })

    expect(result).toMatchObject({ ok: true, summary: 'The control is open.' })
    expect(submittedPrompt).toContain('[1] AXButton "Visible control"')
    expect(submittedScreenshot).toBe('/tmp/current-screen.png')
  })

  it('routes a native tool decision through the shared graph and maps it to the display', async () => {
    const inferenceBounds = { width: 800, height: 500 }
    const screenshot = {
      image: '/tmp/current-screen.png',
      bounds: inferenceBounds,
      metadata: {
        geometry: {
          sourceBounds: { x: 0, y: 0, width: 1440, height: 900 },
          encodedSize: inferenceBounds,
          scale: 5 / 9
        }
      }
    }
    const responses = [
      toolResponse('perform_action', {
        direction: 'aligned',
        summary: 'Open the visible control.',
        visible_evidence: 'The control is visible at the center-left of the screen.',
        action: { type: 'click', point: { x: 500, y: 250 } },
        action_reason: 'The point is inside the visible control.'
      }),
      toolResponse('complete_milestone', {
        summary: 'The control is open.',
        visible_evidence: 'The open control is visible.'
      })
    ]
    const mappedActions: unknown[] = []
    const policyHistory: string[][] = []

    const result = await runVisionTaskGraph('Open the visible control.', {
      screen: {
        capture: async () => screenshot,
        actuate: async (action) => {
          const mapped = mapActionToScreen(action, {
            platform: 'darwin',
            display: {
              bounds: { x: 100, y: 50, width: 1440, height: 900 },
              scaleFactor: 2
            },
            screenshot: screenshot.metadata.geometry
          })
          expect(mapped).not.toBeNull()
          mappedActions.push(mapped)
          return mapped ? { mappedAction: mapped } : { rejected: 'The point could not be mapped.' }
        }
      },
      guard: new VisionGuard({ taskId: 'macos-journey-test', kind: 'computer_use' }),
      decide: async (input) => {
        policyHistory.push(input.policyHistory.map((step) => step.actionText))
        const response = responses.shift()!
        return {
          response: JSON.stringify(response),
          modelInput: 'one screenshot and one native tool decision',
          decision: parseGeneralVisionToolResponse(response, inferenceBounds)
        }
      },
      waitForUser: async () => undefined,
      plan
    })

    expect(result).toMatchObject({ ok: true, summary: 'The control is open.' })
    expect(mappedActions).toEqual([{ type: 'click', point: { x: 820, y: 275 } }])
    expect(policyHistory).toEqual([[], ['Open the visible control.']])
  })

  it('maps a fractional UI-Mate point to the visible control instead of the top-left corner', async () => {
    const responses = [
      `<action>Click the visible control.</action>
<tool_call><function=computer_use><parameter=action>left_click</parameter><parameter=coordinate>[0.692, 0.843]</parameter></function></tool_call>`,
      `<action>The visible control is open.</action>
<tool_call><function=computer_use><parameter=action>subtask_complete</parameter></function></tool_call>`
    ]
    const actions: unknown[] = []
    const bounds = { width: 400, height: 300 }

    const result = await runVisionTaskGraph('Open the visible control.', {
      screen: {
        capture: async () => ({ image: '/tmp/current-screen.png', bounds }),
        actuate: async (action) => {
          actions.push(action)
          return { mappedAction: action }
        }
      },
      guard: new VisionGuard({ taskId: 'fractional-ui-mate-point', kind: 'computer_use' }),
      decide: async () => {
        const response = responses.shift()!
        return {
          response,
          modelInput: 'current screenshot',
          decision: uiMateAdapter.parseResponse(response, bounds)
        }
      },
      waitForUser: async () => undefined,
      plan
    })

    expect(result).toMatchObject({ ok: true, summary: 'The visible control is open.' })
    expect(actions).toEqual([{ type: 'click', point: { x: 276, y: 252 } }])
  })

  it('ends repeated off-course observations instead of looping without a bound', async () => {
    let decisions = 0
    const response = toolResponse('rethink', {
      direction: 'off_course',
      summary: 'The requested application is not visible.',
      visible_evidence: 'The current frame shows a different application.'
    })

    const result = await runVisionTaskGraph('Open the requested application.', {
      screen: {
        capture: async () => ({
          image: '/tmp/current-screen.png',
          bounds: { width: 400, height: 300 }
        }),
        actuate: async () => ({})
      },
      guard: new VisionGuard({ taskId: 'bounded-off-course', kind: 'computer_use' }),
      decide: async () => {
        decisions += 1
        return {
          response: JSON.stringify(response),
          modelInput: 'current screenshot',
          decision: parseGeneralVisionToolResponse(response, { width: 400, height: 300 })
        }
      },
      waitForUser: async () => undefined
    })

    expect(decisions).toBe(3)
    expect(result).toMatchObject({
      ok: false,
      summary:
        'Computer use could not make progress after 3 fresh observations: The requested application is not visible.'
    })
  })

  it('moves a stalled accessibility journey to the existing vision grounder', async () => {
    const accessibilityActions: string[] = []
    const actuator: ElementActuator = {
      click: async (element) => void accessibilityActions.push(`click:${element.index}`),
      press: async (element) => void accessibilityActions.push(`press:${element.index}`),
      type: async (element, text) =>
        void accessibilityActions.push(`type:${element?.index ?? 'focus'}:${text}`),
      keys: async (keys) => void accessibilityActions.push(`keys:${keys}`)
    }
    const replies = [
      '{"action":"type","index":1,"text":"matching item"}',
      '{"action":"click","index":1}',
      '{"action":"click","index":1}',
      '{"action":"type","index":1,"text":"matching item"}',
      '{"action":"type","index":1,"text":"matching item"}'
    ]
    const accessibility = await runElementTask('Open the matching item', {
      read: async () => ({
        windowTitle: 'Native app',
        elements: [
          {
            index: 1,
            role: 'AXTextField',
            name: 'Search',
            value: 'matching item',
            cx: 200,
            cy: 100,
            actionable: false,
            enabled: true
          },
          {
            index: 2,
            role: 'AXButton',
            name: 'Matching item',
            value: '',
            cx: 200,
            cy: 180,
            actionable: true,
            enabled: true
          }
        ]
      }),
      actuator,
      decide: async () => replies.shift() ?? '{"action":"give_up","why":"no reply"}',
      waitForUser: async () => undefined
    })

    expect(accessibility).toMatchObject({ ok: false, recovery: 'vision' })
    expect(accessibilityActions).toEqual(['type:1:matching item', 'click:1'])

    const groundedActions: unknown[] = []
    const responses = [
      toolResponse('perform_action', {
        direction: 'aligned',
        summary: 'Open the visible matching item.',
        visible_evidence: 'The matching item is visible below the search field.',
        action: { type: 'click', point: { x: 500, y: 600 } },
        action_reason: 'The point is inside the matching result.'
      }),
      toolResponse('complete_milestone', {
        summary: 'The matching item is open.',
        visible_evidence: 'The selected item is visible.'
      })
    ]
    const vision = await runVisionTaskGraph('Open the matching item', {
      screen: {
        capture: async () => ({
          image: '/tmp/current-screen.png',
          bounds: { width: 400, height: 300 }
        }),
        actuate: async (action) => {
          groundedActions.push(action)
          return { mappedAction: action }
        }
      },
      guard: new VisionGuard({ taskId: 'stalled-ax-journey', kind: 'computer_use' }),
      decide: async () => {
        const response = responses.shift()!
        return {
          response: JSON.stringify(response),
          modelInput: 'latest screenshot after accessibility stalled',
          decision: parseGeneralVisionToolResponse(response, { width: 400, height: 300 })
        }
      },
      waitForUser: async () => undefined,
      plan
    })

    expect(vision).toMatchObject({ ok: true, summary: 'The matching item is open.' })
    expect(groundedActions).toEqual([{ type: 'click', point: { x: 200, y: 180 } }])
  })

  it('moves an invalid accessibility type target to vision before losing input', async () => {
    const accessibilityActions: string[] = []
    const accessibility = await runElementTask('Open the matching person', {
      read: async () => ({
        windowTitle: 'Native app',
        elements: [
          {
            index: 1,
            role: 'AXTextField',
            name: 'Name or username',
            value: '',
            cx: 200,
            cy: 100,
            actionable: false,
            enabled: true
          },
          {
            index: 2,
            role: 'AXButton',
            name: 'New item',
            value: '',
            cx: 200,
            cy: 180,
            actionable: true,
            enabled: true
          }
        ]
      }),
      actuator: {
        click: async (element) => void accessibilityActions.push(`click:${element.index}`),
        press: async (element) => void accessibilityActions.push(`press:${element.index}`),
        type: async (element, text) =>
          void accessibilityActions.push(`type:${element?.index ?? 'focus'}:${text}`),
        keys: async (keys) => void accessibilityActions.push(`keys:${keys}`)
      },
      decide: async () => '{"action":"type","index":2,"text":"Matching Person"}',
      waitForUser: async () => undefined
    })

    expect(accessibility).toMatchObject({ ok: false, recovery: 'vision' })
    expect(accessibilityActions).toEqual([])

    const groundedActions: unknown[] = []
    const responses = [
      toolResponse('perform_action', {
        direction: 'aligned',
        summary: 'Open the visible matching person.',
        visible_evidence: 'The matching person is visible below the name field.',
        action: { type: 'click', point: { x: 500, y: 600 } },
        action_reason: 'The point is inside the matching result.'
      }),
      toolResponse('complete_milestone', {
        summary: 'The matching person is open.',
        visible_evidence: 'The selected person is visible.'
      })
    ]
    const vision = await runVisionTaskGraph('Open the matching person', {
      screen: {
        capture: async () => ({
          image: '/tmp/current-screen.png',
          bounds: { width: 400, height: 300 }
        }),
        actuate: async (action) => {
          groundedActions.push(action)
          return { mappedAction: action }
        }
      },
      guard: new VisionGuard({ taskId: 'invalid-ax-target-journey', kind: 'computer_use' }),
      decide: async () => {
        const response = responses.shift()!
        return {
          response: JSON.stringify(response),
          modelInput: 'latest screenshot after an invalid accessibility target',
          decision: parseGeneralVisionToolResponse(response, { width: 400, height: 300 })
        }
      },
      waitForUser: async () => undefined,
      plan
    })

    expect(vision).toMatchObject({ ok: true, summary: 'The matching person is open.' })
    expect(groundedActions).toEqual([{ type: 'click', point: { x: 200, y: 180 } }])
  })
})
