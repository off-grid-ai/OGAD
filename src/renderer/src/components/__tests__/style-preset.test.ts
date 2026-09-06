import { describe, expect, it } from 'vitest'
import { imageStylePrompt } from '../image-style-presets'

describe('imageStylePrompt', () => {
  it('keeps the rendered style and prompt modifier under one owner', () => {
    expect(imageStylePrompt('Photoreal')).toContain('photorealistic')
    expect(imageStylePrompt('Unknown style')).toBeNull()
    expect(imageStylePrompt(null)).toBeNull()
  })
})
