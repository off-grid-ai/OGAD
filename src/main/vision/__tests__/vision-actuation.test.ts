import { describe, expect, it, vi } from 'vitest'
import type { ActuationPort } from '../../input/actuation'
import { inspectFocusedInput } from '../focused-input'
import {
  isCredentialLikeInput,
  PRIVATE_INPUT_HANDOFF,
  secureInputDecision
} from '../secure-input-policy'
import { dispatchVisionAction } from '../vision-actuation'

function actuation(): ActuationPort {
  return {
    moveMouse: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    dragTo: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    tapKeys: vi.fn(async () => undefined),
    pressKeys: vi.fn(async () => undefined),
    keyDown: vi.fn(async () => undefined),
    keyUp: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    scrollBy: vi.fn(async () => undefined)
  }
}

describe('vision secure-input actuation boundary', () => {
  it.each([
    ['Enter the one-time code', '839201'],
    ['Enter your PIN', '4821'],
    ['Sign in with the password', 'correct horse battery staple'],
    ['Paste this value into the form', 'sk-private-value-123456'],
    ['Enter this value into the form', '4111 1111 1111 1111']
  ])('classifies private input from goal and content without returning it', (goal, content) => {
    expect(isCredentialLikeInput(content, goal)).toBe(true)
    const decision = secureInputDecision({ content, goal, target: { state: 'unknown' } })
    expect(decision).toEqual({ kind: 'handoff', reason: PRIVATE_INPUT_HANDOFF })
    expect(JSON.stringify(decision)).not.toContain(content)
  })

  it('blocks before typeText when the focused native element is secure', async () => {
    const port = actuation()
    const result = await dispatchVisionAction({
      actuation: port,
      action: { type: 'type', content: 'private-value' },
      goal: 'Complete the form',
      inspectFocused: async () => ({ state: 'secure' })
    })

    expect(result).toEqual({ handoff: PRIVATE_INPUT_HANDOFF })
    expect(port.typeText).not.toHaveBeenCalled()
  })

  it('allows ordinary text only after a focused native field is verified safe', async () => {
    const port = actuation()
    await dispatchVisionAction({
      actuation: port,
      action: { type: 'type', content: 'Quarterly planning notes' },
      goal: 'Write a document title',
      inspectFocused: async () => ({ state: 'safe' })
    })

    expect(port.typeText).toHaveBeenCalledWith('Quarterly planning notes')
  })

  it('parses only the native safety state and returns unknown for invalid output', async () => {
    const safe = await inspectFocusedInput({
      platform: 'darwin',
      helper: () => '/native/text-extractor',
      run: async () => '{"state":"safe"}'
    })
    const invalid = await inspectFocusedInput({
      platform: 'darwin',
      helper: () => '/native/text-extractor',
      run: async () => '{"state":"safe","value":"must-not-be-used"}'
    })
    const malformed = await inspectFocusedInput({
      platform: 'darwin',
      helper: () => '/native/text-extractor',
      run: async () => 'not-json'
    })
    const unsupported = await inspectFocusedInput({
      platform: 'win32',
      helper: () => '/native/text-extractor',
      run: async () => '{"state":"safe"}'
    })

    expect(safe).toEqual({ state: 'safe' })
    expect(invalid).toEqual({ state: 'safe' })
    expect(invalid).not.toHaveProperty('value')
    expect(malformed).toEqual({ state: 'unknown' })
    expect(unsupported).toEqual({ state: 'unknown' })
  })
})
