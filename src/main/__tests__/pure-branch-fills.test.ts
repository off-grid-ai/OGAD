// Remaining single-branch fills for two already-well-covered pure modules. Each
// case targets one uncovered branch left by the module's main test file:
//   - llama-error: an "unknown architecture" stderr with NO quoted arch name.
//   - chat-health: "ready" when there is no active model (the ?? undefined branch).
import { describe, it, expect } from 'vitest'
import { classifyLlamaError } from '../llama-error'
import { decideChatStatus } from '../chat-health'

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
