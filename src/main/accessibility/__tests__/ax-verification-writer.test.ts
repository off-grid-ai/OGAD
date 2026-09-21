import { describe, expect, it } from 'vitest'
import { compactWriterPrompt, parseWriterResult, writerValueMatches } from '../ax-writer'
import {
  evaluatePostcondition,
  verifyPostcondition,
  type VerificationObservation
} from '../ax-verification'
import type { NormalizedCandidate } from '../ax-state'

function candidate(value: string): NormalizedCandidate {
  return {
    id: 'field-1',
    displayIndex: 1,
    source: 'ax',
    role: 'AXTextField',
    label: 'Message',
    value,
    bounds: { x: 0, y: 0, width: 100, height: 30 },
    center: { x: 50, y: 15 },
    enabled: true,
    snapshotId: 'snapshot',
    revision: 1,
    windowId: 'window',
    processId: 10,
    risk: 'reversible'
  }
}

function observation(value: string, title = 'Compose'): VerificationObservation {
  return { windowId: 'window', processId: 10, windowTitle: title, candidates: [candidate(value)] }
}

describe('bounded deterministic verification', () => {
  it('evaluates exact target effects, unsatisfied states, and unknown states', () => {
    expect(
      evaluatePostcondition(
        { type: 'field_value', candidateId: 'field-1', value: 'hello' },
        observation(''),
        observation('hello')
      )
    ).toBe('satisfied')
    expect(
      evaluatePostcondition(
        {
          type: 'candidate_effect',
          candidateId: 'field-1',
          before: { value: '', enabled: true }
        },
        observation(''),
        observation('sent')
      )
    ).toBe('satisfied')
    expect(
      evaluatePostcondition(
        { type: 'field_value', candidateId: 'field-1', value: 'hello' },
        observation(''),
        observation('wrong')
      )
    ).toBe('unsatisfied')
    expect(
      evaluatePostcondition(
        { type: 'field_value', candidateId: 'missing', value: 'hello' },
        observation(''),
        observation('hello')
      )
    ).toBe('unknown')
    expect(
      evaluatePostcondition(
        { type: 'window_state_change', processId: 10, previousTitle: 'Compose' },
        observation(''),
        observation('', 'Unrelated animation')
      )
    ).toBe('unknown')
  })

  it('uses stable bounded samples and never converts unknown to success', async () => {
    let clock = 0
    const result = await verifyPostcondition(
      { type: 'field_value', candidateId: 'missing', value: 'hello' },
      observation(''),
      async () => observation(''),
      {
        timeoutMs: 100,
        pollIntervalMs: 25,
        now: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds
        }
      }
    )
    expect(result.status).toBe('unknown')
    expect(result.samples).toBeGreaterThan(1)
  })
})

describe('bounded free-text writer', () => {
  const input = {
    milestone: 'Send the requested greeting.',
    field: { role: 'AXTextField', label: 'Message', placeholder: 'Write a message', value: '' },
    nearbyText: ['Conversation with Sam'],
    recentActionResult: 'The composer is focused.',
    guidance: ['Use the exact greeting from the task.']
  }

  it('uses a small structured input and parses optional submit', () => {
    const prompt = compactWriterPrompt(input)
    const result = parseWriterResult('{"fill":true,"text":"Hello","submit":true}', input)
    expect(prompt.length).toBeLessThan(2_500)
    expect(result).toEqual({ fill: true, text: 'Hello', submit: true })
    expect(writerValueMatches('Hello  world', 'Hello world')).toBe(true)
  })

  it('refuses password and payment fields', () => {
    const privateInput = { ...input, field: { ...input.field, label: 'Card password' } }
    expect(parseWriterResult('{"fill":true,"text":"secret","submit":true}', privateInput)).toEqual({
      fill: false,
      text: '',
      submit: false,
      refusalReason: 'private_field'
    })
  })
})
