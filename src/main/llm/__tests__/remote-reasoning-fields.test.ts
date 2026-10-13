import { describe, expect, it } from 'vitest'
import { remoteReasoningFields } from '../remote-chat'

// The one place Chat and the gateway turn a remote model's reasoning on or off.
describe('remoteReasoningFields', () => {
  it('never switches off reasoning an OpenRouter model requires', () => {
    // OpenRouter answers HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled".
    expect(remoteReasoningFields(false, 512, { control: 'openrouter', mandatory: true })).toEqual({})
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
})
