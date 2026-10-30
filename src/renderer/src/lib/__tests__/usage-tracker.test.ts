// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installUsageTracking,
  openUsageOverlay,
  overlayScreenName,
  reportChatInput,
  resetUsageTrackingForTests,
  setUsageScreen,
  usageScreenName
} from '../usage-tracker'

/**
 * The renderer's usage observer reaches main only through the preload bridge, the one stand-in
 * here. Main validates every id against the allow-list from source; this side must send fixed ids
 * and never the text a control shows.
 */

let sent: unknown[][]
let now = 0
let inUse = true
let uninstall: (() => void) | undefined

beforeEach(() => {
  sent = []
  now = 0
  inUse = true
  ;(window as unknown as { api: unknown }).api = {
    analytics: { capture: (...args: unknown[]) => sent.push(args) }
  }
  resetUsageTrackingForTests(
    () => now,
    () => inUse
  )
  document.body.innerHTML = ''
})

afterEach(() => {
  uninstall?.()
  uninstall = undefined
  resetUsageTrackingForTests()
  delete (window as unknown as { api?: unknown }).api
  vi.useRealTimers()
})

const events = (name: string): unknown[] =>
  sent.filter(([event]) => event === name).map(([, p]) => p)

describe('screens', () => {
  it('names sub-screens by fixed ids', () => {
    expect(usageScreenName('settings', null, 'analytics')).toBe('settings:analytics')
    expect(usageScreenName('models', 'image', null)).toBe('models:image')
    expect(usageScreenName('models', null, null)).toBe('models:text')
    expect(usageScreenName('video', 'watch/abc123', null)).toBe('video:watch')
    expect(usageScreenName('video', 'secret-page/x', null)).toBe('video')
    expect(usageScreenName('chats', 'anything', null)).toBe('chats')
  })

  it('reports dialogs as screens and returns to the screen under them', () => {
    setUsageScreen('chats')
    now = 1_000
    const close = openUsageOverlay(overlayScreenName('panel', 'Active models'))
    now = 1_500
    close()
    expect(events('screen_viewed')).toEqual([
      { screen: 'chats', prev_screen: null, prev_ms: 0 },
      { screen: 'panel:active-models', prev_screen: 'chats', prev_ms: 1_000 },
      { screen: 'chats', prev_screen: 'panel:active-models', prev_ms: 500 }
    ])
  })

  it('does not count time while the window is hidden or blurred', () => {
    uninstall = installUsageTracking(window)
    setUsageScreen('chats')
    now = 2_000
    inUse = false
    window.dispatchEvent(new Event('blur'))
    now = 60_000
    inUse = true
    window.dispatchEvent(new Event('focus'))
    now = 61_000
    setUsageScreen('projects')
    expect(events('screen_viewed').at(-1)).toEqual({
      screen: 'projects',
      prev_screen: 'chats',
      prev_ms: 3_000
    })
  })
})

describe('presses', () => {
  it('sends the fixed id of the pressed control, never its visible text', () => {
    uninstall = installUsageTracking(window)
    setUsageScreen('chats')
    document.body.innerHTML = `
      <button data-action="new-chat"><span id="inner">New chat for Sam</span></button>
      <button aria-label="Send message">Send</button>
      <button>Pay Alice 200</button>
      <div role="menuitem" data-testid="rename-chat">Rename “Q3 plan”</div>
    `
    for (const target of [
      document.getElementById('inner')!,
      document.querySelector('[aria-label]')!,
      document.querySelector('button:not([aria-label]):not([data-action])')!,
      document.querySelector('[role="menuitem"]')!
    ])
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(events('ui_action')).toEqual([
      { screen: 'chats', action: 'new-chat' },
      { screen: 'chats', action: 'send-message' },
      { screen: 'chats', action: 'rename-chat' }
    ])
    expect(JSON.stringify(sent)).not.toMatch(/Sam|Alice|Q3/)
  })
})

describe('scroll depth', () => {
  it('reports the deepest point of a screen that scrolls when it is left', () => {
    uninstall = installUsageTracking(window)
    document.body.innerHTML = '<div data-route-scroll id="page"></div>'
    const page = document.getElementById('page')!
    Object.defineProperty(page, 'scrollHeight', { value: 2_000 })
    Object.defineProperty(page, 'clientHeight', { value: 1_000 })
    setUsageScreen('settings')
    for (const top of [200, 800, 300]) {
      page.scrollTop = top
      page.dispatchEvent(new Event('scroll'))
    }
    setUsageScreen('chats')
    expect(events('scroll_depth')).toEqual([{ screen: 'settings', pct: 75 }])
  })

  it('sends nothing for a screen that does not scroll', () => {
    uninstall = installUsageTracking(window)
    setUsageScreen('settings')
    setUsageScreen('chats')
    expect(events('scroll_depth')).toEqual([])
  })
})

describe('chat input', () => {
  it('reports dropped and pasted files by extension only', () => {
    reportChatInput('drop', [{ name: 'Board notes – Sam.PDF' }, { name: 'README' }])
    expect(events('chat_input')).toEqual([
      { method: 'drop', extension: 'pdf' },
      { method: 'drop', extension: '' }
    ])
  })
})
