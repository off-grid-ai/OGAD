// Remaining single-branch fills for three already-well-covered pure modules. Each
// case targets one uncovered branch left by the module's main test file:
//   - llama-error: an "unknown architecture" stderr with NO quoted arch name.
//   - chat-health: "ready" when there is no active model (the ?? undefined branch).
//   - search-ranking: matchScore ignoring an empty-string term (the `t ?` false arm).
import { describe, it, expect } from 'vitest'
import { classifyLlamaError } from '../llama-error'
import { decideChatStatus } from '@offgrid/application'
import { matchScore } from '../search-ranking'

describe('classifyLlamaError - architecture without a quoted name', () => {
  it('reports engine_outdated with the generic reason when no arch is quoted', () => {
    const f = classifyLlamaError('error: unknown model architecture detected during load')
    expect(f?.code).toBe('engine_outdated')
    expect(f?.reason).toContain('The model engine is too old for this model.')
    // The generic branch omits the parenthetical arch name.
    expect(f?.reason).not.toContain('(')
  })
})

describe('decideChatStatus - ready with no active model', () => {
  it('returns ready with undefined detail when activeModel is null', () => {
    expect(
      decideChatStatus({ healthy: true, loading: false, modelsExist: true, activeModel: null })
    ).toEqual({ status: 'ready', detail: undefined })
  })

  it('returns ready with undefined detail when activeModel is omitted', () => {
    expect(decideChatStatus({ healthy: true, loading: false, modelsExist: true })).toEqual({
      status: 'ready',
      detail: undefined
    })
  })
})

describe('matchScore - empty term is ignored', () => {
  it('skips an empty-string term (the falsy-term branch) but still counts real ones', () => {
    expect(matchScore('grid grid grid', ['', 'grid'])).toBe(3)
  })

  it('an all-empty term list scores 0', () => {
    expect(matchScore('grid', ['', ''])).toBe(0)
  })
})
