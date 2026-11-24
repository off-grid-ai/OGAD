import { describe, expect, it } from 'vitest'
import { remoteReasoningFields } from '../remote-chat'

// The one place Chat and the gateway turn a remote model's reasoning on or off.
describe('remoteReasoningFields', () => {
  it('never switches off reasoning an OpenRouter model requires', () => {
    // OpenRouter answers HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled".
    expect(remoteReasoningFields(false, 512, { control: 'openrouter', mandatory: true })).toEqual(
      {}
    )
  })

  it('switches it off when the model allows that, and on with the budget', () => {
    expect(remoteReasoningFields(false, 512, { control: 'openrouter' })).toEqual({
      reasoning: { effort: 'none' }
    })
    expect(remoteReasoningFields(true, 512, { control: 'openrouter' })).toHaveProperty('reasoning')
  })

  it('leaves a request alone when nobody asked or the model has no control', () => {
    expect(remoteReasoningFields(undefined, 512, { control: 'openrouter' })).toEqual({})
    expect(remoteReasoningFields(false, 512, { control: 'none' })).toEqual({})
  })

  it('still caps thinking on a llama.cpp model whose template has no thinking switch', () => {
    expect(remoteReasoningFields(true, 512, { control: 'none', tokenBudget: true })).toEqual({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget_tokens: 512
    })
    expect(remoteReasoningFields(true, 512, { control: 'none' })).toEqual({})
  })

  it("turns thinking off with llama.cpp's reasoning_effort, and leaves the effort level to the template", () => {
    const capability = { control: 'none' as const, tokenBudget: true, reasoningEffort: true }
    expect(remoteReasoningFields(true, 512, capability)).toEqual({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget_tokens: 512
    })
    expect(remoteReasoningFields(false, 512, capability)).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'none'
    })
  })
})
