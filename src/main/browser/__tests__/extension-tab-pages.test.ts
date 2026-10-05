import { describe, expect, it } from 'vitest'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { SocketEvent, SocketOp } from '../../extension-bridge/bridge-socket-protocol'
import { ElectronPlaywrightAttachments } from '../electron-playwright-attachments'
import type { CdpEvent } from '../electron-playwright-relay-protocol'
import { createExtensionPageProvider } from '../extension-tab-pages'

// The relay's real attachment code driving browser tabs through a stand-in for the paired
// extension's link. The link records what the desktop asked the browser to do and lets the
// test play the browser's events back.

interface FakeLink extends BrowserLink {
  calls: Array<{ op: SocketOp; args: Record<string, unknown> }>
  emit(event: SocketEvent): void
  drop(): void
}

function fakeLink(): FakeLink {
  const events = new Set<(e: SocketEvent) => void>()
  const closes = new Set<() => void>()
  let nextTab = 40
  const link: FakeLink = {
    browser: { id: 'device000001', name: 'Brave extension', publicKey: 'k', pairedAt: 1 },
    calls: [],
    async request(op, args = {}) {
      link.calls.push({ op, args })
      if (op === 'tab.create') {
        return { tabId: ++nextTab, url: String(args.url), title: '' }
      }
      if (op === 'tab.adopt') {
        return {
          tabId: Number(args.tabId),
          url: String(args.url ?? 'https://mine.test/'),
          title: ''
        }
      }
      if (op === 'cdp.send' && args.method === 'Target.getTargetInfo') {
        return { targetInfo: { targetId: `T${String(args.tabId)}` } }
      }
      return {}
    },
    onEvent(l) {
      events.add(l)
      return () => events.delete(l)
    },
    onClose(l) {
      closes.add(l)
      return () => closes.delete(l)
    },
    close() {
      link.drop()
    },
    emit(e) {
      for (const l of [...events]) l(e)
    },
    drop() {
      for (const l of [...closes]) l()
    }
  }
  return link
}

describe("the user's own tab", () => {
  it('takes the tab the browser offered, where it is, and never closes it', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const tab = await provider.adopt(7)
    expect(tab.tabId).toBe(7)
    expect(link.calls[0]).toEqual({ op: 'tab.adopt', args: { tabId: 7 } })
    expect(provider.active()).toBe(tab)
    await provider.close(7)
    expect(link.calls.map((c) => c.op)).toEqual(['tab.adopt'])
  })

  it('takes it at the page the task names, and still closes a tab of its own', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    await provider.adopt(7, 'https://x.com/')
    expect(link.calls[0]?.args).toEqual({ tabId: 7, url: 'https://x.com/' })
    const own = await provider.open('https://popup.test/')
    await provider.close(own.tabId)
    expect(link.calls.at(-1)).toEqual({ op: 'tab.close', args: { tabId: own.tabId } })
  })
})

describe('extension tab pages under the Playwright relay', () => {
  it('opens a tab, attaches its debugger, and names it to Playwright', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const published: CdpEvent[] = []
    const attachments = new ElectronPlaywrightAttachments(
      provider,
      async (e) => void published.push(e),
      () => undefined
    )
    const tab = await provider.open('https://shop.example.test/')
    await attachments.sync()

    expect(link.calls.map((c) => c.op)).toEqual(['tab.create', 'cdp.attach', 'cdp.send'])
    expect(link.calls[2]?.args).toMatchObject({ tabId: tab.tabId, method: 'Target.getTargetInfo' })
    expect(published[0]).toMatchObject({
      method: 'Target.attachedToTarget',
      params: { targetInfo: { targetId: `T${tab.tabId}`, url: 'https://shop.example.test/' } }
    })
  })

  it("forwards only this tab's CDP events, on Playwright's page session", async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const published: CdpEvent[] = []
    const attachments = new ElectronPlaywrightAttachments(
      provider,
      async (e) => void published.push(e),
      () => undefined
    )
    const tab = await provider.open('https://a.test/')
    await attachments.sync()
    published.length = 0
    link.emit({
      event: 'cdp.event',
      tabId: tab.tabId,
      data: { method: 'Page.loadEventFired', params: {} }
    })
    link.emit({
      event: 'cdp.event',
      tabId: 999,
      data: { method: 'Page.loadEventFired', params: {} }
    })
    expect(published).toEqual([
      { sessionId: `offgrid-page-${tab.tabId}`, method: 'Page.loadEventFired', params: {} }
    ])
  })

  it('follows title and URL, and forgets a tab the user closes', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const tab = await provider.open('https://a.test/')
    link.emit({
      event: 'tab.updated',
      tabId: tab.tabId,
      data: { url: 'https://a.test/cart', title: 'Cart' }
    })
    expect([tab.getURL(), tab.getTitle()]).toEqual(['https://a.test/cart', 'Cart'])
    link.emit({ event: 'tab.removed', tabId: tab.tabId, data: {} })
    expect(tab.isDestroyed()).toBe(true)
    expect(provider.pages()).toEqual([])
  })

  it('reports a detach when the browser drops the debugger or the link goes', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const tab = await provider.open('https://a.test/')
    tab.debugger.attach()
    let detached = 0
    tab.debugger.once('detach', () => detached++)
    link.emit({ event: 'cdp.detached', tabId: tab.tabId, data: { reason: 'canceled_by_user' } })
    expect(detached).toBe(1)
    expect(tab.debugger.isAttached()).toBe(false)
    await expect(tab.debugger.sendCommand('Page.reload')).rejects.toThrow(/not attached/)

    let destroyed = false
    tab.once('destroyed', () => (destroyed = true))
    link.drop()
    expect(destroyed).toBe(true)
  })

  it('gives the fallback driver a CDP transport on the tab session', async () => {
    const link = fakeLink()
    const tab = await createExtensionPageProvider(link).open('https://a.test/')
    tab.debugger.attach()
    const seen: string[] = []
    const stop = tab.transport().on((method) => seen.push(method))
    await tab.transport().send('Page.captureScreenshot', { format: 'png' })
    expect(link.calls.at(-1)?.args).toEqual({
      tabId: tab.tabId,
      method: 'Page.captureScreenshot',
      params: { format: 'png' }
    })
    link.emit({
      event: 'cdp.event',
      tabId: tab.tabId,
      data: { method: 'Page.frameNavigated', params: {} }
    })
    link.emit({
      event: 'cdp.event',
      tabId: tab.tabId,
      data: { method: 'Network.x', sessionId: 'child', params: {} }
    })
    stop()
    link.emit({
      event: 'cdp.event',
      tabId: tab.tabId,
      data: { method: 'Page.loadEventFired', params: {} }
    })
    expect(seen).toEqual(['Page.frameNavigated'])
  })
})
