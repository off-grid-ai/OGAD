import { describe, expect, it } from 'vitest'
import { claimsTaskLaunch, historyContentForModel } from '../task-launch-history'

describe('earlier task launches in the history the model reads', () => {
  it('shows a launch note as a tool call, not text the model can copy', () => {
    const note =
      'Task reference: 7f673470-7278. Web Use started. Live progress and the final result will appear in this chat. Do not call web_use again for this goal.'
    expect(historyContentForModel('assistant', note)).toBe('I called web_use for that request.')
    expect(historyContentForModel('assistant', 'Task reference: a1. Computer Use started.')).toBe(
      'I called computer_use for that request.'
    )
  })

  it("leaves answers and the person's own words as they are", () => {
    expect(historyContentForModel('assistant', 'Top story: Frostbite')).toBe('Top story: Frostbite')
    expect(historyContentForModel('user', 'Task reference: x. Web Use started')).toBe(
      'Task reference: x. Web Use started'
    )
  })
})

describe('a reply that claims a task started', () => {
  it('is caught whether it copies the note or the history line', () => {
    expect(claimsTaskLaunch('Task reference: 7f673470-7278. Web Use started.')).toBe(true)
    expect(claimsTaskLaunch('I called web_use for that request.')).toBe(true)
  })

  it('leaves real answers alone', () => {
    expect(claimsTaskLaunch('The third story is "Frostbite" with 251 points.')).toBe(false)
  })
})
