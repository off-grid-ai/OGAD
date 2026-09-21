import { describe, expect, it } from 'vitest'
import { buildDecisionRequest } from '../llm'
import { parseRemoteDecision } from '../accessibility/decision-model-loader'

describe('Decision model request', () => {
  it('uses the media marker published by the active llama server', () => {
    const marker = '<__media_random-server-value__>'
    const request = buildDecisionRequest('Choose one', 3, 'base64-image', marker)

    expect(request.prompt).toEqual({
      prompt_string: `${marker}\nChoose one`,
      multimodal_data: ['base64-image']
    })
    expect(request.grammar).toBe('root ::= [ABC]')
  })

  it('rejects an image request when the server did not publish a marker', () => {
    expect(() => buildDecisionRequest('Choose one', 2, 'base64-image')).toThrow(
      'The local model server did not publish its media marker.'
    )
  })
})

describe('Remote Decision model output', () => {
  it('normalizes a provider-neutral JSON probability distribution', () => {
    expect(parseRemoteDecision('```json\n{"choice":1,"probabilities":[2,6,2]}\n```', 3)).toEqual({
      choice: 1,
      confidence: 0.6,
      probabilities: [0.2, 0.6, 0.2]
    })
  })

  it('accepts a label and uses a one-hot distribution when probabilities are absent', () => {
    expect(parseRemoteDecision('{"choice":"C"}', 3)).toEqual({
      choice: 2,
      confidence: 1,
      probabilities: [0, 0, 1]
    })
  })
})
