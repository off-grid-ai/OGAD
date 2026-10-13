import { describe, it, expect } from 'vitest'
import { extractSystemText, sanitizeChatMessages, parseDecisionChatMessages } from '../chat-messages'

describe('Desktop remote decision requests', () => {
  it('preserves multiline context and options for the pointer-head engine', () => {
    expect(parseDecisionChatMessages([{ role: 'user', content: 'Context:\nA screen\nwith buttons\nQuestion: What next?\nOptions:\n0: Click Save\nKeep this choice\n1: Cancel' }])).toEqual({
      context: 'A screen\nwith buttons', question: 'What next?', options: ['Click Save\nKeep this choice', 'Cancel']
    })
  })
  it('accepts text content blocks used by OpenAI clients', () => {
    expect(parseDecisionChatMessages([{ role: 'user', content: [{ type: 'text', text: 'Context:\nReady\nQuestion: Next?\nOptions:\n0: Go\n1: Stop' }] }]).options).toEqual(['Go', 'Stop'])
  })
  it('rejects ordinary chat and incomplete option numbering', () => {
    expect(() => parseDecisionChatMessages([{ role: 'user', content: 'Hello' }])).toThrow('Decision requests')
    expect(() => parseDecisionChatMessages([{ role: 'user', content: 'Context:\nReady\nQuestion: Next?\nOptions:\n0: Go\n2: Stop' }])).toThrow('consecutively')
  })
})

describe('extractSystemText', () => {
  it('returns a plain string as-is', () => {
    expect(extractSystemText('hello')).toBe('hello')
  })

  it('returns empty for a non-array, non-string content', () => {
    expect(extractSystemText(null)).toBe('')
    expect(extractSystemText(42)).toBe('')
    expect(extractSystemText({})).toBe('')
  })

  it('joins text parts with newlines', () => {
    expect(
      extractSystemText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' }
      ])
    ).toBe('a\nb')
  })

  it('includes nested string content from tool blocks', () => {
    expect(extractSystemText([{ type: 'tool_result', content: 'tool ctx' }])).toBe('tool ctx')
  })

  it('drops parts with no readable text', () => {
    expect(
      extractSystemText([{ type: 'text' }, { type: 'image' }, { type: 'text', text: 'x' }])
    ).toBe('x')
  })

  it('prefers text over nested content on a part with both', () => {
    expect(extractSystemText([{ type: 'text', text: 'shown', content: 'ignored' }])).toBe('shown')
  })
})

describe('sanitizeChatMessages', () => {
  it('returns false for a non-object body', () => {
    expect(sanitizeChatMessages(null)).toBe(false)
    expect(sanitizeChatMessages('nope')).toBe(false)
  })

  it('returns false when messages is missing or empty', () => {
    expect(sanitizeChatMessages({})).toBe(false)
    expect(sanitizeChatMessages({ messages: [] })).toBe(false)
    expect(sanitizeChatMessages({ messages: 'x' })).toBe(false)
  })

  it('returns false when there is no out-of-position system message', () => {
    const body = {
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(false)
    // unchanged
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' }
    ])
  })

  it('returns false for a conversation with no system messages at all', () => {
    const body = {
      messages: [
        { role: 'user', content: 'u' },
        { role: 'assistant', content: 'a' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(false)
  })

  it('merges a mid-conversation system message into a leading one', () => {
    const body = {
      messages: [
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'mid' },
        { role: 'assistant', content: 'a1' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'lead\n\nmid' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' }
    ])
  })

  it('creates a leading system message when none is at position 0', () => {
    const body = {
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'sys ctx' },
        { role: 'assistant', content: 'a1' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys ctx' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' }
    ])
  })

  it('merges multiple out-of-position system messages in order', () => {
    const body = {
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'first' },
        { role: 'user', content: 'u2' },
        { role: 'system', content: 'second' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'first\n\nsecond' },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' }
    ])
  })

  it('extracts array-shaped system content when merging', () => {
    const body = {
      messages: [
        { role: 'user', content: 'u1' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'block a' },
            { type: 'text', text: 'block b' }
          ]
        }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'block a\nblock b' })
  })

  it('keeps a lead system message untouched when there is no extra text to append', () => {
    // The mid system message has only whitespace content -> nothing appended.
    const body = {
      messages: [
        { role: 'system', content: 'lead' },
        { role: 'user', content: 'u1' },
        { role: 'system', content: '   ' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(true)
    expect(body.messages).toEqual([
      { role: 'system', content: 'lead' },
      { role: 'user', content: 'u1' }
    ])
  })

  it('flattens an array-shaped lead system content when appending extras', () => {
    const body = {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'lead' }] },
        { role: 'user', content: 'u1' },
        { role: 'system', content: 'mid' }
      ]
    }
    expect(sanitizeChatMessages(body)).toBe(true)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'lead\n\nmid' })
  })
})
