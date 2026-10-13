// The semantic loop's page session for a browser without a debugger protocol (Firefox).
//
// Playwright MCP needs a CDP endpoint, which a Firefox extension cannot give. So the loop's
// Playwright tools go to the extension instead (`page.call`), which answers them inside the
// task tab in Playwright's own shape: the same snapshot format with [ref=eN] refs, the same
// tool names and arguments. The loop, guard and evidence checks run unchanged.

import type { BrowserLink } from '../extension-bridge/bridge-socket'
import {
  isUncertainPageResult,
  type PageToolResult
} from '../extension-bridge/bridge-socket-protocol'
import type { PlaywrightToolResult, SemanticPageSession } from './playwright-mcp-session'

const CALL_TIMEOUT_MS = 60_000

function asResult(raw: unknown): PlaywrightToolResult {
  const r = raw as Partial<PageToolResult> | null
  if (typeof r?.text !== 'string' || typeof r.isError !== 'boolean') {
    return { text: 'The browser sent an unreadable answer.', isError: true }
  }
  return isUncertainPageResult(r as PageToolResult)
    ? { text: r.text, isError: false, uncertain: true }
    : { text: r.text, isError: r.isError }
}

export class ExtensionSnapshotSession implements SemanticPageSession {
  constructor(
    private readonly link: BrowserLink,
    private readonly tabId: () => number
  ) {}

  snapshot(signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return this.call('browser_snapshot', {}, signal)
  }

  /** A page in the user's browser does not crash out from under the task the way an
   *  embedded renderer can; reload the task tab at the URL instead. */
  recoverPage(url: string | undefined, signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return url ? this.call('browser_navigate', { url }, signal) : this.snapshot(signal)
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PlaywrightToolResult> {
    signal?.throwIfAborted()
    try {
      const raw = await this.link.request(
        'page.call',
        { tabId: this.tabId(), tool: name, args },
        CALL_TIMEOUT_MS
      )
      return asResult(raw)
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
  }
}
