import { describe, expect, it } from 'vitest'
import { buildAssistantContext, readResponseVariants } from '../message-persistence'
import { mapRagMessages, mergeDurableAndStreaming } from '../../components/MemoryChat/helper'
import type { ChatMessage } from '../../components/MemoryChat/types'

describe('saved response versions', () => {
  it('restores earlier answers and the selected version through stored JSON', () => {
    const context = buildAssistantContext(undefined, {
      variants: ['First answer', 'New answer'],
      variantIndex: 0,
      reasoning: 'Reasoning'
    })
    const restored = mapRagMessages([
      {
        id: 1,
        uuid: 'answer',
        role: 'assistant',
        content: 'New answer',
        context: JSON.stringify(context),
        created_at: '2026-10-11T00:00:00.000Z'
      }
    ])
    expect(restored[0]?.variants).toEqual(['First answer', 'New answer'])
    expect(restored[0]?.variantIndex).toBe(0)
    expect(restored[0]?.reasoning).toBe('Reasoning')
  })

  it('ignores malformed or absent version data', () => {
    for (const context of [null, {}, { variants: ['Only answer'] }, { variants: ['Answer', 1] }]) {
      expect(readResponseVariants(context)).toBeUndefined()
    }
  })

  it.each([undefined, null, -1, 2, 0.5, '0'])(
    'selects the latest saved answer for invalid index %s',
    (variantIndex) => {
      const [restored] = mapRagMessages([
        {
          id: 1,
          uuid: 'answer',
          role: 'assistant',
          content: 'Latest answer',
          context: JSON.stringify({ variants: ['Earlier answer', 'Latest answer'], variantIndex }),
          created_at: '2026-10-11T00:00:00.000Z'
        }
      ])
      expect(restored?.variantIndex).toBe(1)
      expect(restored?.variants).toEqual(['Earlier answer', 'Latest answer'])
    }
  )

  it('retains a stopped empty answer as a version without losing the prior answer', () => {
    const context = buildAssistantContext(
      { status: 'cancelled' },
      {
        variants: ['Saved answer', ''],
        reasoning: 'Partial reasoning'
      }
    )
    const [restored] = mapRagMessages([
      {
        id: 1,
        uuid: 'answer',
        role: 'assistant',
        content: '',
        context: JSON.stringify(context),
        created_at: '2026-10-11T00:00:00.000Z'
      }
    ])
    expect(restored?.variants).toEqual(['Saved answer', ''])
    expect(restored?.variantIndex).toBe(1)
    expect(restored?.reasoning).toBe('Partial reasoning')
  })

  it('shows the replacement stream once while the previous answer remains durable', () => {
    const user: ChatMessage = { id: 'user', role: 'user', content: 'Question' }
    const prior: ChatMessage = { id: 'saved-answer', role: 'assistant', content: 'Saved answer' }
    const stream: ChatMessage = {
      id: 'new-stream',
      role: 'assistant',
      content: 'Partial answer',
      streaming: true,
      replacementMessageId: 'saved-answer',
      variants: ['Saved answer', ''],
      variantIndex: 1
    }
    const durable = [user, prior]
    expect(mergeDurableAndStreaming(durable, [user, stream])).toEqual([user, stream])
    expect(durable).toEqual([user, prior])
    expect(mergeDurableAndStreaming(durable, [])).toEqual(durable)
  })

  it('restores the durable completed version when the local replacement is no longer streaming', () => {
    const saved: ChatMessage = {
      id: 'saved-answer',
      role: 'assistant',
      content: 'New answer',
      variants: ['Old answer', 'New answer'],
      variantIndex: 0
    }
    const local: ChatMessage = {
      ...saved,
      id: 'old-stream',
      replacementMessageId: saved.id,
      streaming: false,
      variantIndex: 1
    }
    expect(mergeDurableAndStreaming([saved], [local])).toEqual([saved])
  })
})
