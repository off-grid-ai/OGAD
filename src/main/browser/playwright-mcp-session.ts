import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { ElectronPlaywrightRelay } from './electron-playwright-relay'
import { runBounded } from './playwright-boundary-wait'

const CORE_CAPABILITIES = ['core', 'core-navigation', 'core-tabs', 'core-input'] as const
const ALLOWED_TOOLS = new Set([
  'browser_snapshot',
  'browser_tabs',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_hover',
  'browser_drag',
  'browser_navigate'
])
const CONNECT_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 15_000
const NAVIGATION_TIMEOUT_MS = 50_000
const CLOSE_TIMEOUT_MS = 5_000

export interface PlaywrightToolResult {
  text: string
  isError: boolean
}

/** One in-process Playwright MCP client for one target-scoped Web Use relay. */
export class PlaywrightMcpSession {
  private readonly client = new Client({ name: 'Off Grid AI Web Use', version: '1' })
  private server: Awaited<ReturnType<typeof createConnection>> | null = null
  private connected = false
  private closed = false

  constructor(private readonly relay: ElectronPlaywrightRelay) {}

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.closed) throw new Error('Playwright MCP session is closed.')
    try {
      const endpoint = await runBounded({
        label: 'Playwright relay start',
        timeoutMs: CONNECT_TIMEOUT_MS,
        run: () => this.relay.start()
      })
      const server = await runBounded({
        label: 'Playwright MCP creation',
        timeoutMs: CONNECT_TIMEOUT_MS,
        run: () =>
          createConnection({
            browser: { browserName: 'chromium', cdpEndpoint: endpoint },
            capabilities: [...CORE_CAPABILITIES],
            imageResponses: 'omit',
            snapshot: { mode: 'full', boxes: true },
            timeouts: { action: 7_500, navigation: 45_000, settle: 350 }
          })
      })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      this.server = server
      await runBounded({
        label: 'Playwright MCP connect',
        timeoutMs: CONNECT_TIMEOUT_MS,
        run: () =>
          Promise.all([server.connect(serverTransport), this.client.connect(clientTransport)])
      })
      this.connected = true
    } catch (error) {
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async snapshot(signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return this.call('browser_snapshot', { boxes: true }, signal)
  }

  /** Reopen a crashed page inside the same journey-scoped context. */
  async recoverPage(url: string | undefined, signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return this.call('browser_tabs', { action: 'new', ...(url ? { url } : {}) }, signal)
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PlaywrightToolResult> {
    if (!this.connected) throw new Error('Playwright MCP is not connected.')
    if (!ALLOWED_TOOLS.has(name)) throw new Error(`Playwright MCP tool ${name} is not allowed.`)
    signal?.throwIfAborted()
    const timeout = name === 'browser_navigate' ? NAVIGATION_TIMEOUT_MS : ACTION_TIMEOUT_MS
    return runBounded({
      label: `Playwright MCP ${name}`,
      timeoutMs: timeout,
      signal,
      run: async (boundedSignal) => {
        await this.relay.syncPages()
        const result = await this.client.callTool({ name, arguments: args }, undefined, {
          signal: boundedSignal
        })
        return normalizeToolResult(result)
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.connected = false
    const errors: Error[] = []
    await closeBoundary('Playwright MCP client close', () => this.client.close(), errors)
    const server = this.server
    this.server = null
    if (server) await closeBoundary('Playwright MCP server close', () => server.close(), errors)
    await closeBoundary('Playwright relay stop', () => this.relay.stop(), errors)
    if (errors.length) throw errors[0]
  }
}

function normalizeToolResult(result: unknown): PlaywrightToolResult {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return { text: 'Playwright MCP returned a malformed result.', isError: true }
  }
  const value = result as { content?: unknown; isError?: unknown }
  if (!Array.isArray(value.content)) {
    return { text: 'Playwright MCP returned malformed content.', isError: true }
  }
  const text: string[] = []
  for (const item of value.content) {
    if (typeof item !== 'object' || item === null) {
      return { text: 'Playwright MCP returned a malformed content block.', isError: true }
    }
    const block = item as { type?: unknown; text?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
  }
  return { text: text.join('\n'), isError: value.isError === true }
}

async function closeBoundary(
  label: string,
  close: () => Promise<unknown>,
  errors: Error[]
): Promise<void> {
  try {
    await runBounded({ label, timeoutMs: CLOSE_TIMEOUT_MS, run: close })
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)))
  }
}
