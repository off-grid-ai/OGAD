/**
 * The browser rail's live host (R2-C3) - the Electron shell the pure pieces
 * plug into. It owns the WebContentsView that renders the watched page, the
 * CDP debugger attached to it (as a CdpTransport), the local model as the
 * step decider, the takeover coordinator, and the step broadcasts to the
 * watched pane.
 *
 * Session shape follows the Midscene and Stagehand/open-browser-use model: one
 * context owns independent pages, one page is active, and inactive pages keep
 * their state for later resume. Off Grid AI-specific code below embeds each
 * page as an Electron WebContentsView and connects it to task history, IPC,
 * takeover, and the watched SidePanel.
 *
 * This is native/Electron glue over tested modules (the collector, the driver,
 * the loop, the coordinator, the executor adapter are each unit-tested), so it
 * is excluded from in-process coverage like the other rail hosts - exercised
 * on a real display in the e2e tour and the real-machine pass, not here.
 */
import { BrowserWindow, WebContentsView, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { llm } from '../llm'
import { BrowserDriver, type CdpTransport } from './browser-driver'
import { runWebTask, STEP_RESPONSE_FORMAT, type WebTaskResult } from './web-task-agent'
import { getTakeoverCoordinator } from './takeover'
import { VisionGuard } from '../vision/vision-guard'
import { registerVisionSession } from '../vision/vision-controller'
import { getMainWindow } from '../main-window'
import type { BrowserRailHost } from './browser-rail'
import { appendTaskStep, getTaskRun, recordTaskRun } from '../tasks/task-history'
import { getDB } from '../database'
import { BrowserHistoryStore } from './browser-history-store'
import { BrowserSessionStore, type BrowserSessionRecord } from './browser-session-store'
import type {
  BrowserChromeState,
  BrowserControl,
  BrowserNavigationState,
  BrowserTaskPointer
} from '../../shared/browser-session'

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

type BrowserTaskState = BrowserTaskPointer & { sessionId: string }

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
  private readonly sessions = new BrowserSessionStore<WebContentsView>()
  private readonly history = new BrowserHistoryStore(getDB())
  private region: Rect | null = null
  private windowLifecycleBound = false

  constructor() {
    this.history.migrate()
  }

  private broadcastSessions(): void {
    broadcast('browser:sessions-state', this.sessions.snapshot())
  }

  private broadcastNavigation(record: BrowserSessionRecord<WebContentsView>): void {
    broadcast('browser:navigation-state', {
      sessionId: record.sessionId,
      ...record.chrome
    } satisfies BrowserNavigationState)
  }

  private readChrome(record: BrowserSessionRecord<WebContentsView>): BrowserChromeState {
    const contents = record.resource.webContents
    if (contents.isDestroyed()) return record.chrome
    const navigationHistory = contents.navigationHistory
    return {
      url: contents.getURL(),
      title: contents.getTitle() || 'New tab',
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
      isLoading: contents.isLoading()
    }
  }

  private refreshSession(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    if (!record) return
    const chrome = this.readChrome(record)
    this.sessions.updateChrome(sessionId, chrome)
    if (record.task) {
      recordTaskRun({
        taskId: record.task.taskId,
        kind: 'web_use',
        title: record.task.goal,
        status: record.task.status,
        summary: record.task.summary,
        steps: record.task.steps,
        lastUrl: chrome.url,
        lastTitle: chrome.title
      })
    } else if (/^https?:\/\//i.test(chrome.url)) {
      this.history.upsert({
        historyId: record.historyId ?? record.sessionId,
        title: chrome.title,
        url: chrome.url
      })
    }
    this.broadcastNavigation(record)
    this.broadcastSessions()
  }

  private setViewVisible(view: WebContentsView, visible: boolean): void {
    try {
      view.webContents.setAudioMuted(!visible)
    } catch {
      return
    }
    const setVisible = (view as unknown as { setVisible?: (value: boolean) => void }).setVisible
    if (typeof setVisible === 'function') setVisible.call(view, visible)
    else if (!visible) view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  }

  private destroyView(view: WebContentsView): void {
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

  dispose(): void {
    this.region = null
    for (const record of this.sessions.clear()) this.destroyView(record.resource)
    this.broadcastSessions()
  }

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

  private syncViewVisibility(): void {
    const active = this.sessions.active
    for (const record of this.sessions.snapshot().sessions) {
      const live = this.sessions.get(record.sessionId)
      if (!live) continue
      const visible = Boolean(active && active.sessionId === live.sessionId && this.region)
      if (visible) live.resource.setBounds(this.region ?? this.coarseBounds())
      this.setViewVisible(live.resource, visible)
    }
  }

  setRegion(rect: Rect | null): void {
    this.region = rect
    this.syncViewVisibility()
  }

  private createSession(input: {
    sessionId: string
    historyId?: string
    kind: 'manual' | 'task'
    task?: BrowserTaskPointer
  }): BrowserSessionRecord<WebContentsView> {
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        partition: 'persist:agent-browser',
        backgroundThrottling: false
      }
    })
    const win = getMainWindow()
    win?.contentView.addChildView(view)
    const record = this.sessions.create({ ...input, resource: view })
    const refresh = (): void => this.refreshSession(record.sessionId)
    view.webContents.on('did-start-loading', refresh)
    view.webContents.on('did-stop-loading', refresh)
    view.webContents.on('did-navigate', refresh)
    view.webContents.on('did-navigate-in-page', refresh)
    view.webContents.on('page-title-updated', refresh)
    view.webContents.on('page-favicon-updated', (_event, favicons) => {
      const current = this.sessions.get(record.sessionId)
      if (!current) return
      this.sessions.updateChrome(record.sessionId, {
        ...current.chrome,
        faviconUrl: favicons[0]
      })
      this.broadcastSessions()
      this.broadcastNavigation(current)
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = normalizeBrowserAddress(url)
      if (target) void this.navigate(target, record.sessionId)
      return { action: 'deny' }
    })
    if (win && !this.windowLifecycleBound) {
      this.windowLifecycleBound = true
      win.on('hide', () => {
        for (const session of this.sessions.snapshot().sessions) {
          const live = this.sessions.get(session.sessionId)
          if (live) this.setViewVisible(live.resource, false)
        }
      })
      win.once('close', () => this.dispose())
    }
    this.syncViewVisibility()
    this.broadcastSessions()
    this.broadcastNavigation(record)
    return record
  }

  newTab(): { sessionId: string } {
    const sessionId = randomUUID()
    const record = this.createSession({ sessionId, historyId: sessionId, kind: 'manual' })
    return { sessionId: record.sessionId }
  }

  getSessions(): ReturnType<BrowserSessionStore<WebContentsView>['snapshot']> {
    return this.sessions.snapshot()
  }

  activateSession(sessionId: string): boolean {
    if (!this.sessions.activate(sessionId)) return false
    this.syncViewVisibility()
    const record = this.sessions.active
    if (record) this.broadcastNavigation(record)
    this.broadcastSessions()
    return true
  }

  closeSession(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record) return false
    // A running or completed agent session remains reopenable in memory. Closing
    // its tab only hides it; the durable task row remains the restart fallback.
    if (record.kind === 'task') {
      this.sessions.deactivate(sessionId)
      this.syncViewVisibility()
      this.broadcastSessions()
      return true
    }
    const closed = this.sessions.close(sessionId)
    if (!closed) return false
    this.destroyView(closed.resource)
    this.syncViewVisibility()
    const active = this.sessions.active
    if (active) this.broadcastNavigation(active)
    this.broadcastSessions()
    return true
  }

  control(action: BrowserControl, sessionId?: string): boolean {
    const record = sessionId ? this.sessions.get(sessionId) : this.sessions.active
    const contents = record?.resource.webContents
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
    this.refreshSession(record.sessionId)
    return true
  }

  async navigate(address: string, sessionId?: string): Promise<{ ok: boolean; detail?: string }> {
    const target = normalizeBrowserAddress(address)
    if (!target) {
      return { ok: false, detail: 'Enter a website or search.' }
    }
    let record = sessionId ? this.sessions.get(sessionId) : this.sessions.active
    if (!record) {
      const newSessionId = randomUUID()
      record = this.createSession({
        sessionId: newSessionId,
        historyId: newSessionId,
        kind: 'manual'
      })
    }
    this.activateSession(record.sessionId)
    try {
      await this.loadNatively(record.resource, target)
      this.refreshSession(record.sessionId)
      return { ok: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, detail }
    }
  }

  reopen(taskId?: string): boolean {
    let record = taskId ? this.sessions.findTask(taskId) : this.sessions.active
    if (!record && taskId) {
      const saved = getTaskRun(taskId)
      if (!saved || saved.kind !== 'web_use') return false
      const task: BrowserTaskPointer = {
        taskId: saved.taskId,
        goal: saved.title,
        status: saved.status === 'done' ? 'done' : 'failed',
        summary: saved.summary,
        steps: saved.steps
      }
      record = this.createSession({ sessionId: `task:${saved.taskId}`, kind: 'task', task })
      if (saved.lastUrl) void this.navigate(saved.lastUrl, record.sessionId)
    }
    if (!record?.task) return false
    this.activateSession(record.sessionId)
    broadcast('browser:task-state', { sessionId: record.sessionId, ...record.task })
    return true
  }

  reopenManual(historyId: string): { sessionId: string } | null {
    const saved = this.history.get(historyId)
    if (!saved) return null
    const record = this.createSession({
      sessionId: randomUUID(),
      historyId: saved.historyId,
      kind: 'manual'
    })
    void this.navigate(saved.url, record.sessionId)
    return { sessionId: record.sessionId }
  }

  listManualHistory(): ReturnType<BrowserHistoryStore['list']> {
    return this.history.list()
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
      timer.unref()
    })
    await Promise.race([load, timeout]).finally(() => clearTimeout(timer))
  }

  async runTask(goal: string, url: string | undefined, taskId: string): Promise<WebTaskResult> {
    let record = this.sessions.findTask(taskId)
    if (!record) {
      record = this.createSession({
        sessionId: `task:${taskId}`,
        kind: 'task',
        task: { taskId, goal, status: 'running', steps: [] }
      })
    }
    this.activateSession(record.sessionId)
    const view = record.resource
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
      const task = { taskId, goal, status, summary, steps: [...steps] }
      this.sessions.updateTask(record.sessionId, task)
      recordTaskRun({
        taskId,
        kind: 'web_use',
        title: goal,
        status,
        summary,
        steps,
        lastUrl: record.chrome.url,
        lastTitle: record.chrome.title
      })
      broadcast('browser:task-state', {
        sessionId: record.sessionId,
        ...task
      } satisfies BrowserTaskState)
      this.broadcastSessions()
    }
    setState('running')

    try {
      // Land the start page natively FIRST so the debugger has a live target,
      // THEN attach CDP for the snapshot/input the loop drives.
      await this.loadNatively(view, start)
      this.refreshSession(record.sessionId)
      const opened = `opened ${start}`
      steps.push(opened)
      appendTaskStep(taskId, 'web_use', goal, opened)
      broadcast('browser:step', { sessionId: record.sessionId, taskId, note: opened })
      const driver = new BrowserDriver(attachCdp(view), undefined, (pointer) => {
        broadcast('browser:pointer', { sessionId: record.sessionId, ...pointer })
      })
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
          broadcast('browser:takeover', { sessionId: record.sessionId, taskId, why })
          await coordinator.waitForTakeover(taskId, why)
        },
        onStep: (note) => {
          console.log(`[web-task] step: ${note}`)
          steps.push(note)
          appendTaskStep(taskId, 'web_use', goal, note)
          broadcast('browser:step', { sessionId: record.sessionId, taskId, note })
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
  host = null
}

/** Wire the renderer's pane-region reports to the live view so it docks to the
 *  watched pane and hides when there is none. Fire-and-forget (ipcMain.on). */
export function registerBrowserViewIpc(): void {
  ipcMain.on('browser:set-region', (_e, raw: unknown) => {
    browserHost().setRegion(parseRect(raw))
  })
  ipcMain.handle('browser:new-tab', () => browserHost().newTab())
  ipcMain.handle('browser:get-sessions', () => browserHost().getSessions())
  ipcMain.handle('browser:activate-session', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? browserHost().activateSession(sessionId) : false
  )
  ipcMain.handle('browser:close-session', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? browserHost().closeSession(sessionId) : false
  )
  ipcMain.handle('browser:control', (_e, action: unknown, sessionId: unknown) => {
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
      return false
    }
    return browserHost().control(action, typeof sessionId === 'string' ? sessionId : undefined)
  })
  ipcMain.handle('browser:navigate', (_e, address: unknown, sessionId: unknown) => {
    if (typeof address !== 'string') {
      return { ok: false, detail: 'Enter a website or search.' }
    }
    return browserHost().navigate(address, typeof sessionId === 'string' ? sessionId : undefined)
  })
  ipcMain.handle('browser:reopen', (_event, taskId: unknown) =>
    browserHost().reopen(typeof taskId === 'string' ? taskId : undefined)
  )
  ipcMain.handle('browser:list-manual-history', () => browserHost().listManualHistory())
  ipcMain.handle('browser:reopen-manual', (_event, historyId: unknown) =>
    typeof historyId === 'string' ? browserHost().reopenManual(historyId) : null
  )
}
