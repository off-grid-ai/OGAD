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
import { VisionGuard } from '../vision/vision-guard'
import { emitVisionState, emitVisionStep, registerVisionSession } from '../vision/vision-controller'
import { showSupervisorWindow, hideSupervisorWindow } from '../vision/supervisor-window'
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
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        // Off Grid's OWN persistent browser profile. A `persist:` partition keeps
        // cookies / logins / history / localStorage on disk, so the user signs
        // into a site inside this pane ONCE and stays signed in across restarts -
        // a real baked-in browser, not a throwaway view.
        partition: 'persist:agent-browser',
        // The agent drives this view over CDP (Input.dispatchMouseEvent) - events
        // go straight to the renderer, never the real cursor/keyboard - so the
        // user keeps using their machine while it works. Chromium would throttle
        // a backgrounded renderer, so disable it or the browsing crawls whenever
        // Off Grid isn't the focused window.
        backgroundThrottling: false
      }
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

  /** Bring the view's renderer up on the start page NATIVELY before any CDP
   *  command. A freshly-created WebContentsView has no committed frame, so the
   *  debugger has no live target and EVERY CDP command (Page.enable,
   *  Runtime.evaluate) hangs until the 15s guard - that was the "did nothing"
   *  failure. webContents.loadURL spawns the renderer and lands the page, after
   *  which CDP has a real target. Raced with a timeout so a slow/aborted load
   *  still hands control back (a partial load already spawned the renderer). */
  private async loadNatively(view: WebContentsView, url: string): Promise<void> {
    const load = view.webContents.loadURL(url).catch(() => {
      /* aborts / redirects still commit a renderer, which is all CDP needs */
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 20_000)
      timer.unref?.()
    })
    await Promise.race([load, timeout]).finally(() => clearTimeout(timer))
  }

  async runTask(goal: string, url: string | undefined, taskId: string): Promise<WebTaskResult> {
    const view = this.ensureView()
    // A web task with no start URL would begin on a blank pane (no page to act
    // on, and snapshotting about:blank can hang) - default to a real search page
    // so the model always has somewhere to start and can navigate from there.
    const start = url ?? 'https://www.google.com'
    console.log(`[web-task] runTask goal="${goal}" url="${start}"`)
    const coordinator = getTakeoverCoordinator()

    // The browser rail reports through the SAME supervisor bridge as the AX /
    // vision rails, so the one floating panel shows its step feed and its Stop
    // works no matter which rail is driving (one source of truth for "what is
    // the computer-use task doing"). `browser:*` stays for the in-app watched
    // pane + takeover UX; this adds the cross-rail panel.
    const guard = new VisionGuard()
    const releaseSession = registerVisionSession(guard)
    const setState = (
      status: 'running' | 'done' | 'failed',
      summary?: string
    ): void => {
      emitVisionState({ taskId, goal, status, summary })
      broadcast('browser:task-state', { taskId, goal, status, summary })
    }
    setState('running')
    showSupervisorWindow()

    try {
      // Land the start page natively FIRST so the debugger has a live target,
      // THEN attach CDP for the snapshot/input the loop drives.
      await this.loadNatively(view, start)
      emitVisionStep(taskId, `opened ${start}`)
      broadcast('browser:step', { taskId, note: `opened ${start}` })
      const driver = new BrowserDriver(attachCdp(view))
      // startUrl is '' - the page is already loaded natively, so the loop goes
      // straight to snapshotting it instead of re-navigating over CDP.
      const result = await runWebTask(goal, '', {
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
          emitVisionStep(taskId, note)
          broadcast('browser:step', { taskId, note })
        },
        shouldStop: () => guard.isHalted
      })

      console.log(
        `[web-task] result ok=${result.ok} steps=${result.steps.length} summary="${result.summary}"`
      )
      setState(result.ok ? 'done' : 'failed', result.summary)
      return result
    } catch (error) {
      // A throw in setup/snapshot/CDP was silently disappearing (no step, no
      // result line) and read as a mystery failure. Surface it and return a
      // proper failed result so the engine sees an outcome, not an exception.
      const detail = error instanceof Error ? error.message : String(error)
      console.log(`[web-task] ERROR: ${detail}`)
      setState('failed', `browser task error: ${detail}`)
      return { ok: false, summary: `browser task error: ${detail}`, steps: [], takeovers: 0, finalUrl: '' }
    } finally {
      releaseSession()
      hideSupervisorWindow()
    }
  }
}

let host: BrowserHost | null = null

export function getBrowserRailHost(): BrowserRailHost {
  if (!host) {
    host = new BrowserHost()
  }
  return host
}
