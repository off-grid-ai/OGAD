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

  it('returns null when Desktop has generation but no llama settings port', async () => {
    const b = boundary({ getLlmSettings: undefined })
    const compaction = new DesktopChatCompaction(b)
    const result = await compaction.compact({
      identity,
      messages: history,
      responseMessages: [],
      error: new Error('overflow'),
      partial: { content: '', reasoning: '' },
      signal
    })
    expect(result).toBeNull()
    expect(b.generateText).not.toHaveBeenCalled()
  })

  it('falls back to the configured ctxSize when llama reports no effective window', async () => {
    async function summaryBudget(settings: {
      ctxSize?: number
      effectiveCtxSize?: number
    }): Promise<number | undefined> {
      const b = boundary({ getLlmSettings: vi.fn(async () => settings) })
      const compacted = await new DesktopChatCompaction(b).compact({
        identity,
        messages: history,
        responseMessages: [],
        error: new Error('overflow'),
        partial: { content: '', reasoning: '' },
        signal
      })
      expect(compacted).not.toBeNull()
      const call = vi.mocked(b.generateText!).mock.calls[0]
      return call?.[1]?.maxTokens
    }
    const effective = await summaryBudget({ ctxSize: 8192, effectiveCtxSize: 2000 })
    const configuredOnly = await summaryBudget({ ctxSize: 2000 })
    const wide = await summaryBudget({ ctxSize: 8192 })
    expect(effective).toEqual(expect.any(Number))
    expect(configuredOnly).toBe(effective)
    // The whole history fits an 8192 window, so nothing is summarized: the window was ctxSize.
    expect(wide).toBeUndefined()
  })

  it('feeds the summary it persisted last time into the next compaction of the same conversation', async () => {
    const b = boundary()
    const compaction = new DesktopChatCompaction(b)
    const context = {
      identity,
      messages: history,
      responseMessages: [],
      error: new Error('overflow'),
      partial: { content: '', reasoning: '' },
      signal
    }
    await compaction.compact(context)
    await compaction.compact(context)
    await compaction.compact({ ...context, identity: { conversationId: 'other', turnId: 'turn' } })

    const prompts = vi
      .mocked(b.generateText!)
      .mock.calls.map((call) => String(call[0].at(-1)!.content))
    expect(prompts[0]).not.toContain('Previous summary:')
    expect(prompts[1]).toContain('Previous summary:\nthe summary')
    expect(prompts[2]).not.toContain('Previous summary:')
  })
})
