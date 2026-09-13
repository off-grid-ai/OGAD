// D10 — a streamed chat must honor the caller's requested max_tokens, not silently
// cap at the persisted setting. chatStream once built `this.maxTokens || maxTokens`,
// so the setting (always truthy) won and the caller's value was DEAD. The rule now
// lives in resolveMaxTokens, shared by all three chat entry points.

import { describe, it, expect } from 'vitest'
import { resolveMaxTokens, maxTokensForWire, MAX_TOKENS_AUTO } from '../gen-params'

describe('resolveMaxTokens (D10)', () => {
  it('honors an explicit per-call request over the setting', () => {
    // The exact case the old `setting || requested` got wrong: a turn asking for
    // more than the setting must NOT be truncated to the setting.
    expect(resolveMaxTokens(4096, 2048)).toBe(4096)
    expect(resolveMaxTokens(200, 2048)).toBe(200)
  })

  it('falls back to the persisted setting when the caller omits it', () => {
    expect(resolveMaxTokens(undefined, 2048)).toBe(2048)
    expect(resolveMaxTokens(undefined, 4096)).toBe(4096)
  })

  it('passes the auto sentinel through when that is the setting', () => {
    expect(resolveMaxTokens(undefined, MAX_TOKENS_AUTO)).toBe(MAX_TOKENS_AUTO)
  })
})

describe('maxTokensForWire — auto maps to the engine unlimited (-1)', () => {
  it('maps the auto sentinel to n_predict = -1 (until EOS / window full)', () => {
    expect(maxTokensForWire(MAX_TOKENS_AUTO)).toBe(-1)
  })
  it('treats any non-positive value as auto', () => {
    expect(maxTokensForWire(0)).toBe(-1)
    expect(maxTokensForWire(-1)).toBe(-1)
  })
  it('passes a positive hard cap straight through', () => {
    expect(maxTokensForWire(8192)).toBe(8192)
    expect(maxTokensForWire(2048)).toBe(2048)
  })
  it('auto is the sentinel 0 (a real cap of 0 would be meaningless)', () => {
    expect(MAX_TOKENS_AUTO).toBe(0)
  })
})
