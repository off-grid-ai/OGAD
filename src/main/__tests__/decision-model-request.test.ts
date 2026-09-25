import { describe, expect, it } from 'vitest'
import { buildDecisionRequest } from '../llm'

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
