import { describe, it, expect } from 'vitest'
import {
  buildAssistantContext,
  readPersistedChatSessionTurn,
  readReasoning,
  readResponseCutoff
} from '../message-persistence'

describe('message-persistence carrier', () => {
  it('round-trips the canonical Shared transcript and keeps old rows compatible', () => {
    const responseMessages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call-a', name: 'weather', arguments: '{}' }]
      },
      { role: 'tool' as const, content: 'Clear', toolCallId: 'call-a', name: 'weather' },
      { role: 'assistant' as const, content: 'It is clear.' }
    ]
    const ctx = buildAssistantContext(undefined, {
      session: { turnId: 'turn-a', status: 'completed', responseMessages }
    })

    expect(readPersistedChatSessionTurn(ctx)).toEqual({
      turnId: 'turn-a',
      status: 'completed',
      responseMessages
    })
    expect(readPersistedChatSessionTurn({ reasoning: 'legacy row' })).toBeUndefined()
  })

  it('round-trips reasoning through the context blob', () => {
    const ctx = buildAssistantContext(undefined, { reasoning: 'weighing the options' })
    expect(readReasoning(ctx)).toBe('weighing the options')
  })

  it('returns undefined (no empty-string noise) when reasoning is absent', () => {
    const ctx = buildAssistantContext(undefined, {})
    expect(ctx).toBeUndefined()
    expect(readReasoning(ctx)).toBeUndefined()
  })

  it('does not attach a reasoning key for blank/whitespace reasoning', () => {
    const ctx = buildAssistantContext({ toolCalls: [] }, { reasoning: '   ' })
    expect(ctx).toEqual({ toolCalls: [] })
    expect('reasoning' in (ctx as object)).toBe(false)
    expect(readReasoning(ctx)).toBeUndefined()
  })

  it('preserves existing context fields alongside reasoning', () => {
    const base = {
      unified: [{ id: 1 }],
      toolCalls: [{ name: 'search', result: 'ok' }],
      image: 'img/123.png',
      attachments: [{ path: 'a.txt' }]
    }
    const ctx = buildAssistantContext(base, { reasoning: 'because X' })
    expect(ctx).toMatchObject(base)
    expect(readReasoning(ctx)).toBe('because X')
  })

  it('keeps base context intact when no reasoning is provided', () => {
    const base = { unified: [], toolCalls: [{ name: 't', result: 'r' }] }
    const ctx = buildAssistantContext(base, {})
    expect(ctx).toEqual(base)
    expect(readReasoning(ctx)).toBeUndefined()
  })

  it('does not mutate the base context object', () => {
    const base = { image: 'x.png' }
    const ctx = buildAssistantContext(base, { reasoning: 'r' })
    expect(base).toEqual({ image: 'x.png' })
    expect(ctx).not.toBe(base)
  })

  it('readReasoning tolerates non-object / malformed input', () => {
    expect(readReasoning(undefined)).toBeUndefined()
    expect(readReasoning(null)).toBeUndefined()
    expect(readReasoning('not-json')).toBeUndefined()
    expect(readReasoning({ reasoning: 42 })).toBeUndefined()
  })

  it('round-trips the configured response cutoff with other assistant metadata', () => {
    const cutoff = { reason: 'max_tokens' as const, maxTokens: 4096 }
    const ctx = buildAssistantContext({ unified: [] }, { reasoning: 'why', cutoff })

    expect(readResponseCutoff(ctx)).toEqual(cutoff)
    expect(readReasoning(ctx)).toBe('why')
    expect(ctx).toMatchObject({ unified: [] })
  })

  it('ignores malformed persisted cutoff values', () => {
    expect(readResponseCutoff({ cutoff: { reason: 'stop', maxTokens: 4096 } })).toBeUndefined()
    expect(readResponseCutoff({ cutoff: { reason: 'max_tokens', maxTokens: 1.5 } })).toBeUndefined()
    expect(
      readResponseCutoff({ cutoff: { reason: 'max_tokens', maxTokens: '4096' } })
    ).toBeUndefined()
  })
})
