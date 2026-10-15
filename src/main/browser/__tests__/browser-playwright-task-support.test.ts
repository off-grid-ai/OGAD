import { describe, expect, it } from 'vitest'
import type { SemanticDecision } from '../browser-playwright-policy'
import { VisionGuard } from '../../vision/vision-guard'
import type { BrowserPlaywrightTaskInput } from '../browser-playwright-task-contract'
import {
  observeWithCurrentLease,
  isUncertainActionTimeout,
  uncertainActionKey
} from '../browser-playwright-task-support'

function decision(overrides: Partial<SemanticDecision> = {}): SemanticDecision {
  return {
    action: 'click',
    phase_id: null,
    element: 'Place order',
    ref: 'e1',
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: '',
    summary: 'Place order',
    ...overrides
  }
}

describe('uncertain browser actions', () => {
  it('treats an input timeout at the CDP boundary as uncertain', () => {
    expect(
      isUncertainActionTimeout(decision(), 'The browser did not answer cdp.send in time.')
    ).toBe(true)
    expect(
      isUncertainActionTimeout(
        decision({ action: 'press_key', key: 'Enter' }),
        'Protocol error (Input.dispatchKeyEvent): Electron debugger Input.dispatchKeyEvent timed out'
      )
    ).toBe(true)
  })

  it('does not classify preflight, navigation, or ordinary errors as uncertain', () => {
    expect(isUncertainActionTimeout(decision(), 'Playwright relay page sync timed out')).toBe(false)
    expect(isUncertainActionTimeout(decision(), 'Timeout 30000ms exceeded')).toBe(false)
    expect(
      isUncertainActionTimeout(
        decision({ action: 'navigate' }),
        'The browser did not answer cdp.send in time.'
      )
    ).toBe(false)
  })

  it('identifies the same action across new page references', () => {
    expect(uncertainActionKey(decision({ ref: 'e9' }))).toBe(uncertainActionKey(decision()))
    expect(uncertainActionKey(decision({ element: 'Cancel' }))).not.toBe(
      uncertainActionKey(decision())
    )
  })
})

describe('semantic image observations', () => {
  function input(): BrowserPlaywrightTaskInput {
    return {
      goal: 'Read the saved result',
      plan: { version: 1, phases: [{ id: 'phase-1', title: 'Read the result' }] },
      guard: new VisionGuard({ taskId: 'semantic-image', kind: 'web_use' }),
      session: {
        snapshot: async () => ({ text: 'status "Saved" [ref=s1]', isError: false }),
        recoverPage: async () => {
          throw new Error('Unexpected recovery')
        },
        call: async () => {
          throw new Error('Unexpected action')
        }
      },
      activeDriver: () => null,
      activeUrl: () => 'https://example.test/result',
      waitForUser: async () => undefined,
      takeGuidance: () => [],
      onStep: () => undefined,
      onPhase: () => undefined,
      onProgress: () => undefined
    }
  }

  it('returns the captured frame with its semantic observation', async () => {
    const task = input()
    const screenshot = { image: '/frames/current.png', bounds: { width: 1200, height: 750 } }
    task.captureObservationImage = async () => screenshot
    expect(await observeWithCurrentLease(task)).toEqual({
      text: 'status "Saved" [ref=s1]',
      isError: false,
      screenshot
    })
  })

  it('discards both the snapshot and frame when input control changes during capture', async () => {
    const task = input()
    let captures = 0
    task.captureObservationImage = async () => {
      captures += 1
      if (captures === 1) {
        task.guard.pause()
        task.guard.resume()
      }
      return { image: `/frames/${captures}.png`, bounds: { width: 1200, height: 750 } }
    }
    expect((await observeWithCurrentLease(task)).screenshot?.image).toBe('/frames/2.png')
  })

  it('keeps text-only sessions usable without a capture provider', async () => {
    expect(await observeWithCurrentLease(input())).toEqual({
      text: 'status "Saved" [ref=s1]',
      isError: false
    })
  })

  it('does not silently remove an image when its capture fails', async () => {
    const task = input()
    task.captureObservationImage = async () => {
      throw new Error('Capture unavailable')
    }
    await expect(observeWithCurrentLease(task)).rejects.toThrow('Capture unavailable')
  })
})
