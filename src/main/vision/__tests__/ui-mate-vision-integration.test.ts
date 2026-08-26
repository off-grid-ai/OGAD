import { describe, expect, it } from 'vitest'
import { generalVisionOperatorAdapter } from '../model-adapters/general-vision-operator'
import { uiMateAdapter } from '../model-adapters/ui-mate'
import { uiTarsAdapter } from '../model-adapters/ui-tars'

const bounds = { width: 960, height: 544 }

function uiMate(action: string, parameters = ''): string {
  return `<think>The visible control is ready.</think><action>Use the visible control.</action><tool_call><function=computer_use><parameter=action>${action}</parameter>${parameters}</function></tool_call>`
}

describe('specialist vision protocols', () => {
  it('keeps UI-Mate on its native XML trajectory and execution-plan extension', () => {
    const request = uiMateAdapter.buildRequest({
      goal: 'Use the visible control.',
      currentMilestone: 'Open the menu.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: ['The page is ready.'],
      olderVisualFacts: [],
      verifiedActions: []
    })
    const serialized = JSON.stringify(request.messages)

    expect(request.tools).toBeUndefined()
    expect(request.responseFormat).toBeUndefined()
    expect(request.maxTokens).toBe(16_384)
    expect(serialized).toContain('<function=computer_use>')
    expect(serialized).toContain('Current milestone: Open the menu.')
    expect(serialized).toContain('subtask_complete')
  })

  it('maps UI-Mate actions, milestone completion, and handoff through its native parser', () => {
    expect(
      uiMateAdapter.parseResponse(
        uiMate('left_click', '<parameter=coordinate>[500, 250]</parameter>'),
        bounds
      )
    ).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 480, y: 136 } }],
      decisionRationale: 'The visible control is ready.'
    })
    expect(uiMateAdapter.parseResponse(uiMate('subtask_complete'), bounds)).toMatchObject({
      kind: 'phase_complete',
      summary: 'Use the visible control.'
    })
    expect(
      uiMateAdapter.parseResponse(
        uiMate('call_user', '<parameter=text>Enter the one-time code.</parameter>'),
        bounds
      )
    ).toMatchObject({ kind: 'handoff', reason: 'Enter the one-time code.' })
  })

  it('keeps UI-TARS on its native single action-text protocol', () => {
    const request = uiTarsAdapter.buildRequest({
      goal: 'Use the visible control.',
      currentMilestone: 'Open the menu.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      coordinateFrame: { encoded: bounds, source: bounds },
      history: [],
      recentSteps: ['The page is ready.'],
      olderVisualFacts: [],
      verifiedActions: []
    })

    expect(request.tools).toBeUndefined()
    expect(request.disableThinking).toBe(true)
    expect(JSON.stringify(request.messages)).toContain('Current milestone: Open the menu.')
    expect(
      uiTarsAdapter.parseResponse("Action: click(point='<point>500 250</point>')", bounds)
    ).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 480, y: 136 } }]
    })
    expect(uiTarsAdapter.parseResponse('Action: subtask_complete()', bounds)).toMatchObject({
      kind: 'phase_complete'
    })
  })

  it('does not let general models control the graph with answer text', () => {
    expect(
      generalVisionOperatorAdapter.parseResponse(
        '{"command":{"name":"complete_milestone"}}',
        bounds
      )
    ).toMatchObject({
      kind: 'invalid',
      error: 'The general vision model did not return a native tool decision.'
    })
  })
})
