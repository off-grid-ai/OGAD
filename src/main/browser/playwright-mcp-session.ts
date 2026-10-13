import { setTimeout as delay } from 'node:timers/promises'
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
  'browser_navigate',
  // Only for the click fallback (browser-playwright-actions.ts); the model never names it.
  'browser_evaluate'
])
const CONNECT_TIMEOUT_MS = 20_000
/** How long Playwright waits for an element to be visible, enabled and stable. */
const ACTION_WAIT_MS = 10_000
const ACTION_TIMEOUT_MS = 60_000
const SNAPSHOT_TIMEOUT_MS = 60_000
const PAGE_SYNC_TIMEOUT_MS = 5_000
const NAVIGATION_TIMEOUT_MS = 50_000
const CLOSE_TIMEOUT_MS = 5_000

export interface PlaywrightToolResult {
  text: string
  isError: boolean
  uncertain?: true
}

/**
 * What the semantic loop needs from a page session: Playwright MCP's tools. The in-app browser
 * and Chromium extension tabs answer them through Playwright itself (PlaywrightMcpSession); a
 * browser without a debugger protocol (Firefox) answers them in the page
 * (extension-snapshot-session.ts).
 */
export interface SemanticPageSession {
  snapshot(signal?: AbortSignal): Promise<PlaywrightToolResult>
  recoverPage(url: string | undefined, signal?: AbortSignal): Promise<PlaywrightToolResult>
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PlaywrightToolResult>
}

/** One in-process Playwright MCP client for one target-scoped Web Use relay. */
export class PlaywrightMcpSession implements SemanticPageSession {
  private readonly client = new Client({ name: 'Off Grid AI Web Use', version: '1' })
  private server: Awaited<ReturnType<typeof createConnection>> | null = null
  private connected = false
  private closed = false
  private callSequence = 0
  private activePageInitialized = false

  constructor(
    private readonly relay: ElectronPlaywrightRelay,
    private readonly activePageId?: () => number
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return
    if (this.closed) throw new Error('Playwright MCP session is closed.')
    const startedAt = Date.now()
    console.log('[web-use][playwright-mcp] connect started')
    try {
      const relayStartedAt = Date.now()
      const endpoint = await runBounded({
        label: 'Playwright relay start',
        timeoutMs: CONNECT_TIMEOUT_MS,
        run: () => this.relay.start()
      })
      console.log('[web-use][playwright-mcp] relay ready', {
        durationMs: Date.now() - relayStartedAt
      })
      const creationStartedAt = Date.now()
      const server = await runBounded({
        label: 'Playwright MCP creation',
        timeoutMs: CONNECT_TIMEOUT_MS,
        run: () =>
          createConnection({
            browser: { browserName: 'chromium', cdpEndpoint: endpoint },
            capabilities: [...CORE_CAPABILITIES],
            imageResponses: 'omit',
            // The semantic loop takes one explicit snapshot after every action.
            // Disable MCP's second automatic full-page snapshot in the action response.
            snapshot: { mode: 'none', boxes: false },
            // Short: a click that cannot prove the element stable falls back to an in-page click
            // (browser-playwright-actions.ts) instead of waiting 45s per try.
            timeouts: { action: ACTION_WAIT_MS, navigation: 45_000, settle: 350 }
          })
      })
      console.log('[web-use][playwright-mcp] connection created', {
        durationMs: Date.now() - creationStartedAt
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
      console.log('[web-use][playwright-mcp] connected', {
        durationMs: Date.now() - startedAt
      })
    } catch (error) {
      console.warn('[web-use][playwright-mcp] connect failed', {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      })
      await this.close().catch(() => undefined)
      throw error
    }
  }

  async snapshot(signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return this.call('browser_snapshot', { boxes: false }, signal)
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
    const timeout =
      name === 'browser_navigate'
        ? NAVIGATION_TIMEOUT_MS
        : name === 'browser_snapshot'
          ? SNAPSHOT_TIMEOUT_MS
          : ACTION_TIMEOUT_MS
    const callId = ++this.callSequence
    const startedAt = Date.now()
    console.log('[web-use][playwright-mcp] tool started', { callId, name, timeoutMs: timeout })
    try {
      const syncStartedAt = Date.now()
      await runBounded({
        label: 'Playwright relay page sync',
        timeoutMs: PAGE_SYNC_TIMEOUT_MS,
        signal,
        run: () => this.relay.syncPages()
      })
      console.log('[web-use][playwright-mcp] page sync complete', {
        callId,
        name,
        durationMs: Date.now() - syncStartedAt
      })
      if (this.activePageId) await this.selectActivePage(signal)
      const toolStartedAt = Date.now()
      const normalized = await runBounded({
        label: `Playwright MCP ${name}`,
        timeoutMs: timeout,
        signal,
        run: async (boundedSignal) => {
          const result = await this.client.callTool({ name, arguments: args }, undefined, {
            signal: boundedSignal,
            // Let the named Off Grid boundary report first. The SDK otherwise
            // replaces it with the generic MCP -32001 timeout at 60 seconds.
            timeout: timeout + 5_000
          })
          return normalizeToolResult(result)
        }
      })
      console.log('[web-use][playwright-mcp] tool complete', {
        callId,
        name,
        toolDurationMs: Date.now() - toolStartedAt,
        totalDurationMs: Date.now() - startedAt,
        isError: normalized.isError,
        errorText: normalized.isError ? normalized.text : undefined,
        ...toolResultDiagnostics(normalized.text)
      })
      return normalized
    } catch (error) {
      console.warn('[web-use][playwright-mcp] tool failed', {
        callId,
        name,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  private async selectActivePage(signal?: AbortSignal): Promise<void> {
    if (!this.activePageInitialized) {
      // MCP opens its CDP connection lazily on the first tool call.
      const result = await runBounded({
        label: 'Playwright MCP tab initialization',
        timeoutMs: CONNECT_TIMEOUT_MS,
        signal,
        run: async (boundedSignal) =>
          normalizeToolResult(
            await this.client.callTool(
              {
                name: 'browser_tabs',
                arguments: { action: 'list' }
              },
              undefined,
              { signal: boundedSignal, timeout: CONNECT_TIMEOUT_MS + 5_000 }
            )
          )
      })
      if (result.isError) throw new Error(result.text)
      this.activePageInitialized = true
      await runBounded({
        label: 'Playwright relay initial page sync',
        timeoutMs: PAGE_SYNC_TIMEOUT_MS,
        signal,
        run: () => this.relay.syncPages()
      })
    }
    await runBounded({
      label: 'Playwright MCP active tab selection',
      timeoutMs: PAGE_SYNC_TIMEOUT_MS,
      signal,
      run: async (boundedSignal) => {
        // A target announcement precedes Playwright's asynchronous page initialization.
        // MCP retains the old current tab when a page opens, so select the provider's tab.
        for (;;) {
          boundedSignal.throwIfAborted()
          const index = this.relay.pageIndex(this.activePageId!())
          if (index < 0) throw new Error('The active browser tab is not attached.')
          const result = normalizeToolResult(
            await this.client.callTool(
              {
                name: 'browser_tabs',
                arguments: { action: 'select', index }
              },
              undefined,
              { signal: boundedSignal, timeout: PAGE_SYNC_TIMEOUT_MS + 5_000 }
            )
          )
          if (!result.isError) return
          if (!result.text.includes(`Tab ${index} not found`)) throw new Error(result.text)
          await delay(50, undefined, { signal: boundedSignal })
        }
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

function toolResultDiagnostics(text: string): {
  textLength: number
  lineCount: number
  referenceCount: number
} {
  return {
    textLength: text.length,
    lineCount: text.length ? text.split('\n').length : 0,
    referenceCount: text.match(/\[ref=[^\]]+\]/g)?.length ?? 0
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
