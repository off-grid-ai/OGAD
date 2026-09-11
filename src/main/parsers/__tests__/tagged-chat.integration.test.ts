/**
 * Real native-capture text through the Desktop tagged-chat adapter. The fixture is the text shape
 * produced at the OCR/accessibility boundary; all parsing and conversation projection stay real.
 */
import { describe, expect, it } from 'vitest'
import { createNoiseFilter, createRoleLabelDetector, parseTaggedChatOutput } from '../tagged-chat'

describe('Desktop tagged-chat capture adapter', () => {
  it('projects tagged native capture into ordered messages with current metadata', () => {
    const captured = [
      '[WINDOW_TITLE] Support conversation — Browser',
      '[BROWSER_URL] https://example.com/support/42',
      '[CHAT_TITLE] Shipping question',
      '[METADATA] Today 09:41',
      '[USER] Where is my order?',
      '[OCR] It was due yesterday.',
      '[METADATA] Today 09:42',
      '[ASSISTANT] I found the shipment.',
      '[OCR] It will arrive tomorrow.',
      '[TITLE] Decorative heading'
    ].join('\n')

    expect(parseTaggedChatOutput(captured)).toEqual({
      messages: [
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
      ],
      chatTitle: 'Shipping question',
      windowTitle: 'Support conversation — Browser',
      browserUrl: 'https://example.com/support/42'
    })
  })

  it('uses product-specific role labels and removes native chrome without losing content', () => {
    const detectRoleLabel = createRoleLabelDetector([
      { label: 'you', role: 'user' },
      { label: 'off grid', role: 'assistant' }
    ])
    const isNoiseLine = createNoiseFilter({
      literals: ['copy', 'retry'],
      prefixes: ['reaction:'],
      patterns: [/^\d+ unread messages?$/]
    })
    const captured = [
      '[METADATA] 10:05',
      'You Draft a reply',
      'Copy',
      'Keep this detail.',
      'Off Grid',
      'Here is the reply.',
      'Reaction: thumbs up',
      '2 unread messages',
      'Retry',
      'Final detail.'
    ].join('\n')

    expect(parseTaggedChatOutput(captured, { detectRoleLabel, isNoiseLine })).toEqual({
      messages: [
        { role: 'user', content: 'Draft a reply\nKeep this detail.', timestamp: '10:05' },
        { role: 'assistant', content: 'Here is the reply.\nFinal detail.', timestamp: '10:05' }
      ],
      chatTitle: undefined,
      windowTitle: undefined,
      browserUrl: undefined
    })
  })
})
