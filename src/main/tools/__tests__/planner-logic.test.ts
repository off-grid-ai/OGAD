/**
 * The planner's pure core: it plans only when the request is action-y, routes by
 * the tool catalog, fills args, parses fail-closed, and resolves a contact
 * handle for the recipient binding.
 */
import { describe, expect, it } from 'vitest'
import {
  shouldPlan,
  buildPlannerPrompt,
  parsePlan,
  resolveContactHandle,
  type ToolCatalogEntry
} from '../planner-logic'

const catalog: ToolCatalogEntry[] = [
  { name: 'web_task', description: 'Do something on a website; always set url.' },
  { name: 'open_url', description: 'Opens a page only, no interaction.' },
  { name: 'contacts_search', description: 'Find a contact by name.' },
  { name: 'messages_send', description: 'Send an iMessage.' }
]
const names = catalog.map((c) => c.name)

describe('shouldPlan', () => {
  it('plans action requests', () => {
    expect(shouldPlan('play Family Guy on YouTube')).toBe(true)
    expect(shouldPlan('message Dishit saying hi')).toBe(true)
    expect(shouldPlan('open the deck and share it')).toBe(true)
  })

  it('skips plain questions / chit-chat', () => {
    expect(shouldPlan('what is the capital of France?')).toBe(false)
    expect(shouldPlan('how does photosynthesis work')).toBe(false)
    expect(shouldPlan('')).toBe(false)
  })

  it('still plans a question that contains an action verb', () => {
    // "can you send X" is a question opener but a real action.
    expect(shouldPlan('can you send a message to sidd')).toBe(true)
  })
})

describe('buildPlannerPrompt', () => {
  it('lists the tools and encodes the routing + arg-filling rules', () => {
    const p = buildPlannerPrompt('play X on YouTube', [], catalog)
    expect(p).toContain('- web_task:')
    expect(p).toContain('play X on YouTube')
    expect(p).toMatch(/open_url only OPENS/i)
    expect(p).toMatch(/Fill EVERY required argument/i)
    expect(p).toMatch(/\{"steps":\[\]\}/) // the conversational escape hatch
  })
})

describe('parsePlan', () => {
  it('keeps well-formed steps and normalizes bindings', () => {
    const plan = parsePlan(
      JSON.stringify({
        steps: [
          { tool: 'web_task', args: { goal: 'play X', url: 'https://youtube.com' }, why: 'interactive' },
          {
            tool: 'messages_send',
            args: { text: 'hi' },
            bindings: [{ arg: 'to', fromStep: 0, field: 'phone' }]
          }
        ]
      }),
      names
    )
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]).toMatchObject({ tool: 'web_task', args: { url: 'https://youtube.com' } })
    expect(plan.steps[1]?.bindings).toEqual([{ arg: 'to', fromStep: 0, field: 'phone' }])
  })

  it('drops steps whose tool is unknown, and malformed plans become empty', () => {
    expect(parsePlan(JSON.stringify({ steps: [{ tool: 'teleport', args: {} }] }), names).steps).toEqual(
      []
    )
    expect(parsePlan('not json', names).steps).toEqual([])
    expect(parsePlan(JSON.stringify({ nope: 1 }), names).steps).toEqual([])
  })

  it('drops incomplete bindings (missing field/arg) but keeps the step', () => {
    const plan = parsePlan(
      JSON.stringify({
        steps: [{ tool: 'messages_send', args: { text: 'x' }, bindings: [{ arg: 'to', fromStep: 0 }] }]
      }),
      names
    )
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.bindings).toEqual([])
  })
})

describe('resolveContactHandle', () => {
  it('reads a phone from contacts_search JSON (array or {results})', () => {
    expect(resolveContactHandle(JSON.stringify([{ name: 'Sidd', phone: '+15551234' }]))).toBe(
      '+15551234'
    )
    expect(
      resolveContactHandle(JSON.stringify({ results: [{ name: 'Sidd', email: 'a@b.com' }] }), 'email')
    ).toBe('a@b.com')
  })

  it('falls back phone->email and handles arrays of values', () => {
    expect(resolveContactHandle(JSON.stringify([{ phones: ['+199'] }]), 'phone')).toBe('+199')
    expect(resolveContactHandle(JSON.stringify([{ name: 'x' }]))).toBeNull()
    expect(resolveContactHandle('garbage')).toBeNull()
  })
})
