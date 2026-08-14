/**
 * The driver's decisions against a fake CDP transport: what gets dispatched
 * for each verb, and - the safety property - that typing into an identity
 * field is refused at this layer with a takeover signal, no matter what the
 * agent asked for. The transport is the genuine boundary (Electron's
 * webContents.debugger); everything above it runs real.
 */
import { describe, expect, it } from 'vitest'
import { BrowserDriver, type CdpTransport } from '../browser-driver'
import type { PageElement } from '../page-script'

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
  })

  it('throws when the page returns nothing rather than inventing an empty page', async () => {
    const { cdp } = makeTransport(() => ({ result: {} }))
    await expect(new BrowserDriver(cdp).snapshot()).rejects.toThrow(/no value/)
  })
})

describe('navigate', () => {
  it('resolves once the load event fires', async () => {
    const t = makeTransport()
    const driver = new BrowserDriver(t.cdp)
    const nav = driver.navigate('https://x.test')
    // Page.enable + Page.navigate dispatched; the load event releases the wait.
    await new Promise((r) => setImmediate(r))
    t.emit('Page.loadEventFired')
    expect(await nav).toEqual({ ok: true })
    expect(t.sent.map((s) => s.method)).toEqual(['Page.enable', 'Page.navigate'])
  })

  it('surfaces a navigation error as the honest failure', async () => {
    const t = makeTransport((method) =>
      method === 'Page.navigate' ? { errorText: 'net::ERR_NAME_NOT_RESOLVED' } : {}
    )
    const result = await new BrowserDriver(t.cdp).navigate('https://nope.invalid')
    expect(result).toEqual({ ok: false, reason: 'error', detail: 'net::ERR_NAME_NOT_RESOLVED' })
  })
})

describe('click and type', () => {
  it('clicks at the element center with a press/release pair', async () => {
    const t = makeTransport()
    await new BrowserDriver(t.cdp).click(el())
    expect(t.sent.map((s) => [s.method, s.params?.type, s.params?.x])).toEqual([
      ['Input.dispatchMouseEvent', 'mousePressed', 200],
      ['Input.dispatchMouseEvent', 'mouseReleased', 200]
    ])
  })

  it('type focuses, selects the prefilled value, then inserts the text', async () => {
    const t = makeTransport()
    await new BrowserDriver(t.cdp).type(el(), 'KX93F')
    const methods = t.sent.map((s) => s.method)
    expect(methods).toEqual([
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

  it('clicking an identity field is allowed - focusing the login form is how the human takes over', async () => {
    const t = makeTransport()
    const result = await new BrowserDriver(t.cdp).click(el({ identity: true }))
    expect(result).toEqual({ ok: true })
    expect(t.sent).toHaveLength(2)
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
