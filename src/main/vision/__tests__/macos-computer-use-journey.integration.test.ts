import { describe, expect, it } from 'vitest'
import type { TaskExecutionPlan } from '../../../shared/task-execution-plan'
import { mapActionToScreen } from '../../input/coordinate-mapping'
import { parseGeneralVisionToolResponse } from '../model-adapters/general-vision-tools'
import type { VisionPolicyResponse } from '../model-adapters/types'
import { VisionGuard } from '../vision-guard'
import { runVisionTaskGraph } from '../vision-task-graph'

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
      guard: new VisionGuard(),
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
})
