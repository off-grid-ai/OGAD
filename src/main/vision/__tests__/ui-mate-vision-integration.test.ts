import { describe, expect, it } from 'vitest'
import { uiMateAdapter } from '../model-adapters/ui-mate'
import { uiTarsAdapter } from '../model-adapters/ui-tars'
import type { VisionPolicyRequest } from '../model-adapters/types'

const bounds = { width: 960, height: 544 }

function verdict(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    command: {
      name: 'perform_action',
      direction: 'aligned',
      summary: 'Open the visible control.',
      visible_evidence: 'The control is visible in the current screenshot.',
      action: "click(point='500 250')",
      action_reason: 'The point is inside the visible control.',
      ...overrides
    }
  })
}

function complete(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    command: {
      name: 'complete_milestone',
      summary: 'The menu is visibly open.',
      visible_evidence: 'The open menu is visible in the screenshot.',
      ...overrides
    }
  })
}

function request(adapter: typeof uiMateAdapter | typeof uiTarsAdapter): VisionPolicyRequest {
  return adapter.buildRequest({
    goal: 'Use the visible control.',
    currentMilestone: 'Open the menu.',
    currentScreenshotDataUrl: 'data:image/png;base64,current',
    coordinateFrame: { encoded: bounds, source: bounds },
    history: [],
    recentSteps: ['The page is ready.'],
    olderVisualFacts: [],
    verifiedActions: []
  })
}

describe('specialist models use the canonical vision policy', () => {
  it.each([
    ['UI-Mate', uiMateAdapter],
    ['UI-TARS', uiTarsAdapter]
  ] as const)(
    'builds one thinking-enabled strict judge/action request for %s',
    (_name, adapter) => {
      const policy = request(adapter)

      expect(policy).toMatchObject({
        enableThinking: true,
        separateReasoning: true,
        requireFinalAnswer: true,
        maxAttempts: 2,
        responseFormat: { json_schema: { name: 'visual_step_command', strict: true } }
      })
      expect(policy.validateResponse?.(verdict())).toBe(true)
    }
  )

  it.each([
    ['UI-Mate', uiMateAdapter],
    ['UI-TARS', uiTarsAdapter]
  ] as const)(
    'returns zero or one action for %s and rejects multi-action output',
    (_name, adapter) => {
      expect(adapter.parseResponse(verdict(), bounds)).toMatchObject({
        kind: 'actions',
        actions: [{ type: 'click', point: { x: 500, y: 250 } }]
      })
      expect(
        request(adapter).validateResponse?.(
          verdict({ action: ["click(point='500 250')", "click(point='600 250')"] })
        )
      ).toBe(false)
      expect(
        adapter.parseResponse(
          verdict({ action: "click(point='500 250'); click(point='600 250')" }),
          bounds
        )
      ).toMatchObject({ kind: 'invalid' })
    }
  )

  it.each([
    ['UI-Mate', uiMateAdapter],
    ['UI-TARS', uiTarsAdapter]
  ] as const)('rejects the superseded free-form protocol for %s', (_name, adapter) => {
    const xml = `<think>Use two controls.</think><action>Use both.</action>
<tool_call><function=computer_use><parameter=action>left_click</parameter><parameter=coordinate>[100, 200]</parameter></function></tool_call>
<tool_call><function=computer_use><parameter=action>left_click</parameter><parameter=coordinate>[300, 400]</parameter></function></tool_call>`

    expect(adapter.parseResponse(xml, bounds)).toMatchObject({
      kind: 'invalid',
      error: 'the final answer was not valid JSON'
    })
  })

  it.each([
    ['UI-Mate', uiMateAdapter],
    ['UI-TARS', uiTarsAdapter]
  ] as const)('uses explicit structured control decisions for %s', (_name, adapter) => {
    expect(
      adapter.parseResponse(
        verdict({
          action: "call_user(content='Enter the code directly.')",
          summary: 'User input is required.'
        }),
        bounds
      )
    ).toMatchObject({ kind: 'handoff', reason: 'Enter the code directly.' })
    expect(adapter.parseResponse(complete(), bounds)).toMatchObject({
      kind: 'phase_complete',
      summary: 'The menu is visibly open.'
    })
  })
})
