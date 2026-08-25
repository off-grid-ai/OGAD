import { describe, expect, it } from 'vitest'
import fixtures from '../ui-mate/__fixtures__/official-responses.json'
import {
  buildUIMateMessages,
  compactUIMateResponse,
  parseUIMateResponse,
  UI_MATE_GENERATION_CONFIG,
  UI_MATE_MAX_HISTORY_STEPS,
  UI_MATE_TOOL_SCHEMA
} from '../ui-mate/policy'

describe('UI-Mate official response fixtures', () => {
  for (const fixture of fixtures.cases) {
    it(`parses ${fixture.name}`, () => {
      const parsed = parseUIMateResponse(fixture.response, fixtures.viewport)
      if (fixture.expectedAction) expect(parsed.actions[0]?.action).toBe(fixture.expectedAction)
      if (fixture.expectedControl) expect(parsed.control).toBe(fixture.expectedControl)
    })
  }

  it('scales official 0-999 coordinates to the real viewport', () => {
    const parsed = parseUIMateResponse(fixtures.cases[0]!.response, fixtures.viewport)
    expect(parsed.actions[0]?.coordinate).toEqual([36, 606])
  })
})

describe('UI-Mate policy', () => {
  it('uses the official base action schema', () => {
    expect(UI_MATE_GENERATION_CONFIG).toEqual({ maxTokens: 16_384, temperature: 1, topP: 0.95 })
    expect(UI_MATE_TOOL_SCHEMA.function.parameters.properties.action.enum).toEqual([
      'left_click',
      'right_click',
      'middle_click',
      'double_click',
      'triple_click',
      'drag',
      'mouse_move',
      'type',
      'hotkey',
      'press',
      'key_down',
      'key_up',
      'scroll',
      'wait',
      'call_user',
      'finished'
    ])
  })

  it('fails closed on malformed and unknown actions', () => {
    expect(parseUIMateResponse('no protocol', { width: 100, height: 100 }).control).toBe('FAIL')
    expect(
      parseUIMateResponse(
        '<action>Run it.</action><tool_call><function=computer_use><parameter=action>shell</parameter></function></tool_call>',
        { width: 100, height: 100 }
      ).control
    ).toBe('FAIL')
  })

  it('maps failed completion to FAIL', () => {
    const response =
      '<action>Stop.</action><tool_call><function=computer_use><parameter=action>finished</parameter><parameter=status>failure</parameter></function></tool_call>'
    expect(parseUIMateResponse(response, { width: 100, height: 100 }).control).toBe('FAIL')
  })

  it('keeps exactly one current screenshot and compact text history', () => {
    const messages = buildUIMateMessages({
      instruction: 'Open the site.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      history: [
        {
          actionText: 'Click the browser.',
          response:
            '<think>Old private chain.</think><action>Click the browser.</action><tool_call>call</tool_call>'
        }
      ],
      includeThinkingInHistory: false
    })
    const images = messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url')
    expect(images).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } }
    ])
    expect(JSON.stringify(messages)).not.toContain('Old private chain')
    expect(JSON.stringify(messages)).toContain('This screenshot has been collapsed.')
  })

  it('uses the official response history boundary', () => {
    const response = '<think>reason</think>\n<action>click</action>\n<tool_call>call</tool_call>'
    expect(compactUIMateResponse(response, false)).toBe(
      '<action>click</action>\n<tool_call>call</tool_call>'
    )
    expect(compactUIMateResponse(response, true)).toBe(response)
  })

  it('bounds compact text history to the official trajectory limit', () => {
    const history = Array.from({ length: UI_MATE_MAX_HISTORY_STEPS + 1 }, (_, index) => ({
      actionText: `Step ${index}`,
      response: `<action>Step ${index}</action>`
    }))
    const messages = buildUIMateMessages({
      instruction: 'Continue.',
      currentScreenshotDataUrl: 'data:image/png;base64,current',
      history
    })
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(
      UI_MATE_MAX_HISTORY_STEPS
    )
    expect(JSON.stringify(messages)).not.toContain('<action>Step 0</action>')
  })
})
