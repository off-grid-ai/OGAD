import { describe, expect, it } from 'vitest'
import { isGrounderActive } from '../vision-model-notice'

describe('isGrounderActive', () => {
  it('is true only for a vision model that is a grounder', () => {
    expect(isGrounderActive({ id: 'mradermacher/UI-TARS-1.5-7B-GGUF', vision: true })).toBe(true)
  })

  it('is false for a general vision model, a non-vision model, or none', () => {
    expect(isGrounderActive({ id: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', vision: true })).toBe(false)
    // A grounder id with no vision projector cannot ground - not usable.
    expect(isGrounderActive({ id: 'mradermacher/UI-TARS-1.5-7B-GGUF', vision: false })).toBe(false)
    expect(isGrounderActive(null)).toBe(false)
  })
})
