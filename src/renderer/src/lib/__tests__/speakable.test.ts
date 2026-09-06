// Exercises the REAL remark parser (no mocks) — the whole point is that a genuine
// CommonMark+GFM AST, not regex, decides what is formatting vs. text.
import { describe, it, expect } from 'vitest'
import { toSpeakableText } from '../speakable'

describe('toSpeakableText — markdown to speech via the real AST', () => {
  it('strips emphasis regardless of the surrounding punctuation', () => {
    // The em-dash case the old regex read aloud as literal asterisks.
    expect(toSpeakableText('asking—*are you really here*, or just... *on screen*.')).toBe(
      'asking—are you really here, or just... on screen.'
    )
    expect(toSpeakableText('(*paren*) and end—*dash*. **Bold**, _under_, ~~gone~~.')).not.toMatch(
      /[*_~]/
    )
  })

  it('keeps literal multiplication and identifier underscores (not emphasis)', () => {
    expect(toSpeakableText('The result is 2 * 3 and the key is release_candidate.')).toBe(
      'The result is 2 * 3 and the key is release_candidate.'
    )
  })

  it('drops link URLs and image syntax but keeps their text/alt', () => {
    expect(toSpeakableText('See the [local guide](https://secret.invalid/p?token=1).')).toBe(
      'See the local guide.'
    )
    expect(toSpeakableText('![a red square](blob:xyz)')).toBe('a red square')
  })

  it('does not pronounce or crash on reference definitions', () => {
    expect(
      toSpeakableText('Read this answer.\n\n[private-source]: https://secret.invalid/token')
    ).toBe('Read this answer.')
  })

  it('separates list items and headings so speech does not run together', () => {
    expect(toSpeakableText('# Title\n\n- first item\n- second item')).toBe(
      'Title\nfirst item\nsecond item'
    )
  })

  it('never pronounces raw HTML markup', () => {
    expect(toSpeakableText('Line with <br> inline and <span>tags</span> here.')).not.toMatch(/[<>]/)
  })

  it('returns empty for formatting-only input', () => {
    expect(toSpeakableText('***\n`  `')).toBe('')
    expect(toSpeakableText('')).toBe('')
  })
})
