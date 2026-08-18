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
      calls.push(`type:${target.index}:${text}`)
      if (target.identity) {
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

  it('halts a runaway: refuses to repeat the same action', async () => {
    const w = world([
      '{"action":"click","index":1}',
      '{"action":"click","index":1}', // identical -> halt
      '{"action":"done","summary":"unreachable"}'
    ])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/repeated the same action/i)
    expect(w.calls.filter((c) => c.startsWith('click'))).toHaveLength(1)
  })

  it('halts a re-typed search text (the A-B-A-B submit loop)', async () => {
    const w = world([
      '{"action":"type","index":2,"text":"Family Guy"}',
      '{"action":"press_key","key":"Enter"}',
      '{"action":"type","index":2,"text":"Family Guy"}', // same text again -> halt
      '{"action":"done","summary":"unreachable"}'
    ])
    const result = await runWebTask('t', undefined, w.deps)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/re-typed the same text/i)
  })

  it('a failed start navigation ends the task immediately', async () => {
    const w = world([])
    w.deps.driver.navigate = async () => ({ ok: false, reason: 'error', detail: 'dns' })
    const result = await runWebTask('t', 'https://nope.invalid', w.deps)
    expect(result.ok).toBe(false)
    expect(result.summary).toMatch(/could not open/)
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
    expect(prompt).toContain('Never enter credentials')
    expect(prompt).toContain('Task: order the usual')
    expect(prompt).toContain('clicked [1] el1')
  })
})
