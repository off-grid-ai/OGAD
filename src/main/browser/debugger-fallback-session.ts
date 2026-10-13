// A task tab in Chromium, driven over Chrome's debugger when Chrome allows it and from inside
// the page (the extension's page.call) when it does not.
//
// Chrome drops an extension's debugger the moment another extension puts a frame in the tab
// (password managers and writing assistants do, when a field takes focus) and refuses to
// attach again while that frame is there. Once the frame goes, it attaches again. So every
// snapshot tries the debugger first and falls back to the page, and an action goes to the
// session that took the last snapshot: a ref only means something to the session that printed it.

import type { PlaywrightToolResult, SemanticPageSession } from './playwright-mcp-session'

/** Chrome's refusal when another extension's frame is in the tab. */
export const DEBUGGER_BLOCKED = 'Cannot access a chrome-extension:// URL of different extension'

export function isDebuggerBlocked(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return text.includes(DEBUGGER_BLOCKED)
}

/** One live debugger connection to the task tab: Playwright MCP over Chrome's debugger. */
export interface DebuggerConnection {
  readonly session: SemanticPageSession
  close(): Promise<void>
}

export type PageControl = 'debugger' | 'page'

export interface DebuggerFallbackOptions {
  /** Attach and connect. Throws Chrome's refusal while another extension's frame is in the tab. */
  readonly connect: () => Promise<DebuggerConnection>
  readonly page: SemanticPageSession
  /** The task moved between debugger and in-page control. */
  readonly onSwitch: (to: PageControl) => void
}

/** Told to the loop when Chrome drops the debugger under an action. */
export const DEBUGGER_DROPPED_RESULT: PlaywrightToolResult = {
  isError: true,
  text: 'The element reference is stale: Chrome dropped its debugger because another extension added a frame to the page. Take a new snapshot.'
}

type Run = (session: SemanticPageSession) => Promise<PlaywrightToolResult>

/**
 * Chrome refusals before the task stays on page controls. Each retry flashes Chrome's debugging
 * bar on and off, so a page that keeps blocking it is left to the in-page controls.
 */
export const MAX_DEBUGGER_REFUSALS = 2

export class DebuggerFallbackSession implements SemanticPageSession {
  private connection: DebuggerConnection | null = null
  private control: PageControl | null = null
  private refusals = 0

  constructor(private readonly options: DebuggerFallbackOptions) {}

  /** True while the debugger took the last snapshot: the pointer overlay needs it. */
  usesDebugger(): boolean {
    return this.control === 'debugger' && this.connection !== null
  }

  snapshot(signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return this.observe((session) => session.snapshot(signal))
  }

  recoverPage(url: string | undefined, signal?: AbortSignal): Promise<PlaywrightToolResult> {
    return this.observe((session) => session.recoverPage(url, signal))
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<PlaywrightToolResult> {
    if (!this.usesDebugger()) return this.options.page.call(name, args, signal)
    // The ref came from the debugger's snapshot and means nothing to the page session, so a
    // refused action is never replayed there: the loop re-observes and decides again.
    return (await this.viaDebugger((s) => s.call(name, args, signal))) ?? DEBUGGER_DROPPED_RESULT
  }

  async close(): Promise<void> {
    const connection = this.connection
    this.connection = null
    await connection?.close()
  }

  private async observe(run: Run): Promise<PlaywrightToolResult> {
    const viaDebugger = await this.viaDebugger(run)
    this.switchTo(viaDebugger ? 'debugger' : 'page')
    return viaDebugger ?? run(this.options.page)
  }

  /** Run over the debugger, connecting first when needed. Null while Chrome refuses it. */
  private async viaDebugger(run: Run): Promise<PlaywrightToolResult | null> {
    if (this.refusals >= MAX_DEBUGGER_REFUSALS) return null
    try {
      this.connection ??= await this.options.connect()
      const result = await run(this.connection.session)
      if (!result.isError || !isDebuggerBlocked(result.text)) return result
    } catch (error) {
      if (!isDebuggerBlocked(error)) throw error
    }
    // A connection Chrome detached from is not reused: the next try starts a fresh one.
    this.refusals += 1
    await this.close().catch(() => undefined)
    return null
  }

  private switchTo(control: PageControl): void {
    const previous = this.control
    this.control = control
    if (previous !== control && (previous !== null || control === 'page')) {
      this.options.onSwitch(control)
    }
  }
}
