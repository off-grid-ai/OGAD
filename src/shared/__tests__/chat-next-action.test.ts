import { describe, expect, it } from 'vitest'
import { cleanSuggestion, suggestionMessages } from '../chat-next-action'

describe('suggested next message', () => {
  it('uses the conversation for Desktop and keeps the browser prompt available', () => {
    const desktop = suggestionMessages({
      asked: 'Compare A and B',
      answer: 'A is faster',
      surface: 'desktop'
    })
    expect(desktop[0]!.content).toContain('in this conversation')
    expect(desktop[0]!.content).not.toContain('browser assistant')
    expect(desktop[1]!.content).toContain('A is faster')
    const browser = suggestionMessages({
      asked: 'Check notifications',
      answer: 'Two replies',
      pageTitle: 'Reddit'
    })
    expect(browser[0]!.content).toContain('browser assistant')
    expect(browser[1]!.content).toContain('Reddit')
  })

  it('bounds the conversation text used for a suggestion', () => {
    const messages = suggestionMessages({ asked: 'A'.repeat(10000), answer: 'B'.repeat(10000) })
    expect(messages[1]!.content.length).toBeLessThan(1200)
  })

  it.each(['NONE', '', 'x', 'A'.repeat(91)])('omits unusable suggestions: %s', (text) => {
    expect(cleanSuggestion(text)).toBeNull()
  })

  it('removes reasoning and presentation wrappers', () => {
    expect(
      cleanSuggestion('<think>Private reasoning</think>\nSuggestion: "Compare both options."')
    ).toBe('Compare both options')
  })
})
