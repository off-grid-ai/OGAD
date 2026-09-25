import { describe, expect, it } from 'vitest'
import { toolPromptChars as serializedToolPromptChars } from '@offgrid/models'
import { toolPromptChars } from '../prompt-budget'

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
