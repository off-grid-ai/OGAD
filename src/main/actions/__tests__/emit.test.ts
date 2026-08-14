/**
 * Emission hardening: one case per repair branch, and the discipline that
 * an unrepairable emission is rejected, never guessed.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  actionProposalJsonSchema,
  emitActionProposal,
  extractBalancedObject,
  parseEmission
} from '../emit'

const valid = {
  type: 'reminder',
  intent: 'remind me to send the deck at 6pm',
  args: { title: 'Send the deck' },
  risk: 'mutate'
}
const validJson = JSON.stringify(valid)

describe('actionProposalJsonSchema', () => {
  it('constrains type to the registered handlers, not the full vocabulary', () => {
    const schema = actionProposalJsonSchema(['reminder', 'open'])
    const properties = schema.properties as Record<string, { enum?: string[] } | undefined>
    expect(properties.type?.enum).toEqual(['reminder', 'open'])
  })

  it('requires the proposal fields and forbids extras', () => {
    const schema = actionProposalJsonSchema(['reminder'])
    expect(schema.required).toEqual(['type', 'intent', 'args', 'risk'])
    expect(schema.additionalProperties).toBe(false)
  })
})

describe('extractBalancedObject', () => {
  it('finds the object inside prose and respects braces in strings', () => {
    const text = 'Sure! Here it is: {"a": "curly } inside", "b": {"c": 1}} - hope that helps'
    expect(extractBalancedObject(text)).toBe('{"a": "curly } inside", "b": {"c": 1}}')
  })

  it('handles escaped quotes inside strings', () => {
    const text = 'prefix {"a": "say \\"hi\\" loudly", "b": 1} suffix'
    expect(extractBalancedObject(text)).toBe('{"a": "say \\"hi\\" loudly", "b": 1}')
  })

  it('returns undefined when no object closes', () => {
    expect(extractBalancedObject('nothing here')).toBeUndefined()
    expect(extractBalancedObject('{"never": "closes"')).toBeUndefined()
  })
})

describe('parseEmission - one case per repair branch', () => {
  it('clean JSON parses as-is', () => {
    expect(parseEmission(validJson)).toEqual({ ok: true, proposal: valid })
  })

  it('a markdown fence is stripped', () => {
    const result = parseEmission('```json\n' + validJson + '\n```')
    expect(result.ok).toBe(true)
  })

  it('surrounding prose is cut away', () => {
    const result = parseEmission(`Sure, here's the action you asked for:\n${validJson}\nLet me know!`)
    expect(result.ok).toBe(true)
  })

  it('a trailing comma is repaired', () => {
    const raw = `{"type": "reminder", "intent": "x", "args": {"title": "y",}, "risk": "mutate",}`
    const result = parseEmission(raw)
    expect(result.ok).toBe(true)
  })

  it('bare keys are quoted', () => {
    const raw = `{type: "reminder", intent: "x", args: {title: "y"}, risk: "mutate"}`
    const result = parseEmission(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.args).toEqual({ title: 'y' })
    }
  })

  it('a missing optional args falls back to the schema default', () => {
    const raw = `{"type": "lookup", "intent": "what is on my calendar", "risk": "read"}`
    const result = parseEmission(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.proposal.args).toEqual({})
    }
  })

  it('an unrepairable emission is rejected, never guessed', () => {
    const result = parseEmission('I am sorry, I cannot create reminders.')
    expect(result.ok).toBe(false)
  })

  it('a repaired but invalid proposal still fails closed, with the reason', () => {
    const raw = `Here: {"type": "teleport", "intent": "x", "args": {}, "risk": "mutate"}`
    const result = parseEmission(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/type/)
    }
  })

  it('an engine-owned field on the proposal is a rejection (strict schema)', () => {
    const raw = JSON.stringify({ ...valid, id: 'act_1', state: 'ready' })
    expect(parseEmission(raw).ok).toBe(false)
  })
})

describe('emitActionProposal - bounded retry with the error fed back', () => {
  it('a clean first answer needs no retry', async () => {
    const ask = vi.fn(async () => validJson)
    const result = await emitActionProposal(ask)
    expect(result.ok).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith(undefined)
  })

  it('a bad first answer retries once with the validation error in the feedback', async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('cannot do')
      .mockResolvedValueOnce(validJson)
    const result = await emitActionProposal(ask)
    expect(result.ok).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
    const feedback = ask.mock.calls[1]?.[0] as string
    expect(feedback).toMatch(/not a valid action/)
    expect(feedback).toMatch(/ONLY the corrected JSON/)
  })

  it('exhausted attempts reject with the last error - never a guess', async () => {
    const ask = vi.fn(async () => 'still nonsense')
    const result = await emitActionProposal(ask, { maxAttempts: 3 })
    expect(result.ok).toBe(false)
    expect(ask).toHaveBeenCalledTimes(3)
  })
})
