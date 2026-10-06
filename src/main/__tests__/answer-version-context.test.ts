import { describe, expect, it } from 'vitest'
import { parseAnswerVersions, withShownVersion } from '../answer-version-context'

describe('withShownVersion', () => {
  it("keeps the answer's thinking, tools and metrics, and sets the version shown", () => {
    const before = JSON.stringify({ reasoning: 'r', toolCalls: [{ name: 'x' }], variantIndex: 1 })
    expect(JSON.parse(withShownVersion(before, { variants: ['a', 'b'], variantIndex: 0 }))).toEqual(
      {
        reasoning: 'r',
        toolCalls: [{ name: 'x' }],
        variants: ['a', 'b'],
        variantIndex: 0
      }
    )
  })
  it('starts from nothing for no context or one that is not an object', () => {
    for (const before of [null, 'not json', '[1,2]']) {
      expect(
        JSON.parse(withShownVersion(before, { variants: ['a', 'b'], variantIndex: 1 }))
      ).toEqual({
        variants: ['a', 'b'],
        variantIndex: 1
      })
    }
  })
})

describe('parseAnswerVersions', () => {
  it('accepts versions with an index inside them, and nothing else', () => {
    expect(parseAnswerVersions({ variants: ['a', 'b'], variantIndex: 1 })).toEqual({
      variants: ['a', 'b'],
      variantIndex: 1
    })
    for (const bad of [
      null,
      {},
      { variants: ['a'], variantIndex: 1 },
      { variants: [1], variantIndex: 0 },
      { variants: ['a'], variantIndex: 0.5 }
    ]) {
      expect(parseAnswerVersions(bad)).toBeNull()
    }
  })
})
