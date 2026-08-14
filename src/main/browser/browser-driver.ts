/**
 * The browser rail's hands: snapshot / navigate / click / type / key over raw
 * CDP. The transport is a seam (CdpTransport) so the driver's decisions - what
 * gets dispatched, what is refused - are testable against a fake; Electron's
 * webContents.debugger attach lives in the pane host, not here.
 *
 * One hard rule is enforced at this layer, not left to the agent's judgment:
 * typing into an identity field (password / one-time-code) is REFUSED with a
 * takeover signal. Clicking one is allowed - focusing a login form is how the
 * human takes over - but credentials never flow through the agent.
 */
import { pageScriptSource, type PageElement, type PageSnapshot } from './page-script'

export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** Subscribe to CDP events; returns unsubscribe. */
  on(listener: (method: string, params: unknown) => void): () => void
}

export type DriverResult =
  | { ok: true }
  | { ok: false; reason: 'takeover' | 'error'; detail: string }

const NAVIGATION_TIMEOUT_MS = 20_000

export class BrowserDriver {
  constructor(private readonly cdp: CdpTransport) {}

  /** The indexed elements + text the agent reasons over, straight from the page. */
  async snapshot(): Promise<PageSnapshot> {
    const reply = await this.cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: pageScriptSource(),
      returnByValue: true
    })
    const raw = reply.result?.value
    if (typeof raw !== 'string') {
      throw new Error('page snapshot returned no value')
    }
    return JSON.parse(raw) as PageSnapshot
  }

  /** Navigates and resolves on the load event (or the timeout - slow pages
   *  still get a snapshot of whatever rendered). */
  async navigate(url: string): Promise<DriverResult> {
    await this.cdp.send('Page.enable')
    const loaded = new Promise<void>((resolve) => {
      const off = this.cdp.on((method) => {
        if (method === 'Page.loadEventFired') {
          off()
          resolve()
        }
      })
      setTimeout(() => {
        off()
        resolve()
      }, NAVIGATION_TIMEOUT_MS).unref()
    })
    const reply = await this.cdp.send<{ errorText?: string }>('Page.navigate', { url })
    if (reply.errorText) {
      return { ok: false, reason: 'error', detail: reply.errorText }
    }
    await loaded
    return { ok: true }
  }

  async click(el: PageElement): Promise<DriverResult> {
    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.cdp.send('Input.dispatchMouseEvent', {
        type,
        x: el.cx,
        y: el.cy,
        button: 'left',
        clickCount: 1
      })
    }
    return { ok: true }
  }

  /** Click-to-focus, then insert. Identity fields refuse - that is the takeover
   *  boundary, enforced here so no prompt injection can talk the agent past it. */
  async type(el: PageElement, text: string): Promise<DriverResult> {
    if (el.identity) {
      return {
        ok: false,
        reason: 'takeover',
        detail: `"${el.name || el.tag}" is a credential field - the user signs in directly in the watched pane`
      }
    }
    await this.click(el)
    // Select-all so typing REPLACES a prefilled value instead of appending.
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      commands: ['selectAll']
    })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
    await this.cdp.send('Input.insertText', { text })
    return { ok: true }
  }

  /** A named key (Enter, Escape, Tab) to the focused element. */
  async pressKey(key: string): Promise<DriverResult> {
    const keyed: Record<string, { code: string; keyCode: number }> = {
      Enter: { code: 'Enter', keyCode: 13 },
      Escape: { code: 'Escape', keyCode: 27 },
      Tab: { code: 'Tab', keyCode: 9 }
    }
    const spec = keyed[key]
    if (!spec) {
      return { ok: false, reason: 'error', detail: `unsupported key "${key}"` }
    }
    for (const type of ['rawKeyDown', 'keyUp'] as const) {
      await this.cdp.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode
      })
    }
    return { ok: true }
  }
}
