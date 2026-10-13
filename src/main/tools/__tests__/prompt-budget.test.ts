import { describe, expect, it } from 'vitest'
import { toolPromptChars as serializedToolPromptChars } from '@offgrid/models'
import { toolPromptChars, toolPromptTokens } from '../prompt-budget'

describe('vision-aware prompt budget', () => {
  it('keeps text-only estimates unchanged', () => {
    const messages = [{ role: 'user', content: 'Describe this system.' }]
    const tools = [{ type: 'function', function: { name: 'inspect' } }]

    expect(toolPromptChars(messages, tools)).toBe(serializedToolPromptChars(messages, tools))
  })

  it('counts vision embeddings instead of base64 transport bytes', () => {
    const image = `data:image/png;base64,${'a'.repeat(320_000)}`
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this diagram.' },
          { type: 'image_url', image_url: { url: image } }
        ]
      }
    ]

    expect(serializedToolPromptChars(messages)).toBeGreaterThan(300_000)
    expect(toolPromptChars(messages)).toBeLessThan(16_384 * 4)
    expect(toolPromptChars(messages)).toBeGreaterThan(2_048 * 4)
  })

  it('keeps separate vision allowances for separate images', () => {
    const one = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${'a'.repeat(50_000)}` } }
        ]
      }
    ]
    const two = [
      {
        role: 'user',
        content: [
          ...one[0]!.content,
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${'b'.repeat(50_000)}` } }
        ]
      }
    ]

    expect(toolPromptChars(two) - toolPromptChars(one)).toBeGreaterThan(2_048 * 4)
  })
})

describe('toolPromptTokens', () => {
  it('counts Japanese and Chinese text by script, so CJK chats compact in time', () => {
    const english = [{ role: 'user', content: 'a'.repeat(4000) }]
    const japanese = [{ role: 'user', content: 'あ'.repeat(4000) }]
    const chinese = [{ role: 'user', content: '中'.repeat(4000) }]
    // About 1,000 tokens of English text, but about 2,700 of the same length in CJK.
    expect(toolPromptTokens(english)).toBeLessThan(1_100)
    expect(toolPromptTokens(japanese)).toBeGreaterThan(2_600)
    expect(toolPromptTokens(chinese)).toBeGreaterThan(2_600)
  })

  it('still charges an inline image as a fixed vision allowance', () => {
    const image = 'data:image/png;base64,' + 'A'.repeat(500_000)
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }]
    expect(toolPromptTokens(messages)).toBeLessThan(2_200)
  })
})
