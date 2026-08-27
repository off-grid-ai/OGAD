/**
 * The driver's decisions against a fake CDP transport: what gets dispatched
 * for each verb, and - the safety property - that typing into an identity
 * field is refused at this layer with a takeover signal, no matter what the
 * agent asked for. The transport is the genuine boundary (Electron's
 * webContents.debugger); everything above it runs real.
 */
import { describe, expect, it } from 'vitest'
import {
  BrowserDriver,
  browserHotkeyTokens,
  browserPointerMotion,
  browserShortcutCommand,
  type CdpTransport
} from '../browser-driver'
import type { PageElement } from '../page-script'
import {
  BROWSER_POINTER_VISUAL,
  browserPointerBackgroundImage
} from '../../../shared/browser-pointer-visual'

interface Sent {
  method: string
  params?: Record<string, unknown>
}

const makeTransport = (
  respond: (method: string) => unknown = () => ({})
): { cdp: CdpTransport; sent: Sent[]; emit: (method: string) => void } => {
  const sent: Sent[] = []
  const listeners = new Set<(method: string, params: unknown) => void>()
  return {
    sent,
    emit: (method) => listeners.forEach((l) => l(method, {})),
    cdp: {
      send: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
        sent.push({ method, params })
        return respond(method) as T
      },
      on: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

const el = (over: Partial<PageElement> = {}): PageElement => ({
  index: 1,
  tag: 'input',
  role: 'textbox',
  name: 'Booking reference',
  value: '',
  cx: 200,
  cy: 80,
  identity: false,
  href: '',
  ...over
})

describe('snapshot', () => {
  it('parks and publishes the semantic pointer before the first browser action', async () => {
    const t = makeTransport()
    const pointer: Array<{ phase: string; x: number; y: number }> = []
    const driver = new BrowserDriver(t.cdp, undefined, {
      onPointer: (event) => pointer.push(event)
    })

    await driver.ensurePointer()

    const expression = String(t.sent[0]?.params?.expression)
    expect(expression).toContain('__offgrid_agent_pointer__')
    // The cursor is painted with CSS, never parsed as HTML: `innerHTML` is a Trusted Types sink, so
    // on any page that requires Trusted Types (every Google property) assigning it threw and the
    // cursor never appeared at all - not in the live view, not in captured screenshots. Assert the
    // sink is gone, and assert against the shared visual rather than re-hardcoding its geometry.
    expect(expression).not.toContain('innerHTML')
    expect(expression).toContain(`background-image:${browserPointerBackgroundImage()}`)
    expect(browserPointerBackgroundImage()).toContain(
      encodeURIComponent(`viewBox="${BROWSER_POINTER_VISUAL.viewBox}"`)
    )
    expect(expression).toContain(`drop-shadow(0 0 5px ${BROWSER_POINTER_VISUAL.glow})`)
    expect(expression).toContain("const observerKey = '__offgrid_agent_pointer_observer__'")
    expect(expression).toContain('new MutationObserver(mount)')
    expect(expression).toContain('(document.body || document.documentElement).appendChild(cursor)')
    expect(expression).not.toContain('clip-path:polygon')
    expect(pointer).toEqual([{ phase: 'released', x: 32, y: 32 }])
  })

  it('evaluates the injected collector and parses its JSON', async () => {
    const { cdp, sent } = makeTransport(() => ({
      result: {
        value: JSON.stringify({ url: 'https://x.test', title: 't', elements: [], text: '' })
      }
    }))
    const snapshot = await new BrowserDriver(cdp).snapshot()
    expect(snapshot.url).toBe('https://x.test')
    expect(sent[0]?.method).toBe('Runtime.evaluate')
    expect(String(sent[0]?.params?.expression)).toContain('collectInteractiveElements')
    expect(String(sent[1]?.params?.expression)).toContain('__offgrid_agent_pointer__')
    expect(String(sent[1]?.params?.expression)).not.toContain('cursor?.remove')
  })

  it('throws when the page returns nothing rather than inventing an empty page', async () => {
    const { cdp } = makeTransport(() => ({ result: {} }))
    await expect(new BrowserDriver(cdp).snapshot()).rejects.toThrow(/no value/)
  })
})

describe('navigate', () => {
  it('resolves once the load event fires', async () => {
    const t = makeTransport()
    const pointer: Array<{ phase: string; x: number; y: number }> = []
    const driver = new BrowserDriver(t.cdp, undefined, {
      onPointer: (event) => pointer.push(event)
    })
    const nav = driver.navigate('https://x.test')
    // Page.enable + Page.navigate dispatched; the load event releases the wait.
    await new Promise((r) => setImmediate(r))
    t.emit('Page.loadEventFired')
    expect(await nav).toEqual({ ok: true })
    expect(t.sent.map((s) => s.method)).toEqual([
      'Page.enable',
      'Page.navigate',
      'Runtime.evaluate'
    ])
    expect(pointer).toEqual([{ phase: 'released', x: 32, y: 32 }])
  })

  it('surfaces a navigation error as the honest failure', async () => {
    const t = makeTransport((method) =>
      method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {}
    )
    const result = await new BrowserDriver(t.cdp).navigate('https://nope.invalid')
    expect(result).toEqual({ ok: false, reason: 'error', detail: 'net::ERR_NAME_NOT_RESOLVED' })
  })

  it('executes a validated navigate action through the browser boundary', async () => {
    const t = makeTransport()
    const navigation = new BrowserDriver(t.cdp).actuate({
      type: 'navigate',
      url: 'https://x.test/results'
    })
    await new Promise((resolve) => setImmediate(resolve))
    t.emit('Page.loadEventFired')

    await expect(navigation).resolves.toEqual({ ok: true })
    expect(t.sent).toEqual(
      expect.arrayContaining([
        { method: 'Page.navigate', params: { url: 'https://x.test/results' } }
      ])
    )
  })
})

describe('browser hotkeys', () => {
  it('accepts plus-delimited and space-delimited chord spellings', () => {
    expect(browserHotkeyTokens('ALT+LEFT')).toEqual(['ALT', 'LEFT'])
    expect(browserHotkeyTokens('cmd l')).toEqual(['cmd', 'l'])
    expect(browserShortcutCommand(['ALT', 'LEFT'])).toBe('back')
    expect(browserShortcutCommand(['Option', 'Right'])).toBe('forward')
    expect(browserShortcutCommand(['Meta', '['])).toBe('back')
    expect(browserShortcutCommand(['CTRL', 'SHIFT', 'R'])).toBe('hard_reload')
    expect(browserShortcutCommand(['F12'])).toBe('blocked_chrome')
    expect(browserShortcutCommand(['Tab'])).toBe('page')
  })

  it('turns Alt+Left into a direct browser-history command', async () => {
    const t = makeTransport((method) => {
      if (method === 'Page.getNavigationHistory') {
        return {
          currentIndex: 1,
          entries: [
            { id: 10, url: 'https://x.test/results' },
            { id: 11, url: 'https://x.test/booking' }
          ]
        }
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { url: 'https://x.test/results', readyState: 'complete' } } }
      }
      return {}
    })

    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'hotkey', keys: 'ALT+LEFT' })
    ).resolves.toEqual({ ok: true })
    expect(t.sent.some((entry) => entry.method === 'Input.dispatchKeyEvent')).toBe(false)
    expect(t.sent).toEqual(
      expect.arrayContaining([
        { method: 'Page.getNavigationHistory', params: undefined },
        { method: 'Page.navigateToHistoryEntry', params: { entryId: 10 } }
      ])
    )
  })

  it('rejects address-bar and close-tab chords instead of pretending they worked', async () => {
    const t = makeTransport()
    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'hotkey', keys: 'CTRL+L' })
    ).resolves.toMatchObject({ ok: false, reason: 'recoverable' })
    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'hotkey', keys: 'CMD+W' })
    ).resolves.toMatchObject({ ok: false, reason: 'recoverable' })
    expect(t.sent).toEqual([])
  })

  it('turns the primary reload chord into a direct page reload', async () => {
    const t = makeTransport((method) =>
      method === 'Runtime.evaluate'
        ? { result: { value: { url: 'https://x.test/results', readyState: 'complete' } } }
        : {}
    )

    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'hotkey', keys: 'CMD+R' })
    ).resolves.toEqual({ ok: true })
    expect(t.sent.some((entry) => entry.method === 'Page.reload')).toBe(true)
    expect(t.sent.some((entry) => entry.method === 'Input.dispatchKeyEvent')).toBe(false)
  })

  it('turns UI-Mate press F5 into a direct page reload', async () => {
    const t = makeTransport((method) =>
      method === 'Runtime.evaluate'
        ? { result: { value: { url: 'https://x.test/results', readyState: 'complete' } } }
        : {}
    )

    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'press', keys: ['f5'] })
    ).resolves.toEqual({ ok: true })
    expect(t.sent.some((entry) => entry.method === 'Page.reload')).toBe(true)
    expect(t.sent.some((entry) => entry.method === 'Input.dispatchKeyEvent')).toBe(false)
  })

  it('turns a hard-reload alias into a direct cache-bypassing reload', async () => {
    const t = makeTransport((method) =>
      method === 'Runtime.evaluate'
        ? { result: { value: { url: 'https://x.test/results', readyState: 'complete' } } }
        : {}
    )

    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'hotkey', keys: 'CTRL+SHIFT+R' })
    ).resolves.toEqual({ ok: true })
    expect(t.sent).toEqual(
      expect.arrayContaining([{ method: 'Page.reload', params: { ignoreCache: true } }])
    )
    expect(t.sent.some((entry) => entry.method === 'Input.dispatchKeyEvent')).toBe(false)
  })

  it('blocks Developer Tools keys instead of reporting a false success', async () => {
    const t = makeTransport()

    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'press', keys: ['f12'] })
    ).resolves.toMatchObject({ ok: false, reason: 'recoverable' })
    await expect(
      new BrowserDriver(t.cdp).actuate({ type: 'hotkey', keys: 'CTRL+SHIFT+I' })
    ).resolves.toMatchObject({ ok: false, reason: 'recoverable' })
    expect(t.sent).toEqual([])
  })
})

describe('page readiness recovery', () => {
  it('accepts a committed canvas-only page and executes the visual action without DOM heuristics', async () => {
    const t = makeTransport((method) => {
      if (method !== 'Runtime.evaluate') return {}
      return {
        result: {
          value: { url: 'https://x.test/canvas', readyState: 'complete' }
        }
      }
    })
    const driver = new BrowserDriver(t.cdp, undefined, { pageReadyTimeoutMs: 0 })

    await expect(driver.ensurePageReady()).resolves.toEqual({
      url: 'https://x.test/canvas',
      readyState: 'complete'
    })
    await expect(driver.actuate({ type: 'click', point: { x: 320, y: 180 } })).resolves.toEqual({
      ok: true
    })

    const readinessProbe = String(t.sent[0]?.params?.expression)
    expect(readinessProbe).not.toContain('querySelectorAll')
    expect(readinessProbe).not.toContain('innerText')
    expect(t.sent.some((entry) => entry.method === 'Page.reload')).toBe(false)
    expect(
      t.sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').at(-1)?.params
    ).toMatchObject({ type: 'mouseReleased', x: 320, y: 180 })
  })

  it('does not accept about:blank as an actionable webpage', async () => {
    const t = makeTransport(() => ({
      result: {
        value: {
          url: 'about:blank',
          readyState: 'complete'
        }
      }
    }))
    const driver = new BrowserDriver(t.cdp, undefined, { pageReadyTimeoutMs: 0 })

    await expect(driver.ensurePageReady()).rejects.toThrow(/did not finish loading/)
    expect(t.sent.some((entry) => entry.method === 'Page.reload')).toBe(true)
  })
})

describe('click and type', () => {
  it('builds a short eased path that ends at the exact model coordinate', () => {
    const motion = browserPointerMotion({ x: 32, y: 32 }, { x: 200, y: 80 })

    expect(motion.durationMs).toBeGreaterThanOrEqual(120)
    expect(motion.durationMs).toBeLessThanOrEqual(240)
    expect(motion.points.length).toBeGreaterThan(2)
    expect(motion.points.at(-1)).toEqual({ x: 200, y: 80 })
    expect(motion.points.every((point) => point.x >= 32 && point.x <= 200)).toBe(true)
  })

  it('moves to the real element center, then emits pressed and released phases', async () => {
    const t = makeTransport()
    const pointer: Array<{ phase: string; x: number; y: number }> = []
    await new BrowserDriver(t.cdp, undefined, {
      onPointer: (event) => pointer.push(event)
    }).click(el())
    const mouseEvents = t.sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent')
    expect(mouseEvents.length).toBeGreaterThan(3)
    expect(mouseEvents.slice(-3).map((event) => event.params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased'
    ])
    expect(mouseEvents.at(-1)?.params).toMatchObject({ x: 200, y: 80 })
    const pointerFrames = t.sent.filter((entry) => entry.method === 'Runtime.evaluate')
    expect(pointerFrames).toHaveLength(3)
    expect(String(pointerFrames[0]?.params?.expression)).toContain('__offgrid_agent_pointer__')
    expect(String(pointerFrames[0]?.params?.expression)).toContain('prefers-reduced-motion')
    expect(String(pointerFrames[1]?.params?.expression)).toContain("'pressed'")
    expect(String(pointerFrames[1]?.params?.expression)).toContain('__offgrid_agent_click_marker__')
    expect(String(pointerFrames[1]?.params?.expression)).toContain('{"x":200,"y":80}')
    expect(String(pointerFrames[1]?.params?.expression)).toContain('pulse.animate')
    expect(String(pointerFrames[2]?.params?.expression)).not.toContain('cursor?.remove')
    expect(pointer.slice(-3)).toEqual([
      { phase: 'moved', x: 200, y: 80 },
      { phase: 'pressed', x: 200, y: 80 },
      { phase: 'released', x: 200, y: 80 }
    ])
  })

  it('type focuses, selects the prefilled value, then inserts the text', async () => {
    const t = makeTransport((method) =>
      method === 'Runtime.evaluate' ? { result: { value: false } } : {}
    )
    await new BrowserDriver(t.cdp).type(el(), 'KX93F')
    const methods = t.sent.map((s) => s.method).filter((method) => method !== 'Runtime.evaluate')
    expect(methods.slice(-5)).toEqual([
      'Input.dispatchMouseEvent',
      'Input.dispatchMouseEvent',
      'Input.dispatchKeyEvent',
      'Input.dispatchKeyEvent',
      'Input.insertText'
    ])
    expect(t.sent.at(-1)?.params).toEqual({ text: 'KX93F' })
  })

  it('REFUSES to type into an identity field - the takeover boundary is the driver, not the prompt', async () => {
    const t = makeTransport()
    const result = await new BrowserDriver(t.cdp).type(
      el({ identity: true, name: 'Password', tag: 'input' }),
      'hunter2'
    )
    expect(result).toMatchObject({ ok: false, reason: 'takeover' })
    // Nothing was dispatched: no focus click, no keystrokes, no credential text.
    expect(t.sent).toEqual([])
  })

  it('REFUSES visual typing when the focused field is private', async () => {
    const t = makeTransport((method) =>
      method === 'Runtime.evaluate' ? { result: { value: true } } : {}
    )
    const result = await new BrowserDriver(t.cdp).actuate({ type: 'type', content: '839201' })

    expect(result).toMatchObject({ ok: false, reason: 'takeover' })
    expect(t.sent.some((entry) => entry.method === 'Input.insertText')).toBe(false)
    expect(JSON.stringify(t.sent)).not.toContain('839201')
  })

  it('dispatches an approved visual type action without a DOM editability veto', async () => {
    const t = makeTransport((method) =>
      method === 'Runtime.evaluate' ? { result: { value: false } } : {}
    )

    const result = await new BrowserDriver(t.cdp).actuate({ type: 'type', content: 'Pune' })

    expect(result).toEqual({ ok: true })
    expect(t.sent.filter((entry) => entry.method === 'Input.dispatchKeyEvent')).toHaveLength(2)
    expect(t.sent.find((entry) => entry.method === 'Input.insertText')?.params).toEqual({
      text: 'Pune'
    })
  })

  it('clicking an identity field is allowed - focusing the login form is how the human takes over', async () => {
    const t = makeTransport()
    const result = await new BrowserDriver(t.cdp).click(el({ identity: true }))
    expect(result).toEqual({ ok: true })
    const mouseEvents = t.sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent')
    expect(mouseEvents.length).toBeGreaterThan(3)
    expect(mouseEvents.slice(-2).map((event) => event.params?.type)).toEqual([
      'mousePressed',
      'mouseReleased'
    ])
  })
})

describe('pressKey', () => {
  it('dispatches a known key with its virtual key code', async () => {
    const t = makeTransport()
    expect(await new BrowserDriver(t.cdp).pressKey('Enter')).toEqual({ ok: true })
    expect(t.sent.map((s) => [s.params?.type, s.params?.windowsVirtualKeyCode])).toEqual([
      ['rawKeyDown', 13],
      ['keyUp', 13]
    ])
  })

  it('refuses an unknown key instead of guessing a code', async () => {
    const t = makeTransport()
    const result = await new BrowserDriver(t.cdp).pressKey('F13')
    expect(result).toMatchObject({ ok: false, reason: 'error' })
    expect(t.sent).toEqual([])
  })
})

describe('visual operator actions', () => {
  it('actuates the exact visual point without DOM target resolution', async () => {
    const t = makeTransport()
    const driver = new BrowserDriver(t.cdp)

    await driver.actuate({ type: 'click', point: { x: 139, y: 245 } })

    const pressed = t.sent.find((entry) => entry.params?.type === 'mousePressed')
    expect(pressed?.params).toMatchObject({ x: 139, y: 245 })
    const evaluatedSource = t.sent
      .filter((entry) => entry.method === 'Runtime.evaluate')
      .map((entry) => String(entry.params?.expression))
      .join('\n')
    expect(evaluatedSource).not.toContain('elementFromPoint')
    expect(evaluatedSource).not.toContain("querySelectorAll('body *')")
  })

  it('keeps UI-Mate scroll direction semantics in Chromium', async () => {
    const t = makeTransport()
    const driver = new BrowserDriver(t.cdp)
    await driver.actuate({ type: 'scroll_by', axis: 'vertical', amount: 240 })
    await driver.actuate({ type: 'scroll_by', axis: 'horizontal', amount: 120 })
    const wheel = t.sent.filter((entry) => entry.params?.type === 'mouseWheel')
    expect(wheel.map((entry) => [entry.params?.deltaX, entry.params?.deltaY])).toEqual([
      [0, -240],
      [120, 0]
    ])
  })
})

describe('CDP command timeout (a wedged transport must not hang the rail)', () => {
  // A transport whose send never resolves - what a crashed network service /
  // wedged WebContents does to debugger.sendCommand.
  const deadTransport: CdpTransport = {
    send: <T>() => new Promise<T>(() => {}),
    on: () => () => {}
  }

  it('rejects snapshot after the command timeout instead of hanging forever', async () => {
    const driver = new BrowserDriver(deadTransport, 20)
    await expect(driver.snapshot()).rejects.toThrow(/Runtime\.evaluate timed out/)
  })

  it('rejects navigate after the command timeout instead of hanging forever', async () => {
    const driver = new BrowserDriver(deadTransport, 20)
    await expect(driver.navigate('https://x.test')).rejects.toThrow(/Page\.enable timed out/)
  })
})
