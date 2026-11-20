import { describe, expect, it } from 'vitest'
import { visibleToolResult } from '../chat-tool-projection'

describe('a task waiting for approval in the transcript', () => {
  it('says where to approve it, for new and stored notes alike', () => {
    const shown = 'Waiting for your approval in Actions > Approvals, or on your phone.'
    expect(
      visibleToolResult(
        'Task reference: t1. "Read the news": Waiting for the user\'s approval in Actions > Approvals in Off Grid AI Desktop, or on any paired phone; it runs once they approve.'
      )
    ).toBe(shown)
    expect(
      visibleToolResult(
        '"gmail_send" on Gmail: Waiting for the user\'s approval in Action Approval; it runs once they approve.'
      )
    ).toBe(shown)
  })
})
