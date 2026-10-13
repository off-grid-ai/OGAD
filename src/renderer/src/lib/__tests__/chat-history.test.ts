// D8 — a send's history must come from the TARGET conversation, not the active
// tab. sendMessage built history from `messages` (the active tab's slice) even for
// a send bound to another conversation (a drained queue item / a background regen),
// so the model answered one conversation with another's transcript.

import { describe, it, expect } from 'vitest'
import { buildSendHistory } from '../chat-history'

const turn = (role: string, content: string): { role: string; content: string } => ({
  role,
  content
})

describe('buildSendHistory (D8)', () => {
  it('appends the new user turn on a normal send', () => {
    const convA = [turn('user', 'A1'), turn('assistant', 'A2')]
    expect(buildSendHistory(convA, false, 'A3')).toEqual([
      turn('user', 'A1'),
      turn('assistant', 'A2'),
      turn('user', 'A3')
    ])
  })

  it('on regen keeps up to and including the last user turn (drops replies after it)', () => {
    const conv = [
      turn('user', 'q1'),
      turn('assistant', 'a1'),
      turn('user', 'q2'),
      turn('assistant', 'a2-old')
    ]
    expect(buildSendHistory(conv, true, 'ignored-on-regen')).toEqual([
      turn('user', 'q1'),
      turn('assistant', 'a1'),
      turn('user', 'q2')
    ])
  })

  it('history reflects the conversation PASSED in — not any other thread (the D8 fix)', () => {
    const convA = [turn('user', 'this is conversation A')]
    const out = buildSendHistory(convA, false, 'follow-up in A')
    const text = JSON.stringify(out)
    expect(text).toContain('this is conversation A')
    expect(text).not.toContain('conversation B') // B's transcript can never leak in
  })

  it('caps to the last `limit` turns', () => {
    const many = Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `m${i}`))
    expect(buildSendHistory(many, false, 'newest', 20)).toHaveLength(20)
  })
})

describe('selected answer history', () => {
  const answer = {
    role: 'assistant',
    content: 'Latest answer',
    variants: ['Earlier answer', 'Latest answer'],
    variantIndex: 0
  }

  it('sends the selected earlier answer as follow-up context', () => {
    expect(buildSendHistory([turn('user', 'Question'), answer], false, 'Follow up')).toEqual([
      turn('user', 'Question'),
      turn('assistant', 'Earlier answer'),
      turn('user', 'Follow up')
    ])
  })

  it('sends the selected latest answer when the user moves forward', () => {
    expect(buildSendHistory([{ ...answer, variantIndex: 1 }], false, 'Follow up')).toEqual([
      turn('assistant', 'Latest answer'),
      turn('user', 'Follow up')
    ])
  })

  it.each([undefined, -1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to saved content for invalid selection %s',
    (variantIndex) => {
      expect(buildSendHistory([{ ...answer, variantIndex }], false, 'Follow up')).toEqual([
        turn('assistant', 'Latest answer'),
        turn('user', 'Follow up')
      ])
    }
  )

  it('falls back to saved content when the version list is absent', () => {
    expect(buildSendHistory([{ ...answer, variants: undefined }], false, 'Follow up')).toEqual([
      turn('assistant', 'Latest answer'),
      turn('user', 'Follow up')
    ])
  })

  it('uses the selected answer in excerpts after compaction', () => {
    const history = buildSendHistory(
      [
        turn('user', 'Original question'),
        answer,
        { ...turn('assistant', '_Compacted_'), notice: true },
        turn('user', 'Current question')
      ],
      false,
      'Follow up'
    )
    expect(history[0]?.content).toContain('Assistant: Earlier answer')
    expect(JSON.stringify(history)).not.toContain('Latest answer')
    expect(history.slice(1)).toEqual([turn('user', 'Current question'), turn('user', 'Follow up')])
  })

  it('sends the saved summary in place of every compacted turn', () => {
    const history = buildSendHistory(
      [
        turn('user', 'Plan a trip to Lisbon'),
        turn('assistant', 'Here is a long four-day plan with every museum.'),
        turn('user', 'Make it three days'),
        {
          ...turn('assistant', '_Compacted_'),
          notice: true,
          context: { notice: true, compactionSummary: '## Goal\nA three-day Lisbon trip.' }
        },
        turn('assistant', 'Here is the three-day plan.')
      ],
      false,
      'Add a day trip'
    )

    expect(history[0]?.role).toBe('user')
    expect(history[0]?.content).toMatch(/^Summary of the earlier conversation/)
    expect(history[0]?.content).toContain('## Goal\nA three-day Lisbon trip.')
    expect(JSON.stringify(history)).not.toContain('every museum')
    expect(JSON.stringify(history)).not.toContain('Earlier chat excerpts')
    expect(history.slice(1)).toEqual([
      turn('user', 'Make it three days'),
      turn('assistant', 'Here is the three-day plan.'),
      turn('user', 'Add a day trip')
    ])
  })

  it('does not replace a user message with an answer version', () => {
    expect(buildSendHistory([{ ...answer, role: 'user' }], false, 'Follow up')).toEqual([
      turn('user', 'Latest answer'),
      turn('user', 'Follow up')
    ])
  })

  it('keeps task guidance visible in Chat but out of the resident model history', () => {
    expect(
      buildSendHistory(
        [
          { role: 'user', content: 'Start the task' },
          {
            role: 'user',
            content: 'Use a one-way flight',
            context: { taskGuidance: { taskId: 'task-1' } }
          }
        ],
        false,
        'What did you find?'
      )
    ).toEqual([
      { role: 'user', content: 'Start the task' },
      { role: 'user', content: 'What did you find?' }
    ])
  })
})
