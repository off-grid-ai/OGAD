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
import {
  BROWSER_POINTER_VISUAL,
  browserPointerSvgMarkup
} from '../../shared/browser-pointer-visual'
import type { VisionAction } from '../vision/vision-action'

export interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** Subscribe to CDP events; returns unsubscribe. */
  on(listener: (method: string, params: unknown) => void): () => void
}

export type DriverResult =
  | { ok: true }
  | { ok: false; reason: 'takeover' | 'recoverable' | 'error'; detail: string }

export interface BrowserPointerEvent {
  phase: 'moved' | 'pressed' | 'released'
  x: number
  y: number
}

export interface BrowserViewportSize {
  width: number
  height: number
}

export const DEFAULT_BROWSER_POINTER: BrowserPointerEvent = {
  phase: 'released',
  x: 32,
  y: 32
}

interface BrowserDriverOptions {
  onPointer?: (event: BrowserPointerEvent) => void
  initialPointer?: BrowserPointerEvent
  pageReadyTimeoutMs?: number
}

export interface BrowserPointerMotion {
  durationMs: number
  points: ReadonlyArray<{ x: number; y: number }>
}

export interface BrowserPageState {
  url: string
  readyState: string
  documentId: string
}

interface BrowserNavigationHistory {
  currentIndex: number
  entries: ReadonlyArray<{ id: number; url: string }>
}

const NAVIGATION_TIMEOUT_MS = 20_000
/** A single CDP command should return in well under a second on a live page.
 *  When the WebContents/network service is wedged (e.g. after a "Network
 *  service crashed" event), `debugger.sendCommand` can hang FOREVER with no
 *  rejection - which froze the whole web task at setup with no step, no result,
 *  no error. Bound every command so a wedged transport fails fast and visibly
 *  instead of hanging. */
const CDP_COMMAND_TIMEOUT_MS = 15_000
const POINTER_FRAME_MS = 16
const POINTER_MIN_DURATION_MS = 120
const POINTER_MAX_DURATION_MS = 240

/** Build one short, deterministic pointer path. The driver remains the single
 * owner of both the visible pointer and the CDP pointer coordinates. */
export function browserPointerMotion(
  from: { x: number; y: number },
  to: { x: number; y: number }
): BrowserPointerMotion {
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance < 2) {
    return { durationMs: 0, points: [{ x: Math.round(to.x), y: Math.round(to.y) }] }
  }
  const durationMs = Math.round(
    Math.min(POINTER_MAX_DURATION_MS, Math.max(POINTER_MIN_DURATION_MS, 105 + distance * 0.16))
  )
  const steps = Math.max(2, Math.ceil(durationMs / POINTER_FRAME_MS))
  const points = Array.from({ length: steps }, (_, index) => {
    const progress = (index + 1) / steps
    const eased =
      progress < 0.5 ? 4 * progress * progress * progress : 1 - Math.pow(-2 * progress + 2, 3) / 2
    return {
      x: Math.round(from.x + (to.x - from.x) * eased),
      y: Math.round(from.y + (to.y - from.y) * eased)
    }
  }).filter(
    (point, index, all) =>
      index === 0 || point.x !== all[index - 1]!.x || point.y !== all[index - 1]!.y
  )
  return { durationMs, points }
}

/** Models commonly spell chords with either spaces or plus signs. CDP needs
 * separate key values, and browser-history chords need semantic handling. */
export function browserHotkeyTokens(keys: string): string[] {
  return keys
    .trim()
    .split(/[+\s]+/)
    .map((key) => key.trim())
    .filter(Boolean)
}

/** Browser chrome is not part of the captured page. Convert its portable
 * back/forward shortcuts into history movement instead of page key events. */
export function browserHistoryDelta(keys: readonly string[]): -1 | 0 | 1 {
  const command = browserShortcutCommand(keys)
  return command === 'back' ? -1 : command === 'forward' ? 1 : 0
}

export type BrowserShortcutCommand =
  | 'back'
  | 'forward'
  | 'reload'
  | 'hard_reload'
  | 'blocked_chrome'
  | 'page'

function canonicalShortcutTokens(keys: readonly string[]): Set<string> {
  const aliases: Record<string, string> = {
    control: 'ctrl',
    command: 'cmd',
    meta: 'cmd',
    option: 'alt',
    opt: 'alt',
    esc: 'escape',
    return: 'enter'
  }
  return new Set(keys.map((key) => aliases[key.toLowerCase()] ?? key.toLowerCase()))
}

function shortcutSignature(keys: readonly string[]): string {
  return [...canonicalShortcutTokens(keys)].sort().join('+')
}

const browserShortcutCommands = new Map<string, BrowserShortcutCommand>()
const registerBrowserShortcuts = (
  command: BrowserShortcutCommand,
  shortcuts: readonly (readonly string[])[]
): void => {
  for (const shortcut of shortcuts)
    browserShortcutCommands.set(shortcutSignature(shortcut), command)
}

registerBrowserShortcuts('back', [
  ['alt', 'left'],
  ['cmd', '[']
])
registerBrowserShortcuts('forward', [
  ['alt', 'right'],
  ['cmd', ']']
])
registerBrowserShortcuts('reload', [['f5'], ['ctrl', 'r'], ['cmd', 'r']])
registerBrowserShortcuts('hard_reload', [
  ['ctrl', 'shift', 'r'],
  ['cmd', 'shift', 'r'],
  ['ctrl', 'f5'],
  ['shift', 'f5']
])
registerBrowserShortcuts('blocked_chrome', [
  ['f11'],
  ['f12'],
  ['shift', 'escape'],
  ...['ctrl', 'cmd'].flatMap((primary) =>
    ['l', 'w', 't', 'n', 'p', 's', 'o', 'u', 'j', 'h', 'd', 'f', '+', '-', '=', '0'].map((key) => [
      primary,
      key
    ])
  ),
  ...['ctrl', 'cmd'].flatMap((primary) =>
    ['i', 'j', 'c', 'b', 'n', 't'].map((key) => [primary, 'shift', key])
  ),
  ...Array.from({ length: 9 }, (_, index) => ['cmd', String(index + 1)]),
  ['ctrl', 'tab'],
  ['ctrl', 'shift', 'tab'],
  ['ctrl', 'pageup'],
  ['ctrl', 'pagedown']
])

/** Resolve shortcuts that belong to browser chrome. Page-level keys remain
 * ordinary CDP input. Invisible or unsafe chrome commands fail explicitly. */
export function browserShortcutCommand(keys: readonly string[]): BrowserShortcutCommand {
  return browserShortcutCommands.get(shortcutSignature(keys)) ?? 'page'
}

export class BrowserDriver {
  private pointer: BrowserPointerEvent
  private lastClick: { x: number; y: number } | null = null
  private readonly documentIdentityProperty = `__offgrid_document_${Math.random().toString(36).slice(2)}`
  private readonly onPointer?: (event: BrowserPointerEvent) => void
  private readonly pageReadyTimeoutMs: number

  constructor(
    private readonly cdp: CdpTransport,
    private readonly commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS,
    options: BrowserDriverOptions = {}
  ) {
    this.onPointer = options.onPointer
    this.pointer = options.initialPointer ?? DEFAULT_BROWSER_POINTER
    this.pageReadyTimeoutMs = options.pageReadyTimeoutMs ?? 10_000
  }

  /** The ONE choke point every CDP command goes through: race the transport
   *  send against a timeout so no single command can hang the rail. */
  private send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`CDP ${method} timed out after ${this.commandTimeoutMs}ms`)),
        this.commandTimeoutMs
      )
      timer.unref()
    })
    return Promise.race([this.cdp.send<T>(method, params), timeout]).finally(() =>
      clearTimeout(timer)
    )
  }

  /** Draw the agent pointer inside the Chromium page itself. Electron places a
   * WebContentsView above renderer DOM, so a React overlay cannot appear over
   * the live page. CDP evaluation keeps the visual at the exact viewport
   * coordinates used by Input.dispatchMouseEvent. */
  private async showPointer(
    event: BrowserPointerEvent,
    onlyIfMissing = false,
    transitionMs = 0
  ): Promise<boolean> {
    const pointerMarkup = browserPointerSvgMarkup()
    const expression = `(() => {
      const id = '__offgrid_agent_pointer__';
      const markerId = '__offgrid_agent_click_marker__';
      const observerKey = '__offgrid_agent_pointer_observer__';
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      let cursor = document.getElementById(id);
      if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = id;
        cursor.setAttribute('aria-hidden', 'true');
        cursor.style.cssText = 'position:fixed;left:0;top:0;width:${BROWSER_POINTER_VISUAL.width}px;height:${BROWSER_POINTER_VISUAL.height}px;pointer-events:none;z-index:2147483647;will-change:transform;filter:drop-shadow(0 0 5px ${BROWSER_POINTER_VISUAL.glow}) drop-shadow(0 1px 1px rgba(0,0,0,.5));';
        cursor.innerHTML = ${JSON.stringify(pointerMarkup)};
      }
      const lastClick = ${JSON.stringify(this.lastClick)};
      let marker = document.getElementById(markerId);
      if (lastClick && !marker) {
        marker = document.createElement('div');
        marker.id = markerId;
        marker.setAttribute('aria-hidden', 'true');
        marker.style.cssText = 'position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border:2px solid ${BROWSER_POINTER_VISUAL.action};border-radius:9999px;pointer-events:none;z-index:2147483646;box-sizing:border-box;box-shadow:0 0 0 2px rgba(255,255,255,.9),0 0 7px ${BROWSER_POINTER_VISUAL.glow};';
      }
      const mount = () => {
        if (!cursor.isConnected) (document.body || document.documentElement).appendChild(cursor);
        if (marker && !marker.isConnected) (document.body || document.documentElement).appendChild(marker);
      };
      mount();
      if (!window[observerKey]) {
        const observer = new MutationObserver(mount);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window[observerKey] = observer;
      }
      cursor.style.transition = reduceMotion || ${transitionMs} <= 0
        ? 'none'
        : 'transform ${transitionMs}ms cubic-bezier(.45,0,.55,1)';
      if (!${JSON.stringify(onlyIfMissing)} || !cursor.dataset.positioned) {
        cursor.style.transform = 'translate3d(${Math.round(event.x - BROWSER_POINTER_VISUAL.hotspotX)}px,${Math.round(event.y - BROWSER_POINTER_VISUAL.hotspotY)}px,0)';
        cursor.dataset.positioned = 'true';
      }
      if (marker && lastClick) {
        marker.style.transform = 'translate3d(' + Math.round(lastClick.x) + 'px,' + Math.round(lastClick.y) + 'px,0)';
      }
      if (${JSON.stringify(event.phase)} === 'pressed') {
        const pulse = document.createElement('div');
        pulse.style.cssText = 'position:fixed;width:8px;height:8px;margin:-4px 0 0 -4px;border:1.5px solid;border-radius:9999px;pointer-events:none;z-index:2147483646;';
        pulse.style.borderColor = ${JSON.stringify(BROWSER_POINTER_VISUAL.action)};
        pulse.style.left = ${Math.round(event.x)} + 'px';
        pulse.style.top = ${Math.round(event.y)} + 'px';
        document.documentElement.appendChild(pulse);
        if (reduceMotion) {
          window.setTimeout(() => pulse.remove(), 80);
        } else {
          const animation = pulse.animate(
            [{ transform: 'scale(.55)', opacity: 1 }, { transform: 'scale(2)', opacity: 0 }],
            { duration: 320, easing: 'ease-out' }
          );
          animation.finished.finally(() => pulse.remove());
        }
      }
      return reduceMotion;
    })()`
    const response = await this.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
      expression,
      returnByValue: true
    }).catch(() => {
      // Pointer feedback is best-effort. A page that blocks evaluation must not
      // prevent the actual, already-authorized browser action.
      return undefined
    })
    return response?.result?.value === true
  }

  private async movePointerTo(
    x: number,
    y: number,
    button?: 'left' | 'right' | 'middle'
  ): Promise<void> {
    const destination = { phase: 'moved' as const, x, y }
    const motion = browserPointerMotion(this.pointer, destination)
    const reduceMotion = await this.showPointer(destination, false, motion.durationMs)
    const points = reduceMotion ? [motion.points.at(-1)!] : motion.points
    const frameDelayMs = reduceMotion ? 0 : motion.durationMs / Math.max(1, points.length)
    for (const point of points) {
      this.pointer = { phase: 'moved', ...point }
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...point,
        ...(button ? { button } : {})
      })
      this.onPointer?.(this.pointer)
      if (frameDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, frameDelayMs))
      }
    }
  }

  /** Keep one semantic Off Grid pointer visible for the full Web Use session.
   * Native navigation replaces the page DOM, so the host calls this again at
   * every document boundary and before it publishes a terminal task state. */
  async ensurePointer(onlyIfMissing = true): Promise<void> {
    await this.showPointer(this.pointer, onlyIfMissing)
    this.onPointer?.(this.pointer)
  }

  /** Chromium input uses CSS pixels, which can differ from capturePage pixels on Retina. */
  async viewportSize(): Promise<BrowserViewportSize> {
    const response = await this.send<{ result?: { value?: BrowserViewportSize } }>(
      'Runtime.evaluate',
      {
        expression: '({ width: window.innerWidth, height: window.innerHeight })',
        returnByValue: true
      }
    )
    const value = response.result?.value
    return value && value.width > 0 && value.height > 0 ? value : { width: 1, height: 1 }
  }

  /** Read only document-lifecycle state. Visual content belongs to the
   * screenshot boundary and semantic action approval belongs to the model. */
  async pageState(): Promise<BrowserPageState> {
    const response = await this.send<{ result?: { value?: BrowserPageState } }>(
      'Runtime.evaluate',
      {
        expression: `(() => {
          const key = ${JSON.stringify(this.documentIdentityProperty)};
          if (!globalThis[key]) globalThis[key] = Math.random().toString(36).slice(2);
          return { url: location.href, readyState: document.readyState, documentId: globalThis[key] };
        })()`,
        returnByValue: true
      }
    )
    return (
      response.result?.value ?? {
        url: '',
        readyState: 'loading',
        documentId: ''
      }
    )
  }

  private pageIsReady(state: BrowserPageState): boolean {
    return /^https?:\/\//i.test(state.url) && state.readyState !== 'loading'
  }

  private async waitForReadyDocument(): Promise<BrowserPageState | null> {
    const deadline = Date.now() + this.pageReadyTimeoutMs
    while (Date.now() <= deadline) {
      const state = await this.pageState()
      if (this.pageIsReady(state)) return state
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100)
        timer.unref()
      })
    }
    return null
  }

  /** Wait for a committed document, then reload once if it remains at a
   * document boundary. Pixel evidence is validated by the capture owner. */
  async ensurePageReady(recover = true): Promise<BrowserPageState> {
    const ready = await this.waitForReadyDocument()
    if (ready) return ready
    if (recover) {
      await this.send('Page.reload', { ignoreCache: false })
      const recovered = await this.waitForReadyDocument()
      if (recovered) return recovered
    }
    throw new Error('The browser page did not finish loading after guarded recovery.')
  }

  async reloadAndWait(ignoreCache = false): Promise<BrowserPageState> {
    await this.send('Page.reload', { ignoreCache })
    const recovered = await this.waitForReadyDocument()
    if (recovered) return recovered
    throw new Error('The browser page did not finish loading after reload.')
  }

  /** The indexed elements + text the agent reasons over, straight from the page. */
  async snapshot(): Promise<PageSnapshot> {
    const reply = await this.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: pageScriptSource(),
      returnByValue: true
    })
    const raw = reply.result?.value
    if (typeof raw !== 'string') {
      throw new Error('page snapshot returned no value')
    }
    const snapshot = JSON.parse(raw) as PageSnapshot
    // A document navigation replaces the injected DOM. Recreate the cursor on
    // every observation so Web Use always has a visible agent pointer, even
    // before its first click on a new page.
    await this.ensurePointer(true)
    return snapshot
  }

  /** Navigates and resolves on the load event (or the timeout - slow pages
   *  still get a snapshot of whatever rendered). */
  async navigate(url: string): Promise<DriverResult> {
    await this.send('Page.enable')
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
    const reply = await this.send<{ errorText?: string }>('Page.navigate', { url })
    if (reply.errorText) {
      return { ok: false, reason: 'error', detail: reply.errorText }
    }
    await loaded
    await this.ensurePointer(true)
    return { ok: true }
  }

  private async moveThroughHistory(delta: -1 | 1): Promise<DriverResult> {
    const history = await this.send<BrowserNavigationHistory>('Page.getNavigationHistory')
    const target = history.entries[history.currentIndex + delta]
    if (!target) {
      return {
        ok: false,
        reason: 'recoverable',
        detail: delta < 0 ? 'There is no earlier browser page.' : 'There is no later browser page.'
      }
    }
    await this.send('Page.navigateToHistoryEntry', { entryId: target.id })
    const deadline = Date.now() + this.pageReadyTimeoutMs
    do {
      const state = await this.pageState()
      if (state.url === target.url && state.readyState !== 'loading') {
        await this.ensurePointer(true)
        return { ok: true }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100)
        timer.unref()
      })
    } while (Date.now() <= deadline)
    return {
      ok: false,
      reason: 'recoverable',
      detail: 'The browser did not finish moving through its history.'
    }
  }

  async click(el: PageElement): Promise<DriverResult> {
    return this.clickPoint(el.cx, el.cy, 'left', 1)
  }

  private async clickPoint(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    clickCount: number
  ): Promise<DriverResult> {
    await this.movePointerTo(x, y)
    this.lastClick = { x, y }
    const phases = [
      { type: 'mousePressed', phase: 'pressed' },
      { type: 'mouseReleased', phase: 'released' }
    ] as const
    for (const { type, phase } of phases) {
      const pointer = { phase, x, y }
      this.pointer = pointer
      await this.showPointer(pointer)
      await this.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button,
        clickCount
      })
      this.onPointer?.(pointer)
    }
    return { ok: true }
  }

  private async focusedFieldIsPrivate(): Promise<boolean> {
    const reply = await this.send<{
      result?: { value?: boolean }
    }>('Runtime.evaluate', {
      expression: `(() => {
        const el = document.activeElement;
        const input = el instanceof HTMLInputElement;
        return Boolean(input && (el.type === 'password' || el.autocomplete === 'one-time-code'));
      })()`,
      returnByValue: true
    })
    return reply.result?.value === true
  }

  private async typeFocused(text: string): Promise<DriverResult> {
    if (await this.focusedFieldIsPrivate()) {
      return {
        ok: false,
        reason: 'takeover',
        detail: 'The focused field contains private sign-in information.'
      }
    }
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      commands: ['selectAll']
    })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
    await this.send('Input.insertText', { text })
    return { ok: true }
  }

  /** Click-to-focus (when given an element), then insert. A null element types
   *  into whatever is already focused (a search box the agent just clicked).
   *  Identity fields refuse - that is the takeover boundary, enforced here so no
   *  prompt injection can talk the agent past it. */
  async type(el: PageElement | null, text: string): Promise<DriverResult> {
    if (el?.identity) {
      return {
        ok: false,
        reason: 'takeover',
        detail: `"${el.name || el.tag}" is a credential field - the user signs in directly in the watched pane`
      }
    }
    if (el) {
      await this.click(el)
    }
    return this.typeFocused(text)
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
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code: spec.code,
        windowsVirtualKeyCode: spec.keyCode,
        nativeVirtualKeyCode: spec.keyCode
      })
    }
    return { ok: true }
  }

  private async actuateShortcut(keys: readonly string[], chord: boolean): Promise<DriverResult> {
    const command = browserShortcutCommand(keys)
    if (command === 'back') return this.moveThroughHistory(-1)
    if (command === 'forward') return this.moveThroughHistory(1)
    if (command === 'reload' || command === 'hard_reload') {
      await this.reloadAndWait(command === 'hard_reload')
      await this.ensurePointer(true)
      return { ok: true }
    }
    if (command === 'blocked_chrome') {
      return {
        ok: false,
        reason: 'recoverable',
        detail:
          'That browser-chrome shortcut is not available in Web Use. Use Navigate, Alt+Left, Alt+Right, Ctrl+R, Ctrl+Shift+R, or visual page controls.'
      }
    }
    return this.dispatchKeys(keys, chord)
  }

  /** Execute the shared visual action space against this isolated browser page. */
  async actuate(action: VisionAction): Promise<DriverResult> {
    switch (action.type) {
      case 'click':
        return this.clickPoint(action.point.x, action.point.y, 'left', 1)
      case 'double_click':
        return this.clickPoint(action.point.x, action.point.y, 'left', 2)
      case 'triple_click':
        return this.clickPoint(action.point.x, action.point.y, 'left', 3)
      case 'right_click':
        return this.clickPoint(action.point.x, action.point.y, 'right', 1)
      case 'middle_click':
        return this.clickPoint(action.point.x, action.point.y, 'middle', 1)
      case 'mouse_move': {
        await this.movePointerTo(action.point.x, action.point.y)
        return { ok: true }
      }
      case 'drag':
      case 'drag_to': {
        const from = action.type === 'drag' ? action.from : this.pointer
        const to = action.to
        await this.movePointerTo(from.x, from.y)
        this.pointer = { phase: 'pressed', x: from.x, y: from.y }
        await this.showPointer(this.pointer)
        await this.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: from.x,
          y: from.y,
          button: 'left',
          clickCount: 1
        })
        this.onPointer?.(this.pointer)
        await this.movePointerTo(to.x, to.y, 'left')
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: to.x,
          y: to.y,
          button: 'left',
          clickCount: 1
        })
        this.pointer = { phase: 'released', x: to.x, y: to.y }
        await this.showPointer(this.pointer)
        this.onPointer?.(this.pointer)
        return { ok: true }
      }
      case 'type':
        return this.typeFocused(action.content)
      case 'scroll':
      case 'scroll_by': {
        const horizontal =
          action.type === 'scroll_by'
            ? action.axis === 'horizontal'
            : action.direction === 'left' || action.direction === 'right'
        const amount =
          action.type === 'scroll_by'
            ? horizontal
              ? action.amount
              : -action.amount
            : action.direction === 'up' || action.direction === 'left'
              ? -600
              : 600
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: this.pointer.x,
          y: this.pointer.y,
          deltaX: horizontal ? amount : 0,
          deltaY: horizontal ? 0 : amount
        })
        return { ok: true }
      }
      case 'navigate':
        return this.navigate(action.url)
      case 'hotkey': {
        const keys = browserHotkeyTokens(action.keys)
        return this.actuateShortcut(keys, true)
      }
      case 'press':
        return this.actuateShortcut(action.keys, false)
      case 'key_down':
        return this.dispatchKeyPhase(action.keys, 'rawKeyDown')
      case 'key_up':
        return this.dispatchKeyPhase([...action.keys].reverse(), 'keyUp')
      case 'wait':
      case 'call_user':
      case 'finished':
        return { ok: false, reason: 'error', detail: `control action ${action.type} is not input` }
      default:
        return { ok: false, reason: 'error', detail: 'unsupported browser action' }
    }
  }

  private async dispatchKeyPhase(
    keys: readonly string[],
    type: 'rawKeyDown' | 'keyUp',
    initialModifiers = 0
  ): Promise<DriverResult> {
    let modifiers = initialModifiers
    for (const rawKey of keys) {
      const key = rawKey.toLowerCase()
      const modifier =
        key === 'alt' || key === 'option'
          ? 1
          : key === 'ctrl' || key === 'control'
            ? 2
            : key === 'meta' || key === 'cmd' || key === 'command'
              ? 4
              : key === 'shift'
                ? 8
                : 0
      if (type === 'rawKeyDown') modifiers |= modifier
      const normalized =
        modifier === 1
          ? 'Alt'
          : modifier === 2
            ? 'Control'
            : modifier === 4
              ? 'Meta'
              : modifier === 8
                ? 'Shift'
                : rawKey.length === 1
                  ? rawKey
                  : rawKey[0]?.toUpperCase() + rawKey.slice(1)
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: normalized,
        ...(rawKey.length === 1 ? { code: `Key${rawKey.toUpperCase()}` } : {}),
        modifiers
      })
      if (type === 'keyUp') modifiers &= ~modifier
    }
    return { ok: true }
  }

  private async dispatchKeys(keys: readonly string[], chord: boolean): Promise<DriverResult> {
    if (!keys.length) return { ok: false, reason: 'error', detail: 'no keys supplied' }
    if (chord) {
      let modifiers = 0
      for (const key of keys) {
        const lower = key.toLowerCase()
        if (lower === 'alt' || lower === 'option') modifiers |= 1
        if (lower === 'ctrl' || lower === 'control') modifiers |= 2
        if (lower === 'meta' || lower === 'cmd' || lower === 'command') modifiers |= 4
        if (lower === 'shift') modifiers |= 8
      }
      await this.dispatchKeyPhase(keys, 'rawKeyDown')
      await this.dispatchKeyPhase([...keys].reverse(), 'keyUp', modifiers)
      return { ok: true }
    }
    for (const key of keys) {
      await this.dispatchKeyPhase([key], 'rawKeyDown')
      await this.dispatchKeyPhase([key], 'keyUp')
    }
    return { ok: true }
  }
}
