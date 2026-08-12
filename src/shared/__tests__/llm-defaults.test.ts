import { describe, it, expect } from 'vitest'
import { DEFAULT_CTX_SIZE, MIN_CAPTURE_CTX_SIZE } from '../llm-defaults'

// DRY guard: backend field default and the Settings UI both read this. Assert
// the canonical value so the three-way ctxSize disagreement can't reappear.
describe('llm defaults', () => {
  it('pins the default context size', () => {
    expect(DEFAULT_CTX_SIZE).toBe(16384)
    expect(DEFAULT_CTX_SIZE).toBeGreaterThanOrEqual(MIN_CAPTURE_CTX_SIZE * 2)
  })
})
