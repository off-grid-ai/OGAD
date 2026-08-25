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
import { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { llm } from '../llm'
import { BrowserDriver, type CdpTransport } from './browser-driver'
import { runWebTask, STEP_RESPONSE_FORMAT, type WebTaskResult } from './web-task-agent'
import { getTakeoverCoordinator } from './takeover'
import { VisionGuard } from '../vision/vision-guard'
import { registerVisionSession } from '../vision/vision-controller'
import { getMainWindow } from '../main-window'
import type { BrowserRailHost } from './browser-rail'
import { appendTaskStep, getTaskRun, recordTaskRun } from '../tasks/task-history'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** The on-screen rectangle (CSS px, viewport-relative) the watched pane reserves
 *  for the live page. CSS px map 1:1 to Electron's DIP setBounds coordinates. */
interface Rect {
  x: number
  y: number
  width: number
  height: number
}

type BrowserControl = 'back' | 'forward' | 'reload' | 'stop'

interface BrowserNavigationState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

interface BrowserTaskState {
  taskId: string
  goal: string
  status: 'running' | 'done' | 'failed'
  summary?: string
  steps: string[]
}

/** Convert what the user enters in the address field to a safe web URL. A host
 *  gets HTTPS; other text becomes a search. The browser rail never accepts
 *  file:, javascript:, or app protocols from this surface. */
export function normalizeBrowserAddress(input: string): string | null {
  const value = input.trim()
  if (!value) {
    return null
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
    } catch {
      return null
    }
  }
  if (!/\s/.test(value) && value.includes('.')) {
    try {
      return new URL(`https://${value}`).toString()
    } catch {
      return null
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Fail-closed parse of the region the renderer reports. A missing/garbage value
 *  (or a zero-size rect) means "hide" - null. */
function parseRect(input: unknown): Rect | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const r = input as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN)
  const rect = { x: n(r.x), y: n(r.y), width: n(r.width), height: n(r.height) }
  if (Object.values(rect).some(Number.isNaN) || rect.width < 1 || rect.height < 1) {
    return null
  }
  return rect
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
  /** The pane region the renderer last reported. null => hide the view. */
  private region: Rect | null = null
  private currentTask: BrowserTaskState | null = null
  private navigationState: BrowserNavigationState = {
    url: '',
    title: 'New tab',
    canGoBack: false,
    canGoForward: false,
    isLoading: false
  }

  private broadcastNavigationState(): void {
    broadcast('browser:navigation-state', this.navigationState)
  }

  private readNavigationState(): BrowserNavigationState {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) {
      return this.navigationState
    }
    const history = contents.navigationHistory
    return {
      url: contents.getURL(),
      title: contents.getTitle() || 'New tab',
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      isLoading: contents.isLoading()
    }
  }

  private refreshNavigationState(): void {
    this.navigationState = this.readNavigationState()
    if (this.currentTask) {
      recordTaskRun({
        taskId: this.currentTask.taskId,
        kind: 'web_use',
        title: this.currentTask.goal,
        status: this.currentTask.status,
        summary: this.currentTask.summary,
        steps: this.currentTask.steps,
        lastUrl: this.navigationState.url,
        lastTitle: this.navigationState.title
      })
    }
    this.broadcastNavigationState()
  }

  private setViewVisible(visible: boolean): void {
    const view = this.view
    if (!view) {
      return
    }
    // A hidden agent-browser must be SILENT. The WebContentsView keeps running when
    // it's off-screen (backgroundThrottling is off, so the agent can work while the
    // user does other things) - which means a playing video would keep its audio
    // going after the pane closes or the window is hidden. Mute when hidden, unmute
    // when shown, so closing the browser actually stops the sound.
    try {
      view.webContents.setAudioMuted(!visible)
    } catch {
      /* view torn down mid-flip - nothing to mute */
    }
    const sv = (view as unknown as { setVisible?: (v: boolean) => void }).setVisible
    if (typeof sv === 'function') {
      sv.call(view, visible)
    } else if (!visible) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }

  /** Tear the live view down completely: remove it from the window and close its
   *  WebContents, which stops any media immediately. Used when the app quits or the
   *  window closes so a task's browser never lingers (audible) after it's gone. */
  dispose(): void {
    const view = this.view
    if (!view) {
      return
    }
    this.view = null
    this.region = null
    try {
      getMainWindow()?.contentView.removeChildView(view)
    } catch {
      /* window already gone */
    }
    try {
      ;(view.webContents as unknown as { close?: () => void }).close?.()
    } catch {
      /* already destroyed */
    }
  }

  /** A coarse right-half rectangle: the fallback bounds so the browser is ALWAYS
   *  visible the instant a task runs, even before the pane reports its exact
   *  region - or if that report never arrives. */
  private coarseBounds(): Rect {
    const win = getMainWindow()
    const [width, height] = (win ? win.getContentSize() : [1200, 800]) as [number, number]
    return {
      x: Math.round(width * 0.58),
      y: 56,
      width: Math.round(width * 0.42),
      height: Math.max(200, height - 260)
    }
  }

  /** Show the live view now, docked to the last-reported region or a coarse
   *  default - so every task makes the browser appear (including a second task
   *  after the first hid the view). */
  private showView(): void {
    if (!this.view) {
      return
    }
    this.view.setBounds(this.region ?? this.coarseBounds())
    this.setViewVisible(true)
  }

  /** The renderer reports the pane's on-screen region so the view docks to it
   *  exactly; null (the pane unmounted) hides the view so it never lingers,
   *  misaligned, over another screen. */
  setRegion(rect: Rect | null): void {
    this.region = rect
    if (!this.view) {
      return
    }
    if (rect) {
      this.view.setBounds(rect)
      this.setViewVisible(true)
    } else {
      this.setViewVisible(false)
    }
  }

  private ensureView(): WebContentsView {
    if (this.view) {
      this.showView()
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
    const win = getMainWindow()
    win?.contentView.addChildView(view)
    this.view = view
    const refresh = (): void => this.refreshNavigationState()
    view.webContents.on('did-start-loading', refresh)
    view.webContents.on('did-stop-loading', refresh)
    view.webContents.on('did-navigate', refresh)
    view.webContents.on('did-navigate-in-page', refresh)
    view.webContents.on('page-title-updated', refresh)
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = normalizeBrowserAddress(url)
      if (target) {
        void view.webContents.loadURL(target)
      }
      return { action: 'deny' }
    })
    // Silence / tear down the browser when the window goes away. setRegion only
    // fires while the pane is mounted, so a video would keep playing behind a
    // hidden window (macOS keeps the app alive on window close) unless we react to
    // the window itself: mute on hide, fully dispose on close.
    win?.on('hide', () => this.setViewVisible(false))
    win?.once('close', () => this.dispose())
    // Show it immediately (region if reported, else coarse) so the browser is
    // never invisible while a task runs; the pane refines / hides it via
    // setRegion.
    this.showView()
    return view
  }

  control(action: BrowserControl): boolean {
    const contents = this.view?.webContents
    if (!contents || contents.isDestroyed()) {
      return false
    }
    const history = contents.navigationHistory
    if (action === 'back' && history.canGoBack()) {
      history.goBack()
    } else if (action === 'forward' && history.canGoForward()) {
      history.goForward()
    } else if (action === 'reload') {
      contents.reload()
    } else if (action === 'stop') {
      contents.stop()
    } else {
      return false
    }
    this.refreshNavigationState()
    return true
  }

  async navigate(address: string): Promise<{ ok: boolean; detail?: string }> {
    const target = normalizeBrowserAddress(address)
    if (!target) {
      return { ok: false, detail: 'Enter a website or search.' }
    }
    const view = this.ensureView()
    try {
      await this.loadNatively(view, target)
      this.refreshNavigationState()
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, detail }
    }
  }

  reopen(taskId?: string): boolean {
    if (taskId && this.currentTask?.taskId !== taskId) {
      const saved = getTaskRun(taskId)
      if (!saved || saved.kind !== 'web_use') return false
      this.currentTask = {
        taskId: saved.taskId,
        goal: saved.title,
        status: saved.status === 'done' ? 'done' : 'failed',
        summary: saved.summary,
        steps: saved.steps
      }
      if (saved.lastUrl) void this.navigate(saved.lastUrl)
    }
    if (!this.currentTask) {
      return false
    }
    this.showView()
    broadcast('browser:task-state', this.currentTask)
    this.broadcastNavigationState()
    return true
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

    // The browser rail's surface is the in-app watched pane (browser:*), which
    // shows the live page + step feed inline - so NO floating supervisor window
    // here (that is for the AX/vision rails, whose driven surface is OUTSIDE the
    // app). The VisionGuard is still registered so the pane's Stop / close halts
    // the loop through the vision:control seam.
    const guard = new VisionGuard()
    const releaseSession = registerVisionSession(guard)
    const steps: string[] = []
    const setState = (status: 'running' | 'done' | 'failed', summary?: string): void => {
      this.currentTask = { taskId, goal, status, summary, steps: [...steps] }
      recordTaskRun({
        taskId,
        kind: 'web_use',
        title: goal,
        status,
        summary,
        steps,
        lastUrl: this.navigationState.url,
        lastTitle: this.navigationState.title
      })
      broadcast('browser:task-state', this.currentTask)
    }
    setState('running')

    try {
      // Land the start page natively FIRST so the debugger has a live target,
      // THEN attach CDP for the snapshot/input the loop drives.
      await this.loadNatively(view, start)
      const opened = `opened ${start}`
      steps.push(opened)
      appendTaskStep(taskId, 'web_use', goal, opened)
      broadcast('browser:step', { taskId, note: opened })
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
          steps.push(note)
          appendTaskStep(taskId, 'web_use', goal, note)
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
      steps.push(`error: ${detail}`)
      appendTaskStep(taskId, 'web_use', goal, `error: ${detail}`)
      setState('failed', `Web Use stopped: ${detail}`)
      return {
        ok: false,
        summary: `Web Use stopped: ${detail}`,
        steps,
        takeovers: 0,
        finalUrl: ''
      }
    } finally {
      releaseSession()
    }
  }
}

let host: BrowserHost | null = null

function browserHost(): BrowserHost {
  if (!host) {
    host = new BrowserHost()
  }
  return host
}

export function getBrowserRailHost(): BrowserRailHost {
  return browserHost()
}

/** Stop + drop the agent browser (halts any playing media). Called on app quit so a
 *  running task's browser never lingers audibly after the app is gone. No-op if the
 *  view was never created. */
export function disposeBrowserHost(): void {
  host?.dispose()
}

/** Wire the renderer's pane-region reports to the live view so it docks to the
 *  watched pane and hides when there is none. Fire-and-forget (ipcMain.on). */
export function registerBrowserViewIpc(): void {
  ipcMain.on('browser:set-region', (_e, raw: unknown) => {
    browserHost().setRegion(parseRect(raw))
  })
  ipcMain.handle('browser:control', (_e, action: unknown) => {
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
      return false
    }
    return browserHost().control(action)
  })
  ipcMain.handle('browser:navigate', (_e, address: unknown) => {
    if (typeof address !== 'string') {
      return { ok: false, detail: 'Enter a website or search.' }
    }
    return browserHost().navigate(address)
  })
  ipcMain.handle('browser:reopen', (_event, taskId: unknown) =>
    browserHost().reopen(typeof taskId === 'string' ? taskId : undefined)
  )
}
