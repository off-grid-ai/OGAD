// Tabs in the user's default browser, reached through the paired extension's live socket
// (extension-bridge/bridge-socket.ts), presented as pages the Playwright relay can drive.
//
// The relay only needs a page's debugger, title, URL and lifecycle (RelayContents). Here those
// come from chrome.debugger in the user's real tab instead of an Electron WebContents, so the
// same Playwright loop runs in either place. The extension refuses chrome:// and other
// browser pages itself.

import type { BrowserLink } from '../extension-bridge/bridge-socket'
import type { SocketEvent } from '../extension-bridge/bridge-socket-protocol'
import type { CdpTransport } from './browser-driver'
import type {
  ElectronPlaywrightPageProvider,
  RelayContents,
  RelayDebugger,
  RelayPage
} from './electron-playwright-attachments'

type Listener = (...args: never[]) => void
type MessageListener = (...args: [unknown, string, unknown, string?]) => void

interface TabInfo {
  tabId: number
  url: string
  title: string
}

const isTabInfo = (v: unknown): v is TabInfo => {
  const t = v as Partial<TabInfo> | null
  return (
    typeof t === 'object' &&
    t !== null &&
    Number.isSafeInteger(t.tabId) &&
    typeof t.url === 'string' &&
    typeof t.title === 'string'
  )
}

const isExtensionId = (v: unknown): v is string => typeof v === 'string' && /^[a-p]{32}$/.test(v)

/** One browser tab as a relay page. */
export class ExtensionTabContents implements RelayContents {
  readonly debugger: RelayDebugger
  private destroyed = false
  private attachment: Promise<unknown> | null = null
  private readonly messageListeners = new Set<MessageListener>()
  private readonly detachListeners = new Set<() => void>()
  private readonly lifecycle = new Map<string, Set<() => void>>()
  private readonly stopEvents: () => void
  private readonly stopClose: () => void

  constructor(
    private readonly link: BrowserLink,
    private info: TabInfo
  ) {
    this.stopEvents = link.onEvent((event) => this.receive(event))
    this.stopClose = link.onClose(() => this.destroy())
    this.debugger = this.makeDebugger()
  }

  get tabId(): number {
    return this.info.tabId
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getTitle(): string {
    return this.info.title
  }

  getURL(): string {
    return this.info.url
  }

  once(event: string, listener: () => void): this {
    const set = this.lifecycle.get(event) ?? new Set()
    set.add(listener)
    this.lifecycle.set(event, set)
    return this
  }

  off(event: string, listener: () => void): this {
    this.lifecycle.get(event)?.delete(listener)
    return this
  }

  /** CDP for the visible fallback driver (BrowserDriver), on this tab's own session. */
  transport(): CdpTransport {
    return {
      send: <T>(method: string, params?: Record<string, unknown>) =>
        this.debugger.sendCommand(method, params) as Promise<T>,
      on: (listener) => {
        const wrapped: MessageListener = (_e, method, params, sessionId) => {
          if (!sessionId) listener(method, params)
        }
        this.messageListeners.add(wrapped)
        return () => this.messageListeners.delete(wrapped)
      }
    }
  }

  private makeDebugger(): RelayDebugger {
    const api: RelayDebugger = {
      isAttached: () => this.attachment !== null,
      attach: () => {
        this.attachment ??= this.link.request('cdp.attach', { tabId: this.tabId })
      },
      detach: () => {
        if (!this.attachment) return
        this.attachment = null
        void this.link.request('cdp.detach', { tabId: this.tabId }).catch(() => undefined)
        this.fireDetach()
      },
      sendCommand: async (method: string, params?: unknown, sessionId?: string) => {
        if (!this.attachment) throw new Error('The browser tab debugger is not attached.')
        await this.attachment
        return this.link.request('cdp.send', {
          tabId: this.tabId,
          method,
          params: params ?? {},
          ...(sessionId ? { sessionId } : {})
        })
      },
      on: (_event: 'message', listener: MessageListener) => {
        this.messageListeners.add(listener)
        return api
      },
      once: (_event: 'detach', listener: () => void) => {
        this.detachListeners.add(listener)
        return api
      },
      off: (event: 'message' | 'detach', listener: Listener) => {
        if (event === 'message') this.messageListeners.delete(listener as MessageListener)
        else this.detachListeners.delete(listener as () => void)
        return api
      }
    }
    return api
  }

  private receive(event: SocketEvent): void {
    if (event.tabId !== this.tabId) return
    const d = event.data
    if (event.event === 'cdp.event' && typeof d.method === 'string') {
      const sessionId = typeof d.sessionId === 'string' ? d.sessionId : undefined
      for (const l of [...this.messageListeners]) l(undefined, d.method, d.params, sessionId)
    } else if (event.event === 'tab.updated') {
      this.info = {
        ...this.info,
        ...(typeof d.url === 'string' ? { url: d.url } : {}),
        ...(typeof d.title === 'string' ? { title: d.title } : {})
      }
    } else if (event.event === 'cdp.detached') {
      // Chrome's own reason: target_closed when another extension's frame blocks it,
      // canceled_by_user when the user pressed Cancel on the debugging bar.
      console.warn('[web-use][debugger] Chrome detached the debugger', {
        tabId: this.tabId,
        reason: typeof d.reason === 'string' ? d.reason : 'unknown',
        // Other extensions with a frame in the tab: what Chrome drops the debugger for.
        extensions: Array.isArray(d.extensions) ? d.extensions.filter(isExtensionId) : []
      })
      this.attachment = null
      this.fireDetach()
    } else if (event.event === 'tab.removed') {
      this.destroy()
    }
  }

  private fireDetach(): void {
    const listeners = [...this.detachListeners]
    this.detachListeners.clear()
    for (const l of listeners) l()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.attachment = null
    this.stopEvents()
    this.stopClose()
    this.messageListeners.clear()
    this.fireDetach()
    const listeners = [...(this.lifecycle.get('destroyed') ?? [])]
    this.lifecycle.clear()
    for (const l of listeners) l()
  }
}

/**
 * The tabs one task owns in the user's browser. It starts with the tab it opens, or the tab the
 * browser offered for it (browser-start-tab.ts), and grows with tabs opened by the page or
 * through Playwright. It never sees the user's other tabs.
 */
export function createExtensionPageProvider(
  link: BrowserLink,
  onFollow?: () => void
): ElectronPlaywrightPageProvider & {
  open(url: string): Promise<ExtensionTabContents>
  /** Start in the offered tab instead of a new one, at `url` when the task names one. */
  /** `taskId`: the task the browser offered this tab to; only that task's offer lets it in. */
  adopt(tabId: number, taskId: string, url?: string): Promise<ExtensionTabContents>
  active(): ExtensionTabContents | undefined
  closeAll(): Promise<void>
} {
  const pages = new Map<number, ExtensionTabContents>()
  const track = (info: unknown, refusal: string): ExtensionTabContents => {
    if (!isTabInfo(info)) throw new Error(refusal)
    const contents = new ExtensionTabContents(link, info)
    pages.set(info.tabId, contents)
    contents.once('destroyed', () => pages.delete(info.tabId))
    return contents
  }
  const open = async (url: string): Promise<ExtensionTabContents> =>
    track(await link.request('tab.create', { url }), 'The browser did not open a tab.')
  const adopt = async (
    tabId: number,
    taskId: string,
    url?: string
  ): Promise<ExtensionTabContents> =>
    track(
      await link.request('tab.adopt', { tabId, taskId, ...(url === undefined ? {} : { url }) }),
      'The browser did not hand over its tab.'
    )
  const stopOpened = link.onEvent((event) => {
    if (
      event.event !== 'tab.opened' ||
      !pages.has(event.data.openerTabId as number) ||
      pages.has(event.tabId)
    )
      return
    track(event.data, 'The browser did not open a task tab.')
    onFollow?.()
  })
  const asPage = (contents: ExtensionTabContents): RelayPage => ({ id: contents.tabId, contents })
  return {
    pages: () => [...pages.values()].filter((p) => !p.isDestroyed()).map(asPage),
    create: async (url) => asPage(await open(url)),
    close: async (id) => {
      const page = pages.get(id)
      if (!page) return
      await link.request('cdp.detach', { tabId: id })
      await link.request('tab.close', { tabId: id })
      page.destroy()
    },
    open,
    adopt,
    active: () => [...pages.values()].filter((p) => !p.isDestroyed()).at(-1),
    async closeAll() {
      stopOpened()
      for (const p of [...pages.values()]) {
        await link.request('cdp.detach', { tabId: p.tabId }).catch(() => undefined)
        p.destroy()
      }
      pages.clear()
    }
  }
}
