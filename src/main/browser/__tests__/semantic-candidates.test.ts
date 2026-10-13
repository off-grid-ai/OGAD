import { describe, expect, it, vi } from 'vitest'
import { keepValidCandidates } from '../semantic-candidates'

const parse = (value: unknown): { action: string; ref: string } => {
  const v = value as { action?: string; ref?: string }
  if (v.action === 'click' && !v.ref) throw new Error('click requires ref.')
  return { action: v.action ?? '', ref: v.ref ?? '' }
}

describe('keepValidCandidates', () => {
  it('drops a malformed proposal and keeps the valid ones', () => {
    // Found on a real run: Qwen 3.5 9B proposed a click with no ref beside valid actions, and
    // the one bad proposal failed the whole web task.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(
      keepValidCandidates(
        [{ action: 'click' }, { action: 'done', ref: 'e2' }, { action: 'click', ref: 'e1' }],
        parse
      )
    ).toEqual([
      { action: 'done', ref: 'e2' },
      { action: 'click', ref: 'e1' }
    ])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails with the validator error when no proposal is valid', () => {
    expect(() => keepValidCandidates([{ action: 'click' }], parse)).toThrow('click requires ref.')
    expect(() => keepValidCandidates([], parse)).toThrow('No candidate action was proposed.')
  })
})
