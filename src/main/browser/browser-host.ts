/**
 * The browser rail's live host (R2-C3) - the Electron shell the pure pieces
 * plug into. It owns the WebContentsView that renders the watched page, the
 * CDP debugger attached to it (as a CdpTransport), the local model as the
 * step decider, the takeover coordinator, and the step broadcasts to the
 * watched pane.
 *
 * This is native/Electron glue over tested modules (the collector, the driver,
 * the loop, the coordinator, the executor adapter are each unit-tested), so it
 * is excluded from in-process coverage like the other rail hosts - exercised
 * on a real display in the e2e tour and the real-machine pass, not here.
 */
import { BrowserWindow, WebContentsView } from 'electron'
import { llm } from '../llm'
import { BrowserDriver, type CdpTransport } from './browser-driver'
import { runWebTask, STEP_RESPONSE_FORMAT, type WebTaskResult } from './web-task-agent'
import { getTakeoverCoordinator } from './takeover'
import type { BrowserRailHost } from './browser-rail'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** Electron's per-webContents debugger, wrapped as the driver's transport. */
function attachCdp(view: WebContentsView): CdpTransport {
  const dbg = view.webContents.debugger
  if (!dbg.isAttached()) {
    dbg.attach('1.3')
  }
  return {
    send: <T>(method: string, params?: Record<string, unknown>) =>
      dbg.sendCommand(method, params) as Promise<T>,
    on: (listener) => {
      const handler = (_e: unknown, method: string, params: unknown): void =>
        listener(method, params)
      dbg.on('message', handler)
      return () => dbg.off('message', handler)
    }
  }
}

class BrowserHost implements BrowserRailHost {
  private view: WebContentsView | null = null

  private ensureView(): WebContentsView {
    if (this.view) {
      return this.view
    }
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true }
    })
    const win = BrowserWindow.getAllWindows()[0]
    win?.contentView.addChildView(view)
    // The renderer reserves the region; a coarse right-half default keeps the
    // page visible before the pane reports precise bounds.
    const [width, height] = (win ? win.getContentSize() : [1200, 800]) as [number, number]
    view.setBounds({
      x: Math.round(width * 0.58),
      y: 56,
      width: Math.round(width * 0.42),
      height: height - 260
    })
    this.view = view
    return view
  }

  async runTask(goal: string, url: string | undefined, taskId: string): Promise<WebTaskResult> {
    const view = this.ensureView()
    const driver = new BrowserDriver(attachCdp(view))
    broadcast('browser:task-state', { taskId, goal, status: 'running' })
    console.log(`[web-task] runTask goal="${goal}" url="${url ?? ''}"`)
    const coordinator = getTakeoverCoordinator()

    const result = await runWebTask(goal, url, {
      driver,
      decide: (prompt) =>
        llm.chat(prompt, [], 60_000, 400, {
          disableThinking: true,
          responseFormat: STEP_RESPONSE_FORMAT
        }),
      waitForTakeover: async (why) => {
        broadcast('browser:takeover', { taskId, why })
        await coordinator.waitForTakeover(taskId, why)
      },
      onStep: (note) => {
        console.log(`[web-task] step: ${note}`)
        broadcast('browser:step', { taskId, note })
      }
    })

    console.log(
      `[web-task] result ok=${result.ok} steps=${result.steps.length} summary="${result.summary}"`
    )
    broadcast('browser:task-state', {
      taskId,
      goal,
      status: result.ok ? 'done' : 'failed',
      summary: result.summary
    })
    return result
  }
}

let host: BrowserHost | null = null

export function getBrowserRailHost(): BrowserRailHost {
  if (!host) {
    host = new BrowserHost()
  }
  return host
}
