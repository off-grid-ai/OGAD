import { describe, expect, it } from 'vitest'
import {
  detectThinkingDialect,
  supportsThinkingToggle,
  thinkingFragmentFor
} from '../thinking-dialect'

describe('thinking dialect', () => {
  it('detects the control exposed by the model template', () => {
    expect(detectThinkingDialect(undefined)).toBe('none')
    expect(detectThinkingDialect('plain assistant template')).toBe('none')
    expect(detectThinkingDialect('{% if enable_thinking %}')).toBe('enable-thinking')
    expect(detectThinkingDialect('{{ reasoning_strength }}')).toBe('reasoning-strength')
  })

  it('builds only the request fragment that the selected dialect understands', () => {
    expect(thinkingFragmentFor('enable-thinking', true)).toEqual({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_format: 'deepseek'
    })
    expect(thinkingFragmentFor('enable-thinking', false)).toEqual({
      chat_template_kwargs: { enable_thinking: false }
    })
    expect(thinkingFragmentFor('reasoning-strength', true)).toEqual({
      chat_template_kwargs: { reasoning_strength: 'high' }
    })
    expect(thinkingFragmentFor('reasoning-strength', false)).toEqual({
      chat_template_kwargs: { reasoning_strength: 'none' }
    })
    expect(thinkingFragmentFor('none', true)).toEqual({})
  })

  it('offers a toggle only when the template can act on it', () => {
    expect(supportsThinkingToggle('enable-thinking')).toBe(true)
    expect(supportsThinkingToggle('reasoning-strength')).toBe(true)
    expect(supportsThinkingToggle('none')).toBe(false)
  })
})
