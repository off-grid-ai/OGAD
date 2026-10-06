import { describe, expect, it } from 'vitest'
import { answerAfter, priorVersions, showVersion } from '../answer-versions'

const user = (content: string) => ({ role: 'user', content })
const answer = (content: string, variants?: string[], variantIndex?: number) => ({
  role: 'assistant',
  content,
  ...(variants ? { variants } : {}),
  ...(variantIndex === undefined ? {} : { variantIndex })
})

describe('priorVersions', () => {
  it('keeps the replaced answer as an earlier version', () => {
    expect(priorVersions(answer('first'))).toEqual(['first'])
  })
  it('keeps every version an answer already had', () => {
    expect(priorVersions(answer('second', ['first', 'second'], 1))).toEqual(['first', 'second'])
  })
  it('has nothing to keep for no answer, an empty one, or a user turn', () => {
    expect(priorVersions(undefined)).toBeNull()
    expect(priorVersions(answer('  '))).toBeNull()
    expect(priorVersions(user('q'))).toBeNull()
  })
})

describe('answerAfter', () => {
  it("finds the answer Resend on a user turn replaces, not a later turn's", () => {
    const thread = [user('q1'), answer(''), answer('a1'), user('q2'), answer('a2')]
    expect(answerAfter(thread, 0)?.content).toBe('a1')
    expect(answerAfter(thread, 3)?.content).toBe('a2')
    expect(answerAfter([user('q'), user('q again')], 0)).toBeUndefined()
  })
})

describe('showVersion', () => {
  it("shows the chosen version's own text, not just a new counter", () => {
    expect(showVersion(answer('second', ['first', 'second'], 1), -1)).toEqual({
      content: 'first',
      variantIndex: 0
    })
    expect(showVersion(answer('first', ['first', 'second'], 0), 1)).toEqual({
      content: 'second',
      variantIndex: 1
    })
  })
  it('stays put at either end, and for an answer with one version', () => {
    expect(showVersion(answer('first', ['first', 'second'], 0), -1)).toBeNull()
    expect(showVersion(answer('second', ['first', 'second']), 1)).toBeNull()
    expect(showVersion(answer('only'), 1)).toBeNull()
  })
})
