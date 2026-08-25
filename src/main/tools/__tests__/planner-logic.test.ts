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
  backfillGoals,
  preferNativeApp,
  namesWebsite,
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
    expect(p).toContain('- web_task:')
    expect(p).toContain('play X on YouTube')
    // Post-pivot rule: any website task (incl play/watch) -> web_task, which runs
    // in Off Grid's built-in browser; open_url only opens a link.
    expect(p).toMatch(/is web_task/i)
    expect(p).toMatch(/built-in browser/i)
    expect(p).toMatch(/NOT open_url/i)
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

describe('backfillGoals', () => {
  it('fills an empty web_task/computer_task goal with the user request', () => {
    const plan = { steps: [{ tool: 'web_task', args: { url: 'https://youtube.com' }, why: '', bindings: [] }] }
    const out = backfillGoals(plan, 'play Family Guy on YouTube')
    expect(out.steps[0]?.args).toEqual({ url: 'https://youtube.com', goal: 'play Family Guy on YouTube' })
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

describe('preferNativeApp (rail-per-surface: named running app -> computer_task)', () => {
  const step = (tool, args = {}) => ({ tool, args, why: '', bindings: [] })

  it('redirects a web_task to computer_task when the request names a running app', () => {
    const plan = { steps: [step('web_task', { goal: 'send a file', url: 'https://slack.com' })] }
    const out = preferNativeApp(plan, 'send the file to dishit on slack', 'Slack')
    expect(out.steps).toEqual([
      { tool: 'computer_task', args: { goal: 'send the file to dishit on slack' }, why: expect.stringContaining('Slack'), bindings: [] }
    ])
  })

  it('collapses an open_url -> web_task run into a single computer_task', () => {
    const plan = { steps: [step('open_url', { url: 'https://slack.com' }), step('web_task', { goal: 'x' })] }
    const out = preferNativeApp(plan, 'open slack and send a file', 'Slack')
    expect(out.steps).toHaveLength(1)
    expect(out.steps[0]?.tool).toBe('computer_task')
    expect(out.steps[0]?.args.goal).toBe('open slack and send a file')
  })

  it('keeps a preceding contacts_search and redirects only the web step', () => {
    const plan = { steps: [step('contacts_search', { query: 'dishit' }), step('web_task', { goal: 'x' })] }
    const out = preferNativeApp(plan, 'message dishit on slack', 'Slack')
    expect(out.steps.map((s) => s.tool)).toEqual(['contacts_search', 'computer_task'])
  })

  it('leaves the plan untouched when no running app was named (nativeApp null)', () => {
    // "play family guy on youtube" names no native app - the browser chain stays.
    const plan = { steps: [step('open_url', { url: 'https://youtube.com/results?search_query=x' }), step('computer_task', { goal: 'click first video' })] }
    expect(preferNativeApp(plan, 'play family guy on youtube', null)).toEqual(plan)
  })

  it('leaves an already-native computer_task plan unchanged', () => {
    const plan = { steps: [step('computer_task', { goal: 'send a file on slack' })] }
    expect(preferNativeApp(plan, 'send a file on slack', 'Slack')).toEqual(plan)
  })

  it('keeps a web_task when the request names a website, even if a word matches a running app', () => {
    // "play drake music on youtube" - "music" matches the running Music app, but
    // youtube means the browser, so it must stay a web_task (the false-match bug).
    const plan = { steps: [step('web_task', { goal: 'play drake music on youtube' })] }
    expect(preferNativeApp(plan, 'play drake music on youtube', 'Music')).toEqual(plan)
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
