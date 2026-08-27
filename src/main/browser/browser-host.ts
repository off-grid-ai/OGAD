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
import {
  BrowserDriver,
  DEFAULT_BROWSER_POINTER,
  type BrowserPointerEvent,
  type CdpTransport
} from './browser-driver'
import type { WebTaskResult } from './web-task-agent'
import { getTakeoverCoordinator } from './takeover'
import { VisionGuard } from '../vision/vision-guard'
import { registerVisionSession } from '../vision/vision-controller'
import { getMainWindow } from '../main-window'
import type { BrowserRailHost, BrowserTaskRequest } from './browser-rail'
import {
  getTaskExecutionDevice,
  getTaskRun,
  recordTaskRun,
  reportTaskProgress,
  stopOrphanedLocalWebTask
} from '../tasks/task-history'
import { getDB } from '../database'
import { registerTaskGuideHandler, TASK_GUIDANCE_TRACE } from '../tasks/task-guide'
import { BrowserHistoryStore } from './browser-history-store'
import { BrowserSessionStore, type BrowserSessionRecord } from './browser-session-store'
import type {
  BrowserChromeState,
  BrowserControl,
  BrowserNavigationState,
  BrowserTaskPointer,
  BrowserTaskStatus
} from '../../shared/browser-session'
import { fitWebUseDesktopRegion, webUseDesktopZoomFactor } from '../../shared/browser-session'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { retryPlanningGoal, TASK_RETRY_TRACE } from '../tasks/task-retry'
import { runBrowserVisualTask, withActiveBrowserVision } from './browser-visual-task'
import { BrowserJourneyRunOwners } from './browser-run-owners'

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

/** Use an address that the user wrote explicitly. This removes a full visual
 * model round trip for simple "open example.com" tasks. */
export function explicitBrowserAddress(goal: string): string | null {
  const match = goal.match(
    /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?:\/[^\s,;]*)?/i
  )
  return match ? normalizeBrowserAddress(match[0].replace(/[.)!?]+$/, '')) : null
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
  private readonly runOwners = new BrowserJourneyRunOwners()
  private readonly taskPointers = new Map<string, BrowserPointerEvent>()
  private region: Rect | null = null
  private windowLifecycleBound = false
  /** Last presentation state applied to each view. setRegion runs per drag
   * frame (ResizeObserver-driven), so unchanged bounds/zoom are skipped and a
   * repaint is forced only on the hidden-to-visible transition. */
  private readonly appliedPresentation = new WeakMap<
    WebContentsView,
    { bounds?: Rect; zoom?: number; visible?: boolean }
  >()

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

  private driverFor(record: BrowserSessionRecord<WebContentsView>): BrowserDriver {
    const pointer = this.taskPointers.get(record.sessionId) ?? DEFAULT_BROWSER_POINTER
    return new BrowserDriver(attachCdp(record.resource), undefined, {
      // Read fresh: the pane is resizable, so the zoom changes under a running task and the
      // injected cursor must stay the same on-screen size.
      zoomFactor: () => webUseDesktopZoomFactor(this.region ?? this.coarseBounds()),
      onPointer: (next) => {
        this.taskPointers.set(record.sessionId, next)
        broadcast('browser:pointer', { sessionId: record.sessionId, ...next })
      },
      initialPointer: pointer
    })
  }

  private async restoreTaskPointer(record: BrowserSessionRecord<WebContentsView>): Promise<void> {
    if (record.kind !== 'task' || record.resource.webContents.isDestroyed()) return
    await this.driverFor(record).ensurePointer(true)
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

  private presentationFor(view: WebContentsView): {
    bounds?: Rect
    zoom?: number
    visible?: boolean
  } {
    let state = this.appliedPresentation.get(view)
    if (!state) {
      state = {}
      this.appliedPresentation.set(view, state)
    }
    return state
  }

  private setViewVisible(view: WebContentsView, visible: boolean): void {
    try {
      view.webContents.setAudioMuted(!visible)
    } catch {
      return
    }
    const state = this.presentationFor(view)
    const setVisible = (view as unknown as { setVisible?: (value: boolean) => void }).setVisible
    if (typeof setVisible === 'function') setVisible.call(view, visible)
    else if (!visible) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      state.bounds = undefined
    }
    // Repaint only when the pane transitions from hidden to visible; Chromium
    // keeps an already-visible view fresh on its own.
    if (visible && state.visible !== true) {
      ;(view.webContents as unknown as { invalidate?: () => void }).invalidate?.()
    }
    state.visible = visible
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
    this.runOwners.haltAll('browser host closed')
    this.taskPointers.clear()
    for (const record of this.sessions.clear()) this.destroyView(record.resource)
    this.broadcastSessions()
  }

  private coarseBounds(): Rect {
    const win = getMainWindow()
    const [width, height] = (win ? win.getContentSize() : [1200, 800]) as [number, number]
    return fitWebUseDesktopRegion({
      x: Math.round(width * 0.58),
      y: 56,
      width: Math.round(width * 0.42),
      height: Math.max(200, height - 260)
    })
  }

  private syncViewVisibility(): void {
    const active = this.sessions.active
    for (const record of this.sessions.snapshot().sessions) {
      const live = this.sessions.get(record.sessionId)
      if (!live) continue
      const visible = Boolean(active && active.sessionId === live.sessionId && this.region)
      // Keep every page at a real desktop render size even while its pane is
      // hidden. Visibility is presentation only; it must not collapse the page
      // viewport that CDP captures for Web Use.
      const bounds = this.region ?? this.coarseBounds()
      const zoom = webUseDesktopZoomFactor(bounds)
      const state = this.presentationFor(live.resource)
      const applied = state.bounds
      if (
        !applied ||
        applied.x !== bounds.x ||
        applied.y !== bounds.y ||
        applied.width !== bounds.width ||
        applied.height !== bounds.height
      ) {
        live.resource.setBounds(bounds)
        state.bounds = { ...bounds }
      }
      if (state.zoom !== zoom) {
        live.resource.webContents.setZoomFactor(zoom)
        state.zoom = zoom
      }
      this.setViewVisible(live.resource, visible)
    }
  }

  setRegion(rect: Rect | null): void {
    this.region = rect ? fitWebUseDesktopRegion(rect) : null
    this.syncViewVisibility()
  }

  private createSession(input: {
    sessionId: string
    historyId?: string
    kind: 'manual' | 'task'
    journeyId?: string
    parentSessionId?: string
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
    const refreshPointer = (): void => {
      refresh()
      void this.restoreTaskPointer(record)
    }
    view.webContents.on('did-start-loading', refresh)
    view.webContents.on('did-stop-loading', refresh)
    view.webContents.on('did-navigate', refreshPointer)
    view.webContents.on('did-navigate-in-page', refresh)
    view.webContents.on('dom-ready', () => void this.restoreTaskPointer(record))
    view.webContents.on('did-finish-load', () => void this.restoreTaskPointer(record))
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
      if (target) void this.openManagedPage(record, target)
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
      win.on('show', () => this.syncViewVisibility())
      win.once('close', () => this.dispose())
    }
    this.syncViewVisibility()
    this.broadcastSessions()
    this.broadcastNavigation(record)
    return record
  }

  /** A site-requested page is a managed child tab. It keeps the parent's chat
   * journey and task trace, while the + button remains the only manual-tab path. */
  private async openManagedPage(
    parent: BrowserSessionRecord<WebContentsView>,
    target: string
  ): Promise<void> {
    const sessionId = randomUUID()
    const child = this.createSession({
      sessionId,
      ...(parent.kind === 'manual' ? { historyId: sessionId } : {}),
      kind: parent.kind,
      journeyId: parent.journeyId,
      parentSessionId: parent.sessionId,
      task: parent.task
    })
    this.activateSession(child.sessionId)
    try {
      await this.loadNatively(child.resource, target)
      this.refreshSession(child.sessionId)
    } catch {
      this.refreshSession(child.sessionId)
    }
  }

  newTab(): { sessionId: string } {
    const sessionId = randomUUID()
    const record = this.createSession({ sessionId, historyId: sessionId, kind: 'manual' })
    return { sessionId: record.sessionId }
  }

  /** Open a Chat link as a normal manual page. This is deliberately separate
   * from runTask: reading a source must never start Web Use automation. */
  async openUrl(url: string): Promise<{ sessionId: string } | null> {
    if (!/^https?:\/\//i.test(url)) return null
    const target = normalizeBrowserAddress(url)
    if (!target) return null
    const opened = this.newTab()
    await this.navigate(target, opened.sessionId)
    return opened
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
    if (record.kind === 'task' && !record.parentSessionId) {
      this.sessions.deactivate(sessionId)
      this.syncViewVisibility()
      this.broadcastSessions()
      return true
    }
    const closed = this.sessions.close(sessionId)
    if (!closed) return false
    this.taskPointers.delete(sessionId)
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
      record = this.sessions.findJourney(saved.journeyId)
      if (record?.task?.taskId === taskId) {
        this.activateSession(record.sessionId)
        broadcast('browser:task-state', { sessionId: record.sessionId, ...record.task })
        return true
      }
      // A Chat journey can contain many tasks. Its live page belongs to the
      // newest task pointer, so never reuse it as evidence for an older task.
      // Historical fallback gets an isolated page keyed by task ID.
      record = undefined
      const task: BrowserTaskPointer = {
        taskId: saved.taskId,
        journeyId: saved.journeyId,
        goal: saved.title,
        status: saved.status === 'done' ? 'done' : 'failed',
        summary: saved.summary,
        steps: saved.steps
      }
      record = this.createSession({
        sessionId: `history:${task.taskId}`,
        kind: 'task',
        task
      })
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

  stopTask(taskId: string): boolean {
    if (this.runOwners.stop(taskId, 'stopped from the task panel')) return true
    return stopOrphanedLocalWebTask(taskId)
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

  async runTask(request: BrowserTaskRequest): Promise<WebTaskResult> {
    const { goal, url, taskId, journeyId, checkpoint } = request
    let record = this.sessions.findJourney(journeyId)
    const continuingJourney = Boolean(record)
    if (!record) {
      record = this.createSession({
        sessionId: `journey:${journeyId}`,
        kind: 'task',
        journeyId,
        task: { taskId, journeyId, goal, status: 'running', steps: [] }
      })
    }
    this.activateSession(record.sessionId)
    const view = record.resource
    // A web task with no start URL would begin on a blank pane (no page to act
    // on, and snapshotting about:blank can hang) - default to a real search page
    // so the model always has somewhere to start and can navigate from there.
    const start =
      url ??
      explicitBrowserAddress(goal) ??
      (continuingJourney ? undefined : 'https://www.google.com')
    console.log(`[web-task] runTask goal="${goal}" url="${start ?? record.chrome.url}"`)
    const coordinator = getTakeoverCoordinator()

    // The browser rail's surface is the in-app watched pane (browser:*), which
    // shows the live page + step feed inline - so NO floating supervisor window
    // here (that is for the AX/vision rails, whose driven surface is OUTSIDE the
    // app). The VisionGuard is still registered so the pane's Stop / close halts
    // the loop through the vision:control seam.
    const guard = new VisionGuard()
    const ownership = this.runOwners.replace(journeyId, taskId, guard)
    const owner = ownership.owner
    if (ownership.replaced) {
      coordinator.resolve(ownership.replaced.taskId, 'cancelled')
      recordTaskRun({
        taskId: ownership.replaced.taskId,
        journeyId,
        kind: 'web_use',
        status: 'stopped',
        summary: 'Replaced by a newer task in this journey.',
        currentAction: 'Stopped when a newer task started'
      })
      record.resource.webContents.stop()
    }
    const releaseSession = registerVisionSession(taskId, guard, owner.controller)
    const steps: string[] = checkpoint ? [...checkpoint.steps, TASK_RETRY_TRACE] : []
    let currentStatus: BrowserTaskStatus = 'running'
    let currentSummary = ''
    const ownsRun = (): boolean => this.runOwners.isCurrent(owner)
    const replacedResult = (): WebTaskResult => ({
      ok: false,
      summary: 'Replaced by a newer task in this journey.',
      steps,
      takeovers: 0,
      finalUrl: ''
    })
    const setState = (
      status: BrowserTaskStatus,
      summary?: string,
      finalPage?: { url: string; title: string }
    ): void => {
      if (!ownsRun()) return
      currentStatus = status
      currentSummary = summary ?? ''
      const task = { taskId, journeyId, goal, status, summary, steps: [...steps] }
      const executionDevice = getTaskExecutionDevice()
      this.sessions.updateJourneyTask(journeyId, task)
      recordTaskRun({
        taskId,
        journeyId,
        kind: 'web_use',
        title: goal,
        status,
        summary,
        steps,
        executionDeviceId: executionDevice.id,
        executionDeviceName: executionDevice.name,
        lastUrl: finalPage?.url ?? record.chrome.url,
        lastTitle: finalPage?.title ?? record.chrome.title
      })
      broadcast('browser:task-state', {
        sessionId: record.sessionId,
        ...task
      } satisfies BrowserTaskState)
      this.broadcastSessions()
    }
    const recordStep = (note: string): void => {
      if (!ownsRun()) return
      steps.push(note)
      // The local array is the canonical trace for this run. Persist the full
      // trace so a checkpoint or concurrent history update cannot drop the
      // execution plan that was recorded before the first action.
      recordTaskRun({ taskId, journeyId, kind: 'web_use', title: goal, steps: [...steps] })
      const task = {
        taskId,
        journeyId,
        goal,
        status: currentStatus,
        summary: currentSummary,
        steps: [...steps]
      }
      this.sessions.updateJourneyTask(journeyId, task)
      broadcast('browser:task-state', {
        sessionId: record.sessionId,
        ...task
      } satisfies BrowserTaskState)
      broadcast('browser:step', { sessionId: record.sessionId, taskId, journeyId, note })
    }
    setState('running', 'Preparing the execution plan.')
    const queuedGuidance: string[] = [...(checkpoint?.guidance ?? [])]
    const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
      if (!ownsRun()) return false
      queuedGuidance.push(text)
      recordStep(TASK_GUIDANCE_TRACE)
      return true
    })

    try {
      let hostname: string | undefined
      try {
        hostname = start ? new URL(start).hostname.replace(/^www\./, '') : undefined
      } catch {
        hostname = undefined
      }
      // Start a known page immediately. Plan generation and page loading are
      // independent, so the user should not stare at a blank browser while the
      // model prepares milestones.
      const initialLoad = start
        ? this.loadNatively(view, start).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error })
          )
        : undefined
      const plan =
        checkpoint?.plan ??
        (await prepareTaskExecutionPlan(
          {
            goal: retryPlanningGoal(goal, checkpoint),
            surface: 'web',
            targetLabel: hostname,
            signal: owner.controller.signal
          },
          recordStep
        ))
      if (!ownsRun()) return replacedResult()
      setState('running', '')
      if (start) {
        const outcome = await initialLoad!
        if (!ownsRun()) return replacedResult()
        if (!outcome.ok) throw outcome.error
        this.refreshSession(record.sessionId)
        await this.restoreTaskPointer(record)
        if (!ownsRun()) return replacedResult()
        recordStep(`opened ${start}`)
      } else {
        this.refreshSession(record.sessionId)
        await this.restoreTaskPointer(record)
        if (!ownsRun()) return replacedResult()
        recordStep(`continued at ${record.chrome.url || 'the current page'}`)
      }
      const activePage = (): { view: WebContentsView; driver: BrowserDriver } => {
        const page = this.sessions.findJourney(journeyId) ?? record
        return { view: page.resource, driver: this.driverFor(page) }
      }

      // The model publishes cumulative text for the current step, then starts the
      // next step with an empty live event. Keep one transcript per task so a step
      // transition can never replace reasoning that the user has already seen.
      const reasoningByStep = new Map<number, string>()
      const reasoningStepOrder: number[] = []
      const reasoningTranscript = (reasoning: {
        step: number
        content: string
        live: boolean
      }): string => {
        const content = reasoning.content.trim()
        const previous = reasoningByStep.get(reasoning.step) ?? ''
        if (content) {
          if (!reasoningByStep.has(reasoning.step)) reasoningStepOrder.push(reasoning.step)
          if (!previous || content.startsWith(previous)) {
            reasoningByStep.set(reasoning.step, content)
          } else if (!previous.startsWith(content) && !previous.includes(content)) {
            reasoningByStep.set(reasoning.step, `${previous}\n\n${content}`)
          }
        }
        return reasoningStepOrder
          .map((step) => `### Step ${step}\n\n${reasoningByStep.get(step) ?? ''}`)
          .join('\n\n')
      }

      // Web Use is vision-only: capture, judge, persist evidence, then either
      // advance the milestone or choose one visual action. Never silently
      // replace this contract with semantic DOM control.
      const visual = await withActiveBrowserVision(async ({ selection, identity }) => {
        if (!ownsRun()) owner.controller.abort()
        owner.controller.signal.throwIfAborted()
        recordTaskRun({
          taskId,
          journeyId,
          kind: 'web_use',
          title: goal,
          ...identity
        })
        return runBrowserVisualTask({
          goal,
          taskId,
          journeyId,
          adapter: selection.adapter,
          guard,
          plan,
          // A retry must resume at the phase the failed attempt reached. Without this the runtime
          // restarted at phase 1 and redid the first milestone on every retry.
          ...(checkpoint?.steps?.length ? { resumedSteps: checkpoint.steps } : {}),
          activePage,
          waitForUser: async (why) => {
            if (!ownsRun()) return
            broadcast('browser:takeover', { sessionId: record.sessionId, taskId, why })
            setState('waiting', why)
            const outcome = await coordinator.waitForTakeover(taskId, why)
            if (!ownsRun()) return
            setState(outcome === 'resumed' ? 'running' : 'stopped', '')
            if (outcome !== 'resumed') guard.halt('cancelled by the user')
          },
          onStep: recordStep,
          onPhase: (phaseId) => recordStep(encodeTaskPhase(phaseId)),
          onProgress: (progress) => {
            if (!ownsRun()) return
            // reportTaskProgress persists only if this changes a durable fact (a pause, a stop);
            // the running steady state is coalesced display state.
            reportTaskProgress({
              taskId,
              journeyId,
              kind: 'web_use',
              title: goal,
              status:
                progress.phase === 'paused'
                  ? 'paused'
                  : progress.phase === 'stopped'
                    ? 'stopped'
                    : 'running',
              phase: progress.phase,
              currentStep: progress.step,
              currentAction: progress.action
            })
          },
          onReasoning: (reasoning) => {
            if (!ownsRun()) return
            const transcript = reasoningTranscript(reasoning)
            // The hot one: ~30 of these a second, each on screen for a frame.
            reportTaskProgress({
              taskId,
              journeyId,
              kind: 'web_use',
              title: goal,
              ...(transcript ? { currentReasoning: transcript } : {}),
              reasoningLive: reasoning.live
            })
          },
          takeGuidance: () => (ownsRun() ? queuedGuidance.splice(0) : []),
          signal: owner.controller.signal
        })
      })
      if (!ownsRun()) return replacedResult()
      const finalContents = activePage().view.webContents
      const finalUrl = finalContents.getURL()
      const finalTitle = finalContents.getTitle()
      const status = visual.ok ? 'done' : guard.isHalted ? 'stopped' : 'failed'
      setState(status, visual.summary, { url: finalUrl, title: finalTitle })
      return {
        ok: visual.ok,
        summary: visual.summary,
        steps: visual.steps,
        takeovers: visual.handoffs,
        finalUrl
      }
    } catch (error) {
      if (!ownsRun()) return replacedResult()
      if (guard.isHalted || owner.controller.signal.aborted) {
        const summary = guard.snapshot().reason || 'Stopped'
        recordStep(`stopped: ${summary}`)
        setState('stopped', summary)
        return {
          ok: false,
          summary,
          steps,
          takeovers: 0,
          finalUrl: record.resource.webContents.getURL()
        }
      }
      // A throw in setup/snapshot/CDP was silently disappearing (no step, no
      // result line) and read as a mystery failure. Surface it and return a
      // proper failed result so the engine sees an outcome, not an exception.
      const detail = error instanceof Error ? error.message : String(error)
      console.log(`[web-task] ERROR: ${detail}`)
      recordStep(`error: ${detail}`)
      await this.restoreTaskPointer(this.sessions.findJourney(journeyId) ?? record)
      if (!ownsRun()) return replacedResult()
      setState('failed', `Web Use stopped: ${detail}`)
      return {
        ok: false,
        summary: `Web Use stopped: ${detail}`,
        steps,
        takeovers: 0,
        finalUrl: ''
      }
    } finally {
      releaseGuidance()
      this.runOwners.release(owner)
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
  ipcMain.handle('browser:open-url', (_event, url: unknown) =>
    typeof url === 'string' ? browserHost().openUrl(url) : null
  )
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
  ipcMain.handle('browser:stop-task', (_event, taskId: unknown) =>
    typeof taskId === 'string' ? browserHost().stopTask(taskId) : false
  )
}
