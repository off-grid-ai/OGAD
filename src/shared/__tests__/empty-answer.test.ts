import { describe, expect, it } from 'vitest'
import { emptyAnswerReason } from '../empty-answer'

describe('emptyAnswerReason', () => {
  it('says the allowance ran out, and how to give it more', () => {
    // Reported: a God turn showed "No response returned." with no reason.
    expect(emptyAnswerReason('length', 1200)).toMatch(/1200 tokens.*Settings > Text/)
  })

  it('names a provider block and any other empty finish plainly', () => {
    expect(emptyAnswerReason('content_filter', 1)).toMatch(/blocked/)
    expect(emptyAnswerReason('stop', 1)).toMatch(/without an answer/)
    expect(emptyAnswerReason(null, 1)).toMatch(/without an answer/)
  })
})
