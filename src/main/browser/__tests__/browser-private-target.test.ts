import { describe, expect, it } from 'vitest'
import { isPrivateSemanticTarget } from '../browser-playwright-actions'
import type { SemanticDecision } from '../browser-playwright-policy'

const SNAPSHOT = [
  '- textbox "Email" [ref=e1]',
  '- textbox "Password" [ref=e2]',
  '- checkbox "I am human" [ref=e3]',
  '- button "Create Account" [ref=e4]',
  '- iframe "Widget containing checkbox for hCaptcha security challenge" [ref=e5]'
].join('\n')

const decision = (
  action: SemanticDecision['action'],
  ref: string,
  element = ''
): SemanticDecision => ({ action, ref, element }) as SemanticDecision

describe('isPrivateSemanticTarget', () => {
  it('hands a human check to the user, whatever the action', () => {
    // Found live: the model set out to "Click the 'I am human' checkbox".
    expect(isPrivateSemanticTarget(decision('click', 'e3'), SNAPSHOT)).toBe(true)
    expect(isPrivateSemanticTarget(decision('click', 'e5'), SNAPSHOT)).toBe(true)
    expect(isPrivateSemanticTarget(decision('click', 'e9', "I'm not a robot"), SNAPSHOT)).toBe(true)
  })

  it('hands typing a secret to the user, and leaves ordinary steps to the agent', () => {
    expect(isPrivateSemanticTarget(decision('type', 'e2'), SNAPSHOT)).toBe(true)
    expect(isPrivateSemanticTarget(decision('type', 'e1'), SNAPSHOT)).toBe(false)
    expect(isPrivateSemanticTarget(decision('click', 'e4'), SNAPSHOT)).toBe(false)
    // Clicking a password box is not typing into it.
    expect(isPrivateSemanticTarget(decision('click', 'e2'), SNAPSHOT)).toBe(false)
    expect(isPrivateSemanticTarget({ action: 'done' } as SemanticDecision, SNAPSHOT)).toBe(false)
  })
})
