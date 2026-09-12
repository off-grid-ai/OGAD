import { describe, expect, it } from 'vitest'
import { parseTaggedChatOutput } from '../tagged-chat'

describe('Desktop tagged-chat capture adapter', () => {
  it('keeps the timestamp that was active when each message started', () => {
    const captured = [
      '[CHAT_TITLE] Shipping question',
      '[METADATA] Today 09:41',
      '[USER] Where is my order?',
      '[OCR] It was due yesterday.',
      '[METADATA] Today 09:42',
      '[ASSISTANT] I found the shipment.',
      '[OCR] It will arrive tomorrow.'
    ].join('\n')

    expect(parseTaggedChatOutput(captured).messages).toEqual([
      {
        role: 'user',
        content: 'Where is my order?\nIt was due yesterday.',
        timestamp: 'Today 09:41'
      },
      {
        role: 'assistant',
        content: 'I found the shipment.\nIt will arrive tomorrow.',
        timestamp: 'Today 09:42'
      }
    ])
  })
})
