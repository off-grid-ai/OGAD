import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDecisionRequest } from '../llm'
import { parseRemoteDecision } from '../accessibility/decision-model-loader'
import {
  buildOpenRouterDecisionRequest,
  decideWithOpenRouter,
  openRouterDecisionsEndpoint,
  parseOpenRouterDecisionResponse,
  usesOpenRouterDecisions
} from '../accessibility/remote-decision'

afterEach(() => vi.unstubAllGlobals())

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

describe('OpenRouter Decisions transport', () => {
  it('selects the dedicated transport from model capability metadata', () => {
    expect(
      usesOpenRouterDecisions({
        provider: 'openrouter',
        endpoint: 'https://openrouter.ai/api/v1',
        model: '~typesafe/jev-latest',
        apiKey: 'stored-key',
        modelCatalog: [
          {
            id: '~typesafe/jev-latest',
            name: 'TypeSafe: Jev Latest',
            kind: 'text',
            outputModalities: ['decisions']
          }
        ]
      })
    ).toBe(true)
  })

  it('builds the provider Decisions endpoint and typed choice request', () => {
    expect(openRouterDecisionsEndpoint('https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/alpha/decisions'
    )
    expect(
      buildOpenRouterDecisionRequest('typesafe/jev-1.13', 'screen state', 'Next action?', [
        'Click Save',
        'Wait'
      ])
    ).toEqual({
      model: 'typesafe/jev-1.13',
      state: { context: 'screen state' },
      questions: {
        decision: {
          type: 'choice',
          instructions: 'Next action?',
          criteria: { option_0: 'Click Save', option_1: 'Wait' }
        }
      }
    })
  })

  it('maps a Decisions choice distribution to the shared result', () => {
    expect(
      parseOpenRouterDecisionResponse(
        {
          answers: {
            decision: {
              type: 'choice',
              choice: 'option_1',
              probabilities: { option_0: 0.2, option_1: 0.8 }
            }
          }
        },
        2
      )
    ).toEqual({ choice: 1, confidence: 0.8, probabilities: [0.2, 0.8] })
  })

  it('uses one-hot probabilities when the provider omits a distribution', () => {
    expect(
      parseOpenRouterDecisionResponse(
        { answers: { decision: { type: 'choice', choice: 'option_0' } } },
        2
      )
    ).toEqual({ choice: 0, confidence: 1, probabilities: [1, 0] })
    expect(() =>
      parseOpenRouterDecisionResponse(
        { answers: { decision: { type: 'choice', choice: 'option_9' } } },
        2
      )
    ).toThrow('invalid choice')
  })

  it('calls the Decisions endpoint with authorization and parses its response', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              decision: {
                type: 'choice',
                choice: 'option_1',
                probabilities: { option_0: 1, option_1: 3 }
              }
            }
          }),
          { status: 200 }
        )
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      decideWithOpenRouter(
        {
          provider: 'openrouter',
          endpoint: 'https://openrouter.ai/api/v1/',
          model: 'typesafe/jev',
          apiKey: 'secret'
        },
        'state',
        'Next?',
        ['Wait', 'Open']
      )
    ).resolves.toEqual({ choice: 1, confidence: 0.75, probabilities: [0.25, 0.75] })
    expect(fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/alpha/decisions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' })
      })
    )
  })

  it('reports HTTP and connection failures with bounded provider detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'quota reached' } }), { status: 429 })
      )
    )
    const remote = {
      provider: 'openrouter' as const,
      endpoint: 'https://openrouter.ai/api/v1',
      model: 'typesafe/jev',
      apiKey: ''
    }
    await expect(decideWithOpenRouter(remote, 'state', 'Next?', ['Wait'])).rejects.toThrow(
      'HTTP 429: quota reached'
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline')))
    )
    await expect(decideWithOpenRouter(remote, 'state', 'Next?', ['Wait'])).rejects.toThrow(
      'connection failed: offline'
    )
    expect(() => openRouterDecisionsEndpoint('https://example.com/api')).toThrow('ends in /v1')
  })
})
