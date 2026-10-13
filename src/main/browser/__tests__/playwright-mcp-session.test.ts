import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { SocketEvent } from '../../extension-bridge/bridge-socket-protocol'
import { ElectronPlaywrightAttachments } from '../electron-playwright-attachments'
import type { ElectronPlaywrightRelay } from '../electron-playwright-relay'
import { createExtensionPageProvider } from '../extension-tab-pages'
import { PlaywrightMcpSession } from '../playwright-mcp-session'

// Only the browser backend is replaced. MCP client/server transport, tab provider,
// and debugger attachments are real collaborators, without a TCP listen or a display.
const browser = vi.hoisted(() => ({
  tabs: [] as number[],
  current: 0,
  unavailableOnce: false,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  initialize: async (): Promise<void> => undefined
}))

vi.mock('@playwright/mcp', () => ({
  createConnection: async () => {
    const server = new Server(
      { name: 'Test browser backend', version: '1' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {}
      const name = request.params.name
      browser.calls.push({ name, args })
      await browser.initialize()
      if (name === 'browser_tabs' && args.action === 'select') {
        const index = Number(args.index)
        if (!browser.tabs[index] || browser.unavailableOnce) {
          browser.unavailableOnce = false
          return { isError: true, content: [{ type: 'text', text: `Tab ${index} not found` }] }
        }
        browser.current = index
      }
      return { content: [{ type: 'text', text: `Current tab: ${browser.tabs[browser.current]}` }] }
    })
    return server
  }
}))

beforeEach(() => {
  browser.tabs = []
  browser.current = 0
  browser.unavailableOnce = false
  browser.calls = []
})

describe('Playwright MCP extension tab selection', () => {
  it('initializes lazy CDP, selects the child for the next snapshot, and returns to the opener', async () => {
    const events = new Set<(event: SocketEvent) => void>()
    const link: BrowserLink = {
      browser: { id: 'device000001', name: 'Chromium extension', publicKey: 'k', pairedAt: 1 },
      async request(op, args = {}) {
        if (op === 'tab.adopt') return { tabId: 7, url: 'https://jobs.test/', title: 'Jobs' }
        if (op === 'cdp.send') return { targetInfo: { targetId: `T${args.tabId}` } }
        return {}
      },
      onEvent(listener) {
        events.add(listener)
        return () => events.delete(listener)
      },
      onClose: () => () => undefined,
      close: () => undefined
    }
    const pages = createExtensionPageProvider(link)
    await pages.adopt(7, 'task-1')
    const attachments = new ElectronPlaywrightAttachments(
      pages,
      async (event) => {
        const params = event.params as { sessionId: string }
        const id = Number(params.sessionId.replace('offgrid-page-', ''))
        if (event.method === 'Target.attachedToTarget') browser.tabs.push(id)
        if (event.method === 'Target.detachedFromTarget')
          browser.tabs = browser.tabs.filter((tab) => tab !== id)
      },
      (error) => {
        throw error
      }
    )
    let autoAttach = false
    browser.initialize = async () => {
      autoAttach = true
      await attachments.sync()
    }
    const relay = {
      start: async () => 'ws://test-browser-backend',
      syncPages: async () => {
        if (autoAttach) await attachments.sync()
      },
      pageIndex: (id: number) => attachments.pageIndex(id),
      stop: async () => attachments.clear()
    } as unknown as ElectronPlaywrightRelay
    const session = new PlaywrightMcpSession(relay, () => pages.active()!.tabId)
    try {
      await session.connect()
      expect((await session.snapshot()).text).toBe('Current tab: 7')
      expect(browser.calls[0]).toEqual({ name: 'browser_tabs', args: { action: 'list' } })
      for (const listener of [...events])
        listener({
          event: 'tab.opened',
          tabId: 8,
          data: { tabId: 8, openerTabId: 7, url: 'https://jobs.test/apply', title: 'Apply' }
        })
      browser.unavailableOnce = true
      expect((await session.snapshot()).text).toBe('Current tab: 8')
      expect(browser.calls.slice(-3)).toEqual([
        { name: 'browser_tabs', args: { action: 'select', index: 1 } },
        { name: 'browser_tabs', args: { action: 'select', index: 1 } },
        { name: 'browser_snapshot', args: { boxes: false } }
      ])
      for (const listener of [...events]) listener({ event: 'tab.removed', tabId: 8, data: {} })
      expect((await session.snapshot()).text).toBe('Current tab: 7')
      expect(browser.calls.at(-2)).toEqual({
        name: 'browser_tabs',
        args: { action: 'select', index: 0 }
      })
    } finally {
      await session.close()
      await pages.closeAll()
    }
  })
})
