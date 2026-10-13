import { describe, expect, it } from 'vitest'
import {
  DEBUGGER_BLOCKED,
  DEBUGGER_DROPPED_RESULT,
  DebuggerFallbackSession,
  isDebuggerBlocked,
  MAX_DEBUGGER_REFUSALS,
  type DebuggerConnection,
  type PageControl
} from '../debugger-fallback-session'
import type { PlaywrightToolResult, SemanticPageSession } from '../playwright-mcp-session'
import { isStaleReference } from '../browser-playwright-task-support'

// Chrome drops an extension's debugger while another extension's frame is in the tab, and lets
// it attach again once the frame goes (reproduced in Chromium with a frame-injecting extension).
// The debugger connection is the boundary faked here; `blocked` plays that frame.

const DEBUGGER_SNAPSHOT = '- button "Create Account" [ref=e7]'
const PAGE_SNAPSHOT = '- button "Create Account" [disabled] [ref=e2]'

function fakeSession(
  name: string,
  log: string[],
  answer: () => PlaywrightToolResult
): SemanticPageSession {
  return {
    snapshot: async () => (log.push(`${name}:snapshot`), answer()),
    recoverPage: async (url) => (log.push(`${name}:recover ${url}`), answer()),
    call: async (tool) => (log.push(`${name}:${tool}`), answer())
  }
}

function harness(): {
  session: DebuggerFallbackSession
  log: string[]
  switches: PageControl[]
  frame: { blocked: boolean; failCalls: boolean }
} {
  const log: string[] = []
  const switches: PageControl[] = []
  const frame = { blocked: false, failCalls: false }
  const refuse = (): never => {
    throw new Error(DEBUGGER_BLOCKED)
  }
  const debuggerSession = fakeSession('debugger', log, () =>
    frame.failCalls ? refuse() : { text: DEBUGGER_SNAPSHOT, isError: false }
  )
  const connect = async (): Promise<DebuggerConnection> => {
    log.push('connect')
    if (frame.blocked) refuse()
    return { session: debuggerSession, close: async () => void log.push('close') }
  }
  const page = fakeSession('page', log, () => ({ text: PAGE_SNAPSHOT, isError: false }))
  const session = new DebuggerFallbackSession({
    connect,
    page,
    onSwitch: (to) => switches.push(to)
  })
  return { session, log, switches, frame }
}

describe('DebuggerFallbackSession', () => {
  it('drives the tab over the debugger while Chrome allows it, and says nothing', async () => {
    const { session, log, switches } = harness()
    expect((await session.snapshot()).text).toBe(DEBUGGER_SNAPSHOT)
    expect(session.usesDebugger()).toBe(true)
    await session.call('browser_click', { target: 'e7' })
    await session.close()
    expect(log).toEqual(['connect', 'debugger:snapshot', 'debugger:browser_click', 'close'])
    expect(switches).toEqual([])
  })

  it('falls back to the page while another extension blocks it, and returns once it can', async () => {
    const { session, log, switches, frame } = harness()
    frame.blocked = true
    expect((await session.snapshot()).text).toBe(PAGE_SNAPSHOT)
    expect(session.usesDebugger()).toBe(false)
    // The ref came from the page's snapshot, so the action goes to the page.
    await session.call('browser_click', { target: 'e2' })
    frame.blocked = false
    expect((await session.snapshot()).text).toBe(DEBUGGER_SNAPSHOT)
    expect(session.usesDebugger()).toBe(true)
    expect(switches).toEqual(['page', 'debugger'])
    expect(log).toEqual([
      'connect',
      'page:snapshot',
      'page:browser_click',
      'connect',
      'debugger:snapshot'
    ])
  })

  it('never replays an action the debugger lost: the loop re-observes instead', async () => {
    const { session, log, frame } = harness()
    await session.snapshot()
    frame.failCalls = true
    const result = await session.call('browser_type', { target: 'e7', text: 'x' })
    expect(result).toEqual(DEBUGGER_DROPPED_RESULT)
    // The loop's stale-reference path is what re-observes; this result must take it.
    expect(isStaleReference(result)).toBe(true)
    expect(log).toEqual(['connect', 'debugger:snapshot', 'debugger:browser_type', 'close'])
    expect(session.usesDebugger()).toBe(false)
    frame.failCalls = false
    frame.blocked = true
    await session.snapshot()
    expect(log.slice(-2)).toEqual(['connect', 'page:snapshot'])
  })

  it('treats a blocked answer the same as a blocked throw', async () => {
    const log: string[] = []
    const switches: PageControl[] = []
    const session = new DebuggerFallbackSession({
      connect: async () => ({
        session: fakeSession('debugger', log, () => ({ text: DEBUGGER_BLOCKED, isError: true })),
        close: async () => void log.push('close')
      }),
      page: fakeSession('page', log, () => ({ text: PAGE_SNAPSHOT, isError: false })),
      onSwitch: (to) => switches.push(to)
    })
    expect((await session.recoverPage('https://shop.test/')).text).toBe(PAGE_SNAPSHOT)
    expect(log).toEqual([
      'debugger:recover https://shop.test/',
      'close',
      'page:recover https://shop.test/'
    ])
    expect(switches).toEqual(['page'])
  })

  it('stays on page controls once Chrome has refused the debugger enough times', async () => {
    // Each retry flashes Chrome's debugging bar on and off; a page that keeps blocking it
    // is left to the in-page controls for the rest of the task.
    const { session, log, frame } = harness()
    frame.blocked = true
    for (let i = 0; i < MAX_DEBUGGER_REFUSALS + 2; i += 1) await session.snapshot()
    expect(log.filter((l) => l === 'connect')).toHaveLength(MAX_DEBUGGER_REFUSALS)
    frame.blocked = false
    await session.snapshot()
    expect(log.at(-1)).toBe('page:snapshot')
  })

  it('lets any other debugger failure through', async () => {
    const session = new DebuggerFallbackSession({
      connect: async () => {
        throw new Error('The user cancelled debugging.')
      },
      page: fakeSession('page', [], () => ({ text: PAGE_SNAPSHOT, isError: false })),
      onSwitch: () => undefined
    })
    await expect(session.snapshot()).rejects.toThrow('The user cancelled debugging.')
  })

  it('recognises Chrome’s refusal however it arrives', () => {
    expect(isDebuggerBlocked(new Error(DEBUGGER_BLOCKED))).toBe(true)
    expect(isDebuggerBlocked(`Error: ${DEBUGGER_BLOCKED}`)).toBe(true)
    expect(isDebuggerBlocked(new Error('Target closed'))).toBe(false)
    expect(isDebuggerBlocked({ message: DEBUGGER_BLOCKED })).toBe(false)
  })
})
