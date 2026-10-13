import { describe, expect, it } from 'vitest'
import type { SemanticDecision } from '../browser-playwright-policy'
import { isUncertainActionTimeout, uncertainActionKey } from '../browser-playwright-task-support'

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
