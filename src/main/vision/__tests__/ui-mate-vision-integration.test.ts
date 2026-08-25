import { describe, expect, it } from 'vitest'
import { mapActionToScreen } from '../../input/coordinate-mapping'
import { runVisionTask, type VisionScreen } from '../vision-agent'
import { VisionGuard } from '../vision-guard'
import { uiMateAdapter } from '../model-adapters/ui-mate'
import officialFixtures from '../model-adapters/ui-mate/__fixtures__/official-responses.json'
import type { VisionAction } from '../vision-action'

function tool(action: string, parameters: Record<string, unknown> = {}): string {
  const values = Object.entries({ action, ...parameters })
    .map(
      ([name, value]) =>
        `<parameter=${name}>\n${typeof value === 'string' ? value : JSON.stringify(value)}\n</parameter>`
    )
    .join('\n')
  return `<tool_call>\n<function=computer_use>\n${values}\n</function>\n</tool_call>`
}

const ACTION_RESPONSE = `<think>Perform the validated sequence.</think>
<action>Use the controls in order.</action>
${tool('left_click', { coordinate: [500, 500] })}
${tool('middle_click', { coordinate: [100, 200] })}
${tool('triple_click', { coordinate: [300, 400] })}
${tool('drag', { coordinate: [800, 700] })}
${tool('mouse_move', { coordinate: [900, 100] })}
${tool('type', { text: 'hello' })}
${tool('hotkey', { keys: ['ctrl', 'a'] })}
${tool('press', { keys: ['f12', 'enter'] })}
${tool('key_down', { keys: ['shift', 'a'] })}
${tool('key_up', { keys: ['shift', 'a'] })}
${tool('scroll', { pixels: -240, direction: 'vertical' })}`

const DONE_RESPONSE = `<think>Done.</think><action>Finish.</action>${tool('finished', {
  status: 'success'
})}`

describe('UI-Mate live vision policy integration', () => {
  it('drives a pinned official response through policy, mapping, and actuation', async () => {
    const responses = [officialFixtures.cases[0]!.response, DONE_RESPONSE]
    const mapped: VisionAction[] = []
    const screen: VisionScreen = {
      capture: async () => ({ image: 'official-frame.png', bounds: officialFixtures.viewport }),
      actuate: async (action) => {
        const result = mapActionToScreen(action, {
          platform: 'darwin',
          display: { bounds: { x: 100, y: 50, width: 1920, height: 1080 }, scaleFactor: 2 },
          screenshot: {
            sourceBounds: { x: 0, y: 0, width: 1920, height: 1080 },
            encodedSize: officialFixtures.viewport,
            scale: 1
          }
        })
        if (!result) throw new Error('mapping failed')
        mapped.push(result)
        return { mappedAction: result }
      }
    }
    const result = await runVisionTask('Clone the repository.', {
      screen,
      guard: new VisionGuard(),
      ground: async () => responses.shift()!,
      parseResponse: uiMateAdapter.parseResponse,
      waitForUser: async () => undefined
    })

    expect(result.ok).toBe(true)
    expect(mapped).toEqual([{ type: 'click', point: { x: 136, y: 656 } }])
  })

  it('maps one factor-aligned frame and executes every XML action in order', async () => {
    const responses = [ACTION_RESPONSE, DONE_RESPONSE]
    const mapped: VisionAction[] = []
    let captures = 0
    const screen: VisionScreen = {
      capture: async () => {
        captures += 1
        return { image: `frame-${captures}.png`, bounds: { width: 960, height: 544 } }
      },
      actuate: async (action) => {
        const result = mapActionToScreen(action, {
          platform: 'darwin',
          display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
          screenshot: {
            sourceBounds: { x: 0, y: 0, width: 1920, height: 1080 },
            encodedSize: { width: 960, height: 544 },
            scale: 0.5
          }
        })
        if (!result) throw new Error('mapping failed')
        mapped.push(result)
        return { mappedAction: result }
      }
    }
    const guard = new VisionGuard()
    const result = await runVisionTask('Use the app.', {
      screen,
      guard,
      ground: async () => responses.shift()!,
      parseResponse: uiMateAdapter.parseResponse,
      waitForUser: async () => undefined
    })

    expect(result.ok).toBe(true)
    expect(captures).toBe(2)
    expect(guard.snapshot().steps).toBe(11)
    expect(mapped.map((action) => action.type)).toEqual([
      'click',
      'middle_click',
      'triple_click',
      'drag_to',
      'mouse_move',
      'type',
      'hotkey',
      'press',
      'key_down',
      'key_up',
      'scroll_by'
    ])
    expect(mapped[0]).toEqual({ type: 'click', point: { x: 960, y: 540 } })
  })

  it('fails the whole response before execution when one key is unsupported', () => {
    const response = `<think>Try both.</think><action>Click then press.</action>
${tool('left_click', { coordinate: [500, 500] })}
${tool('press', { keys: ['not-a-real-key'] })}`
    expect(uiMateAdapter.parseResponse(response, { width: 960, height: 544 }).kind).toBe('invalid')
  })

  it('keeps official terminal fallback and clamps model wait time', () => {
    expect(
      uiMateAdapter.parseResponse(
        '<think>Need input.</think><action>This requires credentials.</action>',
        { width: 960, height: 544 }
      ).kind
    ).toBe('failed')
    expect(
      uiMateAdapter.parseResponse(
        `<think>Wait.</think><action>Wait.</action>${tool('wait', { time: 999 })}`,
        { width: 960, height: 544 }
      )
    ).toMatchObject({ kind: 'wait', durationMs: 30_000 })
  })
})
