/**
 * The browser rail's engine adapter: web_task registers on the browser rail as
 * a no-retry mutation, and the executor maps a run's result to an
 * ExecuteResult - success carries the final URL as the effect handle, failure
 * carries the honest summary. The host (the live pane) is the injected
 * boundary; the run result is scripted.
 */
import { describe, expect, it, vi } from 'vitest'
import { HandlerRegistry, type ActionRecord } from '@offgrid/use'
import { makeBrowserRailExecutor, registerBrowserRail, type BrowserRailHost } from '../browser-rail'
import type { WebTaskResult } from '../web-task-agent'

const action = (args: Record<string, unknown>): ActionRecord =>
  ({
    id: 'act_web',
    type: 'web_task',
    intent: 'check in for my flight',
    args,
    risk: 'mutate',
    rail: 'browser'
  }) as unknown as ActionRecord

const run = (over: Partial<WebTaskResult> = {}): WebTaskResult => ({
  ok: true,
  summary: 'done',
  steps: [],
  takeovers: 0,
  finalUrl: 'https://air.test/boarding-pass',
  ...over
})

describe('registerBrowserRail', () => {
  it('registers web_task on the browser rail, gating and never retrying', () => {
    const registry = new HandlerRegistry()
    registerBrowserRail(registry)
    const handler = registry.get('web_task')
    expect(handler?.rail).toBe('browser')
    expect(registry.route('web_task')).toBe('browser')
    // none_fuzzy => no verify (registration would refuse a mismatch) and no
    // auto-retry: a web task fires exactly once behind the gate.
    expect(handler?.verification).toBe('none_fuzzy')
    expect(handler?.verify).toBeUndefined()
    expect(handler?.defaultRisk).toBe('mutate')
  })
})

describe('makeBrowserRailExecutor', () => {
  it('runs the task with the goal and start url, returning the final url as the effect', async () => {
    const host: BrowserRailHost = { runTask: vi.fn(async () => run()) }
    const result = await makeBrowserRailExecutor(host)(
      action({ goal: 'check in', url: 'https://air.test' })
    )
    expect(host.runTask).toHaveBeenCalledWith('check in', 'https://air.test', 'act_web')
    expect(result).toEqual({ ok: true, effectId: 'https://air.test/boarding-pass' })
  })

  it('falls back to the action intent when no explicit goal is given', async () => {
    const host: BrowserRailHost = { runTask: vi.fn(async () => run()) }
    await makeBrowserRailExecutor(host)(action({}))
    expect(host.runTask).toHaveBeenCalledWith('check in for my flight', undefined, 'act_web')
  })

  it('ignores a non-http start url rather than navigating somewhere unsafe', async () => {
    const host: BrowserRailHost = { runTask: vi.fn(async () => run()) }
    await makeBrowserRailExecutor(host)(action({ goal: 'x', url: 'file:///etc/passwd' }))
    expect(host.runTask).toHaveBeenCalledWith('x', undefined, 'act_web')
  })

  it('surfaces a failed run as the honest failure with its summary', async () => {
    const host: BrowserRailHost = {
      runTask: vi.fn(async () =>
        run({ ok: false, summary: 'the site needs a phone app', finalUrl: '' })
      )
    }
    const result = await makeBrowserRailExecutor(host)(action({ goal: 'x' }))
    expect(result).toEqual({ ok: false, detail: 'the site needs a phone app' })
  })

  it('uses the action id as the effect handle when a run reports no url', async () => {
    const host: BrowserRailHost = { runTask: vi.fn(async () => run({ finalUrl: '' })) }
    const result = await makeBrowserRailExecutor(host)(action({ goal: 'x' }))
    expect(result).toEqual({ ok: true, effectId: 'act_web' })
  })
})
