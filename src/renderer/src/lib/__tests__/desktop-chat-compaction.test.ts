import { describe, expect, it, vi } from 'vitest'
import { DesktopChatCompaction } from '../desktop-chat-compaction'
import type { DesktopChatSessionBoundary } from '../desktop-chat-session-contract'

function boundary(overrides: Partial<DesktopChatSessionBoundary> = {}): DesktopChatSessionBoundary {
  return {
    ragChat: vi.fn(),
    onRagStream: vi.fn(() => () => undefined),
    cancelRag: vi.fn(),
    generateText: vi.fn(async () => 'the summary'),
    getLlmSettings: vi.fn(async () => ({ ctxSize: 8192, effectiveCtxSize: 2000 })),
    ...overrides
  }
}

const identity = { conversationId: 'conv', turnId: 'turn' }
const history = Array.from({ length: 10 }, (_, index) => ({
  role: index % 2 ? ('assistant' as const) : ('user' as const),
  content: `history ${index} ${'x'.repeat(380)}`
}))
const rounds = [
  {
    role: 'assistant' as const,
    content: '',
    toolCalls: [{ id: 'c', name: 'search', arguments: '{}' }]
  },
  { role: 'tool' as const, name: 'search', toolCallId: 'c', content: 'result' },
  { role: 'assistant' as const, content: 'partial answer' }
]
const signal = new AbortController().signal

describe('DesktopChatCompaction', () => {
  it('recognises the Desktop overflow wording and the raw llama-server one', () => {
    const compaction = new DesktopChatCompaction(boundary())
    expect(
      compaction.isCapacityError(
        new Error(
          "Error invoking remote method 'rag:chat': Error: The request is larger than the model’s context window — usually too many connectors enabled at once."
        )
      )
    ).toBe(true)
    expect(
      compaction.isCapacityError(new Error('the request exceeds the available context size'))
    ).toBe(true)
    expect(compaction.isCapacityError(new Error('LLM Server Error: 500'))).toBe(false)
  })

  it('keeps the running turn verbatim, summarizes earlier history, and reads the live window', async () => {
    const b = boundary()
    const compaction = new DesktopChatCompaction(b)
    const compacted = await compaction.compact({
      identity,
      messages: [{ role: 'system', content: 'sys' }, ...history, ...rounds],
      responseMessages: rounds,
      error: new Error('overflow'),
      partial: { content: 'partial answer', reasoning: '' },
      signal
    })
    expect(compacted).not.toBeNull()
    const list = compacted!
    expect(b.getLlmSettings).toHaveBeenCalled()
    expect(b.generateText).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ role: 'system' })]),
      { maxTokens: expect.any(Number) }
    )
    expect(list.some((message) => message.role === 'system')).toBe(false)
    expect(list[0]).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('the summary')
    })
    expect(list.slice(-3)).toEqual(rounds)
    expect(list.some((message) => 'id' in message)).toBe(false)
  })

  it('returns null when Desktop lacks the generation or settings port', async () => {
    const compaction = new DesktopChatCompaction(boundary({ generateText: undefined }))
    const result = await compaction.compact({
      identity,
      messages: history,
      responseMessages: [],
      error: new Error('overflow'),
      partial: { content: '', reasoning: '' },
      signal
    })
    expect(result).toBeNull()
  })
})
