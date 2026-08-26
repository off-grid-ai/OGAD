/**
 * The web-task loop's control flow, with every boundary scripted: when it
 * finishes, parks for takeover, retries a bad model reply, refuses to guess,
 * and stops. Plus the fail-closed decision parser and the injection-stance
 * regression guard on the prompt source itself.
 */
import { describe, expect, it } from 'vitest'
import type { PageElement, PageSnapshot } from '../page-script'
import {
  buildStepPrompt,
  parseStepDecision,
  runWebTask,
  type AgentDriver,
  type WebTaskDeps
} from '../web-task-agent'

const el = (index: number, over: Partial<PageElement> = {}): PageElement => ({
  index,
  tag: 'button',
  role: 'button',
  name: `el${index}`,
  value: '',
  cx: 10,
  cy: 10,
  identity: false,
  href: '',
  ...over
})

const snap = (elements: PageElement[], url = 'https://shop.test/cart'): PageSnapshot => ({
  url,
  title: 'Cart',
  elements,
  text: 'Your cart'
})

/** A scripted world: the driver records calls; decide pops replies in order. */
const world = (
  replies: string[],
  elements: PageElement[] = [el(1), el(2, { tag: 'input', role: 'textbox', name: 'Search' })]
): {
  deps: WebTaskDeps
  calls: string[]
  takeoverWaits: string[]
} => {
  const calls: string[] = []
  const takeoverWaits: string[] = []
  const driver: AgentDriver = {
    snapshot: async () => {
      calls.push('snapshot')
      return snap(elements)
    },
    navigate: async (url) => {
      calls.push(`navigate:${url}`)
      return { ok: true }
    },
    click: async (target) => {
      calls.push(`click:${target.index}`)
      return { ok: true }
    },
    type: async (target, text) => {
      calls.push(`type:${target?.index ?? 'focused'}:${text}`)
      if (target?.identity) {
        return { ok: false, reason: 'takeover', detail: 'credential field' }
      }
      return { ok: true }
    },
    pressKey: async (key) => {
      calls.push(`key:${key}`)
      return { ok: true }
    }
  }
  return {
    calls,
    takeoverWaits,
    deps: {
      driver,
      decide: async () => replies.shift() ?? '{"action":"give_up","why":"script exhausted"}',
      waitForTakeover: async (why) => {
        takeoverWaits.push(why)
      }
    }
  }
}

describe('runWebTask', () => {
  it('shares the stable plan and records phase changes around dynamic actions', async () => {
    const prompts: string[] = []
    const phases: string[] = []
    const w = world([
      '{"action":"click","index":1,"phase":1}',
      '{"action":"click","index":2,"phase":2}',
      '{"action":"done","summary":"ready","phase":3}'
    ])
    const plan = {
      version: 1 as const,
      phases: [
        { id: 'phase-1', title: 'Open booking.com' },
        { id: 'phase-2', title: 'Set the travel filters' },
        { id: 'phase-3', title: 'Review matching stays' }
      ]
    }
    const result = await runWebTask('find a hotel', undefined, {
      ...w.deps,
      plan,
      onPhase: (phase) => phases.push(phase),
      decide: async (prompt) => {
        prompts.push(prompt)
        return (
          [
            '{"action":"click","index":1,"phase":1}',
            '{"action":"click","index":2,"phase":2}',
            '{"action":"done","summary":"ready","phase":3}'
          ][prompts.length - 1] ?? '{"action":"give_up","why":"unexpected"}'
        )
      }
    })
    expect(result.ok).toBe(true)
    expect(prompts[0]).toContain('Execution plan:')
    expect(prompts[0]).toContain('2. Set the travel filters')
    expect(phases).toEqual(['phase-1', 'phase-2', 'phase-3'])
  })

  it('merges guidance received after start into every later task prompt', async () => {
    const prompts: string[] = []
    const guidance = 'From San Francisco to Pune on September 1, budget $500-$3000'
    let decision = 0
    const w = world([])
    const result = await runWebTask(
      'Open Skyscanner and ask me for route, dates, and budget',
      undefined,
      {
        ...w.deps,
        takeGuidance: () => {
          decision += 1
          return decision === 2 ? [guidance] : []
        },
        decide: async (prompt) => {
          prompts.push(prompt)
          if (prompts.length === 1) return '{"action":"click","index":1}'
          if (prompts.length === 2) return '{"action":"click","index":2}'
          return '{"action":"done","summary":"ready"}'
        }
      }
    )
    expect(result.ok).toBe(true)
    expect(prompts[0]).not.toContain(guidance)
    expect(prompts[1]).toContain('Original request: Open Skyscanner')
    expect(prompts[1]).toContain(guidance)
    expect(prompts[2]).toContain(guidance)
    expect(result.steps.filter((step) => step.includes('GUIDANCE'))).toEqual([])
  })

  it('drives navigate -> click -> done and reports the summary', async () => {
    const w = world([
      '{"action":"click","index":1}',
      '{"action":"done","summary":"checked in, boarding pass saved"}'
    ])
    const result = await runWebTask('check in', 'https://air.test', w.deps)
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('checked in, boarding pass saved')
    expect(w.calls).toEqual(['navigate:https://air.test', 'snapshot', 'click:1', 'snapshot'])
    expect(result.finalUrl).toBe('https://shop.test/cart')
  })

  it('a refused credential type parks for takeover and resumes', async () => {
    const w = world(
      [
        '{"action":"type","index":3,"text":"hunter2"}',
        '{"action":"done","summary":"signed-in flow finished by the user"}'
      ],
      [el(3, { identity: true, name: 'Password', tag: 'input' })]
    )
    const result = await runWebTask('log my hours', undefined, w.deps)
    expect(result.ok).toBe(true)
    expect(result.takeovers).toBe(1)
    expect(w.takeoverWaits).toEqual(['credential field'])
    expect(result.steps.join('\n')).toContain('takeover: credential field')
    expect(result.steps.join('\n')).toContain('resumed by the user')
  })

  it('the model can hand over voluntarily with takeover', async () => {
    const w = world([
      '{"action":"takeover","why":"the login page needs your account"}',
      '{"action":"done","summary":"done after sign-in"}'
    ])
    const result = await runWebTask('order lunch', undefined, w.deps)
    expect(result.takeovers).toBe(1)
    expect(w.takeoverWaits).toEqual(['the login page needs your account'])
  })

  it('stops when the user cancels a takeover instead of resuming the task', async () => {
    const w = world([
      '{"action":"takeover","why":"the checkout needs payment"}',
      '{"action":"done","summary":"must not run"}'
    ])
    w.deps.waitForTakeover = async () => 'cancelled'
    const result = await runWebTask('buy the item', undefined, w.deps)
    expect(result).toMatchObject({ ok: false, summary: 'cancelled by the user', takeovers: 1 })
    expect(result.steps).toContain('cancelled by the user')
    expect(w.calls).toEqual(['snapshot'])
  })

  it('an unparseable reply is noted and retried, never guessed', async () => {
    const w = world(['click the second button please', '{"action":"done","summary":"ok"}'])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result.ok).toBe(true)
    expect(result.steps.join('\n')).toContain('did not parse')
    // No driver action happened for the free-text reply.
    expect(w.calls.filter((c) => !c.startsWith('snapshot'))).toEqual([])
  })

  it('a reference to a missing element is reported back, not clicked blind', async () => {
    const w = world(['{"action":"click","index":99}', '{"action":"give_up","why":"lost"}'])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result.ok).toBe(false)
    expect(result.steps.join('\n')).toContain('no element [99]')
    expect(w.calls.filter((c) => c.startsWith('click'))).toEqual([])
  })

  it('give_up is an honest failure with the reason as the summary', async () => {
    const w = world(['{"action":"give_up","why":"the site requires a phone app"}'])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result).toMatchObject({ ok: false, summary: 'the site requires a phone app' })
  })

  it('stops at the step budget instead of looping forever', async () => {
    // Cycle distinct keys so the runaway guard (which halts a REPEATED action)
    // does not fire before the budget is reached.
    const keys = ['Tab', 'Escape', 'Enter']
    const replies = Array.from(
      { length: 20 },
      (_, i) => `{"action":"press_key","key":"${keys[i % keys.length]}"}`
    )
    const w = world(replies)
    const result = await runWebTask('t', undefined, { ...w.deps, maxSteps: 3 })
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/stopped after 3 steps/)
    expect(w.calls.filter((c) => c.startsWith('key'))).toHaveLength(3)
  })

  it('skips a repeated action (fires once) instead of killing the task', async () => {
    const w = world([
      '{"action":"click","index":1}',
      '{"action":"click","index":1}', // identical -> skipped, not re-fired
      '{"action":"done","summary":"done"}'
    ])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result.ok).toBe(true) // the repeat did NOT kill the task
    expect(w.calls.filter((c) => c.startsWith('click'))).toHaveLength(1) // clicked once
  })

  it('skips a re-typed search text (no re-submit) but keeps going', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"Family Guy"}',
      '{"action":"press_key","key":"Enter"}',
      '{"action":"type","index":2,"text":"Family Guy"}', // same text again -> skipped
      '{"action":"done","summary":"done"}'
    ])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result.ok).toBe(true)
    expect(w.calls.filter((c) => c.startsWith('type'))).toHaveLength(1) // typed once
  })

  it('a failed start navigation ends the task immediately', async () => {
    const w = world([])
    w.deps.driver.navigate = async () => ({ ok: false, reason: 'error', detail: 'dns' })
    const result = await runWebTask('t', 'https://nope.invalid', w.deps)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/could not open/)
  })
})

describe('retry checkpoints', () => {
  it('takes a fresh snapshot and uses history without replaying the failed action', async () => {
    const w = world([])
    let prompt = ''
    const result = await runWebTask('open the report', undefined, {
      ...w.deps,
      checkpointHistory: ['click failed on report link'],
      decide: async (value) => {
        prompt = value
        return '{"action":"done","summary":"the report is already open"}'
      }
    })

    expect(result.ok).toBe(true)
    expect(w.calls).toEqual(['snapshot'])
    expect(prompt).toContain('click failed on report link')
    expect(w.calls.some((call) => call.startsWith('click:'))).toBe(false)
  })
})

describe('parseStepDecision', () => {
  it('accepts each well-formed action', () => {
    expect(parseStepDecision('{"action":"navigate","url":"https://x.test"}')).toEqual({
      action: 'navigate',
      url: 'https://x.test'
    })
    expect(parseStepDecision('{"action":"click","index":4}')).toEqual({ action: 'click', index: 4 })
    expect(parseStepDecision('{"action":"type","index":2,"text":""}')).toEqual({
      action: 'type',
      index: 2,
      text: ''
    })
    expect(parseStepDecision('{"action":"press_key","key":"Enter"}')).toEqual({
      action: 'press_key',
      key: 'Enter'
    })
  })

  it('accepts type with NO index (focused field) and an optional submit key', () => {
    // The real "did not parse" loop: the model typed into the focused search box
    // and pressed Enter, which the old parser rejected for lacking an index.
    expect(parseStepDecision('{"action":"type","text":"family guy","key":"Enter"}')).toEqual({
      action: 'type',
      text: 'family guy',
      key: 'Enter'
    })
    // With an index it still targets that element, and drops an invalid key.
    expect(parseStepDecision('{"action":"type","index":3,"text":"hi","key":"Nope"}')).toEqual({
      action: 'type',
      index: 3,
      text: 'hi'
    })
  })

  it('strips a reasoning <think> block / prose before the JSON (the "did not parse" loop)', () => {
    // A reasoning model emits its thinking before the JSON - a raw JSON.parse
    // rejected it and every reply read as "did not parse".
    expect(
      parseStepDecision(
        '<think>I should click the search result now.</think>\n{"action":"click","index":7}'
      )
    ).toEqual({ action: 'click', index: 7 })
    expect(
      parseStepDecision('Okay, here is my step: {"action":"press_key","key":"Enter"}')
    ).toEqual({
      action: 'press_key',
      key: 'Enter'
    })
  })

  it('fails closed on junk: bad JSON, unknown actions, missing fields, non-http urls', () => {
    for (const raw of [
      'not json',
      '{"action":"detonate"}',
      '{"action":"click"}',
      '{"action":"type","index":1}',
      '{"action":"navigate","url":"file:///etc/passwd"}',
      '{"action":"navigate","url":"javascript:alert(1)"}',
      '42'
    ]) {
      expect(parseStepDecision(raw)).toBeNull()
    }
  })
})

describe('the prompt (injection-stance regression guard)', () => {
  it('declares page text untrusted and routes credentials to takeover', () => {
    const prompt = buildStepPrompt('order the usual', snap([el(1)]), ['clicked [1] el1'])
    expect(prompt).toContain('untrusted DATA')
    expect(prompt).toContain('activate the visible Search, Apply, Submit, or Update control')
    expect(prompt).toContain('Treat results as stale')
    expect(prompt).toContain('Never enter credentials')
    expect(prompt).toContain('Task: order the usual')
    expect(prompt).toContain('clicked [1] el1')
  })
})

describe('shouldStop (overlay Stop / Esc halts the loop between actions)', () => {
  it('stops before the first navigate and never touches the page or the model', async () => {
    const w = world(['{"action":"click","index":1}'])
    const result = await runWebTask('check in', 'https://air.test', {
      ...w.deps,
      shouldStop: () => true
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('stopped')
    expect(w.calls).toEqual([]) // no navigate, no snapshot - halted before acting
  })

  it('stops at the top of the loop after navigating, before the first step', async () => {
    const w = world(['{"action":"click","index":1}'])
    let checks = 0
    // Pass the pre-navigate check, halt at the first loop iteration.
    const result = await runWebTask('check in', 'https://air.test', {
      ...w.deps,
      shouldStop: () => checks++ > 0
    })
    expect(result.summary).toBe('stopped')
    expect(w.calls).toEqual(['navigate:https://air.test']) // navigated, then halted before snapshot
  })
})
