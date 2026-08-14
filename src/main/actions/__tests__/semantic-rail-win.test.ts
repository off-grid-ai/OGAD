/**
 * The Windows semantic rail through injected boundaries: the PowerShell
 * runner, the opener, and the Graph fallback port. Guards the local-first
 * contract (Outlook COM first; Graph only when Outlook is genuinely absent
 * AND the port says it is signed in), the honest refusals, and - with the
 * mac rail beside it - the DeviceController swap with zero caller changes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ActionRecord } from '@offgrid/use'
import {
  buildOutlookListScript,
  buildOutlookScript,
  isOutlookUnavailable,
  makeOutlookNativeReader,
  makeWindowsSemanticRailExecutor,
  makeWinInlineRunner,
  psQuote,
  type GraphPort
} from '../semantic-rail-win'
import { makeReadBackVerifiers } from '../verification'
import { makeSemanticRailExecutor } from '../semantic-rail'

const action = (type: string, args: Record<string, unknown> = {}) =>
  ({ type, args }) as ActionRecord

const ok = { ok: true as const, result: {} }
const graphPort = (available = true): GraphPort & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    available: () => available,
    async createEvent() {
      calls.push('createEvent')
      return ok
    },
    async createTask() {
      calls.push('createTask')
      return ok
    },
    async sendMail() {
      calls.push('sendMail')
      return ok
    }
  }
}

describe('psQuote', () => {
  it('single-quotes and doubles embedded quotes', () => {
    expect(psQuote("Ali's deck")).toBe("'Ali''s deck'")
    expect(psQuote(undefined)).toBe("''")
  })
})

describe('buildOutlookScript', () => {
  it('calendar: appointment with explicit end and notes', () => {
    const script = buildOutlookScript('calendar', {
      title: "Q3 'final' sync",
      start: '2026-08-15T09:00:00',
      end: '2026-08-15T10:00:00',
      notes: 'bring the deck'
    })
    expect(script).toContain('CreateItem(1)')
    expect(script).toContain("$i.Subject = 'Q3 ''final'' sync'")
    expect(script).toContain("[datetime]'2026-08-15T09:00:00'")
    expect(script).toContain("$i.End = [datetime]'2026-08-15T10:00:00'")
    expect(script).toContain("$i.Body = 'bring the deck'")
    expect(script).toContain('ConvertTo-Json -Compress')
    expect(script).toContain('catch')
  })

  it('calendar: a missing end defaults to one hour (the helper convention)', () => {
    const script = buildOutlookScript('calendar', { title: 'x', start: '2026-08-15T09:00:00' })
    expect(script).toContain('$i.End = $i.Start.AddHours(1)')
  })

  it('reminder: a task with optional due', () => {
    const script = buildOutlookScript('reminder', { title: 'Send the deck', due: '2026-08-15T18:00:00' })
    expect(script).toContain('CreateItem(3)')
    expect(script).toContain("$i.DueDate = [datetime]'2026-08-15T18:00:00'")
    const noDue = buildOutlookScript('reminder', { title: 'Send the deck' })
    expect(noDue).not.toContain('DueDate')
  })

  it('email: a mail item that Sends (lands in the local outbox, syncs later)', () => {
    const script = buildOutlookScript('email', { to: 'ali@x.test', subject: 's', body: 'b' })
    expect(script).toContain('CreateItem(0)')
    expect(script).toContain("$i.To = 'ali@x.test'")
    expect(script).toContain('$i.Send()')
  })
})

describe('isOutlookUnavailable', () => {
  it('matches the COM-not-registered shapes and nothing else', () => {
    expect(isOutlookUnavailable('80040154 Class not registered')).toBe(true)
    expect(isOutlookUnavailable('Cannot create a COM object')).toBe(true)
    expect(isOutlookUnavailable("Retrieving the COM class factory for Outlook.Application failed")).toBe(true)
    expect(isOutlookUnavailable('The operation was cancelled by the user')).toBe(false)
  })
})

describe('makeWindowsSemanticRailExecutor', () => {
  it('open goes through the opener', async () => {
    const openUrl = vi.fn(async () => ok)
    const execute = makeWindowsSemanticRailExecutor({ runPs: vi.fn(), openUrl })
    expect(await execute(action('open', { url: 'https://x.test' }))).toEqual({ ok: true })
    expect(openUrl).toHaveBeenCalledWith('https://x.test')
  })

  it('message is refused honestly - macOS-only in this release', async () => {
    const execute = makeWindowsSemanticRailExecutor({ runPs: vi.fn(), openUrl: vi.fn() })
    const result = await execute(action('message', { to: 'x', text: 'hi' }))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/macOS-only/)
  })

  it.each([['lookup'], ['file_share'], ['web_task']])('%s has no Windows mapping', async (type) => {
    const runPs = vi.fn()
    const execute = makeWindowsSemanticRailExecutor({ runPs, openUrl: vi.fn() })
    const result = await execute(action(type))
    expect(result.ok).toBe(false)
    expect(runPs).not.toHaveBeenCalled()
  })

  it('a local Outlook success is the happy path - Graph is never consulted', async () => {
    const graph = graphPort()
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => ok),
      openUrl: vi.fn(),
      graph
    })
    expect(await execute(action('calendar', { title: 'x', start: 's' }))).toEqual({ ok: true })
    expect(graph.calls).toEqual([])
  })

  it('an ordinary Outlook error passes through without touching Graph', async () => {
    const graph = graphPort()
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => ({ ok: false as const, error: 'The item could not be saved' })),
      openUrl: vi.fn(),
      graph
    })
    const result = await execute(action('reminder', { title: 'x' }))
    expect(result).toEqual({ ok: false, detail: 'The item could not be saved' })
    expect(graph.calls).toEqual([])
  })

  it('Outlook absent + no Graph port: the honest failure names both', async () => {
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => ({ ok: false as const, error: '80040154 Class not registered' })),
      openUrl: vi.fn()
    })
    const result = await execute(action('email', { to: 'a@b.c' }))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/local Outlook is not available/)
  })

  it('Outlook absent + Graph signed out: Graph is not called', async () => {
    const graph = graphPort(false)
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => ({ ok: false as const, error: '80040154' })),
      openUrl: vi.fn(),
      graph
    })
    const result = await execute(action('email', { to: 'a@b.c' }))
    expect(result.ok).toBe(false)
    expect(graph.calls).toEqual([])
  })

  it.each([
    ['calendar', 'createEvent'],
    ['reminder', 'createTask'],
    ['email', 'sendMail']
  ])('Outlook absent + Graph available: %s falls back to %s', async (type, method) => {
    const graph = graphPort()
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => ({ ok: false as const, error: '80040154' })),
      openUrl: vi.fn(),
      graph
    })
    expect(await execute(action(type, { title: 'x', start: 's', to: 't' }))).toEqual({ ok: true })
    expect(graph.calls).toEqual([method])
  })

  it('a Graph failure is labeled as the online path failing', async () => {
    const graph = graphPort()
    graph.sendMail = async () => ({ ok: false as const, error: '401 unauthorized' })
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => ({ ok: false as const, error: '80040154' })),
      openUrl: vi.fn(),
      graph
    })
    const result = await execute(action('email', { to: 'a@b.c' }))
    expect(result.detail).toMatch(/Microsoft Graph \(online\) failed: 401/)
  })

  it('a throwing boundary is caught - the executor never throws', async () => {
    const execute = makeWindowsSemanticRailExecutor({
      runPs: vi.fn(async () => {
        throw new Error('powershell missing')
      }),
      openUrl: vi.fn()
    })
    const result = await execute(action('calendar', { title: 'x', start: 's' }))
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/powershell missing/)
  })
})

describe('the DeviceController swap (DSP)', () => {
  it('one dispatch drives either platform rail with zero caller changes', async () => {
    const macExecute = makeSemanticRailExecutor(async () => ({ ok: true, result: {} }))
    const winExecute = makeWindowsSemanticRailExecutor({
      runPs: async () => ok,
      openUrl: async () => ok
    })
    // Written once; never mentions a platform. Swapping the rail is a
    // constructor argument, not a code change - the seam under test.
    const dispatch = async (
      execute: (a: ActionRecord) => Promise<{ ok: boolean; detail?: string }>,
      a: ActionRecord
    ) => execute(a)

    const reminder = action('reminder', { title: 'Send the deck' })
    expect((await dispatch(macExecute, reminder)).ok).toBe(true)
    expect((await dispatch(winExecute, reminder)).ok).toBe(true)
  })
})

describe('makeWinInlineRunner (R2-A2)', () => {
  it('opens links through the injected opener', async () => {
    const opened: string[] = []
    const run = makeWinInlineRunner(async (url) => {
      opened.push(url)
    })
    expect(await run({ command: 'system.openURL', args: { url: 'https://x.test' } })).toEqual({
      ok: true,
      result: {}
    })
    expect(opened).toEqual(['https://x.test'])
  })

  it('a missing url defaults to the empty string for the opener', async () => {
    const opened: string[] = []
    const run = makeWinInlineRunner(async (url) => {
      opened.push(url)
    })
    await run({ command: 'system.openURL', args: {} })
    expect(opened).toEqual([''])
  })

  it('a failing opener degrades to a reported error', async () => {
    const run = makeWinInlineRunner(async () => {
      throw new Error('no default browser')
    })
    const res = await run({ command: 'system.openURL', args: { url: 'x' } })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/no default browser/)
    }
  })

  it('every other verb refuses honestly - nothing impersonates the Swift helper', async () => {
    const run = makeWinInlineRunner(async () => {})
    const res = await run({ command: 'reminders.list', args: {} })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/not available on Windows/)
    }
  })
})

describe('Outlook read-back (R2-A3)', () => {
  it('the tasks script lists the tasks folder and speaks the mac shape', () => {
    const script = buildOutlookListScript('tasks')
    expect(script).toContain('GetDefaultFolder(13)')
    expect(script).toContain('-not $i.Complete')
    expect(script).toContain('reminders = @($out)')
    expect(script).toContain('ConvertTo-Json -Compress')
    expect(script).toContain('catch')
  })

  it('the events script restricts the calendar folder to the window', () => {
    const script = buildOutlookListScript('events', {
      start: '2026-08-15T09:29:00.000Z',
      end: '2026-08-15T10:31:00.000Z'
    })
    expect(script).toContain('GetDefaultFolder(9)')
    expect(script).toContain("[datetime]'2026-08-15T09:29:00.000Z'")
    expect(script).toContain('IncludeRecurrences')
    expect(script).toContain('$items.Restrict($filter)')
    expect(script).toContain('events = @($out)')
  })

  it('the reader maps the mac command names and refuses the rest', async () => {
    const scripts: string[] = []
    const reader = makeOutlookNativeReader(async (script) => {
      scripts.push(script)
      return { ok: true, result: { reminders: [{ title: 'Send the deck' }] } }
    })
    const list = await reader({ command: 'reminders.list', args: {} })
    expect(list.ok).toBe(true)
    await reader({ command: 'calendar.listEvents', args: { start: 's', end: 'e' } })
    expect(scripts[0]).toContain('GetDefaultFolder(13)')
    expect(scripts[1]).toContain('GetDefaultFolder(9)')

    const refused = await reader({ command: 'messages.send', args: {} })
    expect(refused.ok).toBe(false)
  })

  it('the shared read-back verifiers work unchanged over the Outlook reader', async () => {
    const reader = makeOutlookNativeReader(async (script) =>
      script.includes('GetDefaultFolder(13)')
        ? { ok: true, result: { reminders: [{ title: 'Send the deck' }] } }
        : { ok: true, result: { events: [] } }
    )
    const verifiers = makeReadBackVerifiers(reader)
    expect(
      await verifiers.reminder({ type: 'reminder', args: { title: 'Send the deck' } } as never)
    ).toBe(true)
    expect(
      await verifiers.calendar({
        type: 'calendar',
        args: { title: 'Standup', start: '2026-08-15T09:30:00.000Z' }
      } as never)
    ).toBe(false)
  })
})
