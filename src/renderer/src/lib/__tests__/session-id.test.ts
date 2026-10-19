import { describe, it, expect } from 'vitest'
import { parseSessionId } from '../session-id'

describe('parseSessionId — split a session id into display parts', () => {
  it('splits model from a dash-separated title', () => {
    const p = parseSessionId('gemma-my-first-chat')
    expect(p.modelName).toBe('gemma')
    expect(p.chatTitle).toBe('my first chat')
    expect(p.readableTitle).toBe('My first chat') // first letter capitalized
    expect(p.llmLabel).toBe('Gemma')
  })

  it('names the model segment with the shared resolver', () => {
    // model = everything before the FIRST dash; the label reads as a name, not a token.
    expect(parseSessionId('llama_3_1-a-chat').llmLabel).toBe('Llama 3 1')
  })

  it('has no model and labels LLM when there is no dash', () => {
    const p = parseSessionId('standalone')
    expect(p.modelName).toBeUndefined()
    expect(p.llmLabel).toBe('LLM')
    // title is the whole id, capitalized
    expect(p.readableTitle).toBe('Standalone')
  })

  it('falls back to the raw id when the title part is empty', () => {
    // "gemma-" -> model 'gemma', empty title -> readableTitle is the raw id
    const p = parseSessionId('gemma-')
    expect(p.modelName).toBe('gemma')
    expect(p.chatTitle).toBe('')
    expect(p.readableTitle).toBe('gemma-')
  })

  it('does not treat a leading dash as a model boundary (indexOf > 0)', () => {
    // firstDashIndex === 0 -> no model; whole string is the title source
    const p = parseSessionId('-weird')
    expect(p.modelName).toBeUndefined()
    expect(p.chatTitle).toBe(' weird') // '-weird'.split('-').join(' ')
  })
})
