import { describe, expect, it } from 'vitest'
import { isStagedDecisionModel } from '../task-model-rules'

describe('isStagedDecisionModel', () => {
  it('finds a decision-eval folder on macOS, Linux and Windows paths', () => {
    expect(
      isStagedDecisionModel({ files: [{ name: '/Users/me/models/decision-eval/d.gguf' }] })
    ).toBe(true)
    expect(isStagedDecisionModel({ files: [{ name: 'C:\\models\\Decision-Eval\\d.gguf' }] })).toBe(
      true
    )
  })

  it('leaves ordinary models alone, including a file merely named like the folder', () => {
    expect(isStagedDecisionModel({ files: [{ name: '/Users/me/models/qwen.gguf' }] })).toBe(false)
    expect(isStagedDecisionModel({ files: [{ name: 'decision-eval.gguf' }] })).toBe(false)
    expect(isStagedDecisionModel({})).toBe(false)
  })
})
