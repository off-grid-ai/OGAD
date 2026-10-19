import { WebSocket } from 'ws'
import { ElectronPlaywrightRelay } from '../electron-playwright-relay'
import { runBounded } from '../playwright-boundary-wait'
import { describe, expect, it } from 'vitest'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { SocketEvent, SocketOp } from '../../extension-bridge/bridge-socket-protocol'
import { ElectronPlaywrightAttachments } from '../electron-playwright-attachments'
import type { CdpEvent } from '../electron-playwright-relay-protocol'
import { createExtensionPageProvider, taskTabLabel } from '../extension-tab-pages'

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
        // The extension hands over only the tab it offered (its start-tab.ts fence).
        if (args.tabId !== 7) throw new Error('That tab was not offered for this task.')
        return { tabId: 7, url: String(args.url ?? 'https://chat.example.test/'), title: 'Chat' }
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

describe('extension tab pages under the Playwright relay', () => {
  it('follows only tracked openers and falls back when the child closes', async () => {
    const link = fakeLink()
    const followed: string[] = []
    const provider = createExtensionPageProvider(link, () => followed.push('followed'))
    const opener = await provider.adopt(7, 'task-1')
    link.emit({
      event: 'tab.opened',
      tabId: 90,
      data: { tabId: 90, openerTabId: 999, url: 'https://other.test/', title: '' }
    })
    expect(provider.active()).toBe(opener)
    expect(provider.pages()).toHaveLength(1)
    expect(followed).toEqual([])
    const opened: SocketEvent = {
      event: 'tab.opened',
      tabId: 91,
      data: { tabId: 91, openerTabId: 7, url: 'https://apply.test/', title: 'Apply' }
    }
    link.emit(opened)
    link.emit(opened)
    expect(provider.active()?.tabId).toBe(91)
    expect(provider.active()?.getURL()).toBe('https://apply.test/')
    expect(provider.pages()).toHaveLength(2)
    expect(followed).toEqual(['followed'])
    link.emit({ event: 'tab.removed', tabId: 91, data: {} })
    expect(provider.active()).toBe(opener)
    await provider.closeAll()
    link.emit(opened)
    expect(provider.pages()).toEqual([])
    expect(followed).toEqual(['followed'])
  })

  it('announces a child target over the real relay and forwards commands to it', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const opener = await provider.adopt(7, 'task-1')
    const relay = new ElectronPlaywrightRelay(provider)
    let socket: WebSocket | undefined
    try {
      socket = new WebSocket(await relay.start())
      const client = socket
      await new Promise<void>((resolve, reject) => {
        client.once('open', resolve)
        client.once('error', reject)
      })
      const messages: Array<{ id?: number; method?: string; params?: unknown; error?: unknown }> =
        []
      client.on('message', (data) => messages.push(JSON.parse(data.toString())))
      const command = async (id: number, method: string, sessionId?: string): Promise<void> => {
        client.send(JSON.stringify({ id, method, params: {}, sessionId }))
        await runBounded({
          label: 'Test relay reply',
          timeoutMs: 1000,
          run: async (signal) => {
            while (!messages.some((m) => m.id === id)) {
              signal.throwIfAborted()
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          }
        })
        expect(messages.find((m) => m.id === id)?.error).toBeUndefined()
      }
      await command(1, 'Target.setAutoAttach')
      link.emit({
        event: 'tab.opened',
        tabId: 91,
        data: { tabId: 91, openerTabId: opener.tabId, url: 'https://apply.test/', title: 'Apply' }
      })
      await relay.syncPages()
      await command(2, 'Target.getTargets')
      expect(messages).toContainEqual(
        expect.objectContaining({
          method: 'Target.attachedToTarget',
          params: expect.objectContaining({
            sessionId: 'offgrid-page-91',
            targetInfo: expect.objectContaining({ targetId: 'T91', url: 'https://apply.test/' })
          })
        })
      )
      expect(link.calls).toContainEqual({ op: 'cdp.attach', args: { tabId: 91 } })
      expect(relay.pageIndex(91)).toBe(1)
      await command(3, 'Runtime.evaluate', 'offgrid-page-91')
      expect(link.calls.at(-1)?.args).toMatchObject({ tabId: 91, method: 'Runtime.evaluate' })
      link.emit({ event: 'tab.removed', tabId: 91, data: {} })
      await command(4, 'Target.getTargets')
      expect(messages).toContainEqual(
        expect.objectContaining({
          method: 'Target.detachedFromTarget',
          params: { sessionId: 'offgrid-page-91', targetId: 'T91' }
        })
      )
      expect(relay.pageIndex(7)).toBe(0)
    } finally {
      socket?.terminate()
      await relay.stop()
      await provider.closeAll()
    }
  })

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

  it('starts in the tab the browser offered, without opening a new one', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const tab = await provider.adopt(7, 'task-1')

    // The task id names whose offer this is, so a task queued for minutes still gets its tab.
    expect(link.calls).toEqual([{ op: 'tab.adopt', args: { tabId: 7, taskId: 'task-1' } }])
    expect([tab.tabId, tab.getURL()]).toEqual([7, 'https://chat.example.test/'])
    expect(provider.active()).toBe(tab)

    // A task that names a page takes the tab there; a tab never offered is refused.
    await provider.adopt(7, 'task-1', 'https://shop.example.test/')
    expect(link.calls.at(-1)).toEqual({
      op: 'tab.adopt',
      args: { tabId: 7, taskId: 'task-1', url: 'https://shop.example.test/' }
    })
    await expect(provider.adopt(8, 'task-1')).rejects.toThrow(/not offered/)
    expect(link.calls.some((c) => c.op === 'tab.create')).toBe(false)
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
  it('stops task events after completion while preserving the user browser tab', async () => {
    const link = fakeLink()
    const provider = createExtensionPageProvider(link)
    const tab = await provider.open('https://a.test/')
    tab.debugger.attach()
    const received: string[] = []
    tab.transport().on((method) => received.push(method))
    await provider.closeAll()
    link.emit({ event: 'tab.updated', tabId: tab.tabId, data: { title: 'Later title' } })
    link.emit({
      event: 'cdp.event',
      tabId: tab.tabId,
      data: { method: 'Page.loadEventFired', params: {} }
    })
    expect(received).toEqual([])
    expect(tab.getTitle()).toBe('')
    expect(provider.pages()).toEqual([])
    await expect(tab.transport().send('Page.reload')).rejects.toThrow(/not attached/)
    // A following task has its own active session.
    const next = await provider.open('https://b.test/')
    link.emit({ event: 'tab.updated', tabId: next.tabId, data: { title: 'Next task' } })
    expect(provider.active()?.getTitle()).toBe('Next task')
    await provider.closeAll()
  })
})

describe('taskTabLabel', () => {
  it('names the task in a few words for its tab group', () => {
    expect(
      taskTabLabel(
        "Use Web Use: open en.wikipedia.org and tell me the title of today's featured article. Do not log in."
      )
    ).toBe('Open en.wikipedia.org and tell…')
    expect(taskTabLabel('Compare salt prices.')).toBe('Compare salt prices')
  })
})
