import { describe, expect, it } from 'vitest'
import { fara15Adapter, parseFaraPolicyResponse } from '../model-adapters/fara-1-5'
import { holo31Adapter, parseHoloToolCall } from '../model-adapters/holo-3-1'
import { loadGatedVisionModelAdapter, resolveVisionModelAdapter } from '../model-adapters/registry'
import type { VisionModelArtifacts, VisionPolicyInput } from '../model-adapters/types'

const BOUNDS = { width: 1_440, height: 900 }

function artifacts(id: string): VisionModelArtifacts {
  return {
    id,
    primaryFile: `${id}.gguf`,
    projectorFile: `${id}.mmproj.gguf`,
    availableFiles: [`${id}.gguf`, `${id}.mmproj.gguf`]
  }
}

function input(environment: 'desktop' | 'embedded_browser'): VisionPolicyInput {
  return {
    goal: 'Open the release page.',
    operatorEnvironment: environment,
    currentScreenshotDataUrl: 'data:image/png;base64,c2NyZWVu',
    history: [],
    recentSteps: [],
    olderVisualFacts: [],
    coordinateFrame: { encoded: BOUNDS, source: BOUNDS }
  }
}

function fara(argumentsValue: Record<string, unknown>): string {
  return [
    'I will use the current browser page.',
    '<tool_call>',
    JSON.stringify({ name: 'computer_use', arguments: argumentsValue }),
    '</tool_call>'
  ].join('\n')
}

describe('Holo 3.1 official function-call adapter', () => {
  it('claims every Holo 3.1 size and uses the canonical native tool request', () => {
    for (const id of ['Holo-3.1-0.8B', 'Holo-3.1-4B', 'Holo-3.1-9B', 'Holo-3.1-35B-A3B']) {
      expect(resolveVisionModelAdapter(artifacts(id)).id).toBe('holo-3.1')
      expect(loadGatedVisionModelAdapter(artifacts(id))?.id).toBe('holo-3.1')
    }
    const request = holo31Adapter.buildRequest(input('desktop'))
    expect(request.messages[0]?.role).toBe('system')
    expect(request.tools).toHaveLength(4)
    expect(request.toolChoice).toBe('required')
  })

  it('parses the official Holo XML parameter form without guessing UI-TARS text', () => {
    const response = `<think>private</think>\n<tool_call>
<function=perform_action>
<parameter=direction>aligned</parameter>
<parameter=summary>Click Continue</parameter>
<parameter=visible_evidence>A Continue button is visible.</parameter>
<parameter=action>{"type":"click","point":{"x":500,"y":250}}</parameter>
<parameter=action_reason>This advances the current page.</parameter>
</function>
</tool_call>`
    expect(parseHoloToolCall(response)).toMatchObject({ name: 'perform_action' })
    expect(holo31Adapter.parseResponse(response, BOUNDS)).toMatchObject({
      kind: 'actions',
      actions: [{ type: 'click', point: { x: 720, y: 225 } }]
    })
    expect(
      holo31Adapter.buildRequest(input('desktop')).validateResponse?.({
        content: response,
        toolCalls: []
      })
    ).toBe(true)
  })

  it('fails closed for a missing projector and malformed XML', () => {
    expect(() =>
      resolveVisionModelAdapter({ ...artifacts('Holo-3.1-4B'), projectorFile: null })
    ).toThrow(/no installed vision projector/i)
    expect(holo31Adapter.parseResponse('<tool_call>broken</tool_call>', BOUNDS).kind).toBe(
      'invalid'
    )
  })
})

describe('Fara 1.5 official browser adapter', () => {
  it('claims the family, asks for one official computer_use tool, and rejects desktop control', () => {
    for (const id of ['Fara1.5-4B', 'Fara1.5-9B']) {
      expect(resolveVisionModelAdapter(artifacts(id)).id).toBe('fara-1.5')
      expect(loadGatedVisionModelAdapter(artifacts(id))?.id).toBe('fara-1.5')
    }
    const request = fara15Adapter.buildRequest(input('embedded_browser'))
    expect(request.temperature).toBe(0)
    expect(request.maxTokens).toBe(2_048)
    expect(request.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'computer_use' })
      })
    ])
    const tool = request.tools?.[0] as {
      function: { description: string; parameters: { properties: { action: { enum: string[] } } } }
    }
    expect(tool.function.description).toContain('1440x900')
    expect(tool.function.parameters.properties.action.enum).not.toContain('pause_and_memorize_fact')
    expect(() => fara15Adapter.buildRequest(input('desktop'))).toThrow(/supports Web Use only/i)
  })

  it.each([
    ['left_click', { coordinate: [720, 225] }, { type: 'click', point: { x: 720, y: 225 } }],
    ['left_click_drag', { coordinate: [800, 600] }, { type: 'drag_to', to: { x: 800, y: 600 } }],
    ['type', { text: 'Off Grid' }, { type: 'type', content: 'Off Grid' }],
    ['key', { keys: ['CTRL', 'L'] }, { type: 'press', keys: ['CTRL', 'L'] }],
    ['scroll', { pixels: -600 }, { type: 'scroll_by', axis: 'vertical', amount: -600 }],
    ['visit_url', { url: 'https://example.com' }, { type: 'navigate', url: 'https://example.com/' }]
  ])('maps official %s arguments into one Web Use action', (action, extra, expected) => {
    expect(
      parseFaraPolicyResponse({ content: fara({ action, ...extra }), toolCalls: [] }, BOUNDS)
    ).toMatchObject({ kind: 'actions', actions: [expected] })
  })

  it('maps official terminal and human actions and rejects malformed calls', () => {
    expect(
      parseFaraPolicyResponse(
        {
          content: fara({ action: 'terminate', answer: 'The release page is open.' }),
          toolCalls: []
        },
        BOUNDS
      )
    ).toMatchObject({ kind: 'done', summary: 'The release page is open.' })
    expect(
      parseFaraPolicyResponse(
        {
          content: fara({ action: 'ask_user_question', question: 'Please sign in.' }),
          toolCalls: []
        },
        BOUNDS
      )
    ).toMatchObject({ kind: 'handoff', reason: 'Please sign in.' })
    expect(
      parseFaraPolicyResponse({ content: '<tool_call>{}</tool_call>', toolCalls: [] }, BOUNDS).kind
    ).toBe('invalid')
    expect(
      parseFaraPolicyResponse(
        { content: fara({ action: 'left_click', coordinate: [1_441, 225] }), toolCalls: [] },
        BOUNDS
      ).kind
    ).toBe('invalid')
  })
})
