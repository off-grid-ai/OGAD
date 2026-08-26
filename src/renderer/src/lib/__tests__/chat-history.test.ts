// D8 — a send's history must come from the TARGET conversation, not the active
// tab. sendMessage built history from `messages` (the active tab's slice) even for
// a send bound to another conversation (a drained queue item / a background regen),
// so the model answered one conversation with another's transcript.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
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

describe('MemoryChat builds send history from the target conversation (D8 wiring)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'components', 'MemoryChat.tsx'), 'utf8')

  it('no longer builds history from the active-tab `messages` slice', () => {
    // The exact buggy construction that fed the active tab's transcript to a send
    // bound to another conversation.
    expect(src).not.toMatch(/base\s*=\s*\[\s*\.\.\.messages/)
    expect(src).not.toMatch(/messages\.slice\(0,\s*lastUserIdx/)
  })

  it('builds history via buildSendHistory from the target conversation', () => {
    expect(src).toMatch(/buildSendHistory\(\s*messagesByConv\[convId\]/)
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
