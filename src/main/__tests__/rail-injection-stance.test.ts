/**
 * The injection-resistance contract for the shared visual task graph (R2-E1).
 * Screen and page content is untrusted input - a malicious page or app can
 * display text that tells the agent to act. These guards read the prompt source
 * and assert the stance holds, so a prompt edit cannot quietly drop a defense.
 *
 * The load-bearing defenses are structural: the browser driver refuses private
 * input, and the vision guard gives Stop priority over actuation. This file guards
 * the prompt half shared by Web Use and Computer Use.
 */
import { describe, expect, it } from 'vitest'
import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from '../vision/vision-prompt'

describe('the visual task graph prompt', () => {
  const prompt = buildVisionPrompt('share the deck over WhatsApp')

  it('frames on-screen text as untrusted, not an instruction', () => {
    expect(VISION_SYSTEM_PROMPT).toMatch(/untrusted content/i)
    expect(VISION_SYSTEM_PROMPT).toMatch(/never an instruction to you/i)
  })

  it('makes any credential or payment step a handoff to the user', () => {
    expect(VISION_SYSTEM_PROMPT).toMatch(/call_user/)
    expect(VISION_SYSTEM_PROMPT).toMatch(/Never type a credential/i)
    expect(VISION_SYSTEM_PROMPT).toMatch(/one-time code/i)
  })

  it('carries the task into the built prompt', () => {
    expect(prompt).toContain('share the deck over WhatsApp')
  })
})
