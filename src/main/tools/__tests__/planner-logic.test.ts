/**
 * The planner's pure core: it plans only when the request is action-y, routes by
 * the tool catalog, fills args, parses fail-closed, and resolves a contact
 * handle for the recipient binding.
 */
import { describe, expect, it } from 'vitest'
import {
  shouldPlan,
  buildPlannerPrompt,
  buildPlannerRetryPrompt,
  parsePlan,
  backfillGoals,
  namesWebsite,
  parsePlanResult,
  resolveContactHandle,
  type ToolCatalogEntry
} from '../planner-logic'

const catalog: ToolCatalogEntry[] = [
  { name: 'web_use', description: 'Do something on a website; always set url.' },
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
    expect(shouldPlan('anything?')).toBe(false)
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
    expect(p).toContain('- web_use:')
    expect(p).toContain('play X on YouTube')
    // Post-pivot rule: any website task (incl play/watch) -> web_use, which runs
    // in Off Grid AI's built-in browser; open_url only opens a link.
    expect(p).toMatch(/is web_use/i)
    expect(p).toMatch(/built-in browser/i)
    expect(p).toMatch(/NOT open_url/i)
    expect(p).toMatch(/Fill EVERY required argument/i)
    expect(p).toMatch(/\{"steps":\[\]\}/) // the conversational escape hatch
  })

  it('keeps the task context and adds exact validation feedback for one model repair', () => {
    const original = buildPlannerPrompt('play X on YouTube', [], catalog)
    const retry = buildPlannerRetryPrompt(original, 'the planner response was not JSON')
    expect(retry).toContain(original)
    expect(retry).toContain('the planner response was not JSON')
    expect(retry).toMatch(/JSON only/i)
  })
})

describe('parsePlan', () => {
  it('keeps well-formed steps and normalizes bindings', () => {
    const plan = parsePlan(
      JSON.stringify({
        steps: [
          {
            tool: 'web_use',
            args: { goal: 'play X', url: 'https://youtube.com' },
            why: 'interactive'
          },
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
    expect(plan.steps[0]).toMatchObject({ tool: 'web_use', args: { url: 'https://youtube.com' } })
    expect(plan.steps[1]?.bindings).toEqual([{ arg: 'to', fromStep: 0, field: 'phone' }])
  })

  it('rejects unknown tools and malformed plans without dispatchable partial steps', () => {
    expect(
      parsePlan(JSON.stringify({ steps: [{ tool: 'teleport', args: {} }] }), names).steps
    ).toEqual([])
    expect(parsePlan('not json', names).steps).toEqual([])
    expect(parsePlan(JSON.stringify({ nope: 1 }), names).steps).toEqual([])
  })

  it('reports malformed bindings as an invalid structured plan', () => {
    const result = parsePlanResult(
      JSON.stringify({
        steps: [
          { tool: 'messages_send', args: { text: 'x' }, bindings: [{ arg: 'to', fromStep: 0 }] }
        ]
      }),
      names
    )
    expect(result.valid).toBe(false)
    expect(result.plan.steps).toEqual([])
  })
})

describe('resolveContactHandle', () => {
  it('reads a phone from contacts_search JSON (array or {results})', () => {
    expect(resolveContactHandle(JSON.stringify([{ name: 'Sidd', phone: '+15551234' }]))).toBe(
      '+15551234'
    )
    expect(
      resolveContactHandle(
        JSON.stringify({ results: [{ name: 'Sidd', email: 'a@b.com' }] }),
        'email'
      )
    ).toBe('a@b.com')
  })

  it('falls back phone->email and handles arrays of values', () => {
    expect(resolveContactHandle(JSON.stringify([{ phones: ['+199'] }]), 'phone')).toBe('+199')
    expect(resolveContactHandle(JSON.stringify([{ name: 'x' }]))).toBeNull()
    expect(resolveContactHandle('garbage')).toBeNull()
  })
})

describe('backfillGoals', () => {
  it('fills an empty web_use/computer_task goal with the user request', () => {
    const plan = {
      steps: [{ tool: 'web_use', args: { url: 'https://youtube.com' }, why: '', bindings: [] }]
    }
    const out = backfillGoals(plan, 'play Family Guy on YouTube')
    expect(out.steps[0]?.args).toEqual({
      url: 'https://youtube.com',
      goal: 'play Family Guy on YouTube'
    })
  })

  it('keeps a goal the planner already provided, and ignores non-goal tools', () => {
    const plan = {
      steps: [
        { tool: 'computer_task', args: { goal: 'open the DM with sidd' }, why: '', bindings: [] },
        { tool: 'messages_send', args: { text: 'hi' }, why: '', bindings: [] }
      ]
    }
    const out = backfillGoals(plan, 'do the thing')
    expect(out.steps[0]?.args.goal).toBe('open the DM with sidd')
    expect(out.steps[1]?.args).toEqual({ text: 'hi' })
  })
})

describe('namesWebsite', () => {
  it('detects clear website references', () => {
    expect(namesWebsite('play drake music on youtube')).toBe(true)
    expect(namesWebsite('go to https://example.com')).toBe(true)
    expect(namesWebsite('search google for cafes')).toBe(true)
    expect(namesWebsite('open amazon.com')).toBe(true)
  })

  it('is false for native-app requests (no app-ambiguous words like music/maps)', () => {
    expect(namesWebsite('play drake in Music')).toBe(false)
    expect(namesWebsite('message sidd on slack')).toBe(false)
    expect(namesWebsite('open Maps and find a cafe')).toBe(false)
  })
})
