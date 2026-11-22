/**
 * The browser rail's live host (R2-C3) - the Electron shell the pure pieces
 * plug into. It owns the WebContentsView that renders the watched page, the
 * journey-scoped Playwright MCP connection, the local step decider, the shared
 * task controller, and the step broadcasts to the watched pane.
 *
 * One chat journey owns independent pages, one page is active, and inactive
 * pages keep their state for later resume. Each page is an Electron
 * WebContentsView connected to task history, shared human-in-the-loop control,
 * and the watched SidePanel.
 *
 * This is native/Electron glue over isolated modules (relay, policy, semantic
 * loop, visible fallback driver, and executor adapter), so it
 * is excluded from in-process coverage like the other rail hosts - exercised
 * on a real display in the e2e tour and the real-machine pass, not here.
 */
import { BrowserWindow, WebContentsView, app, ipcMain, shell, type WebContents } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createBrowserVisionScreen } from './browser-vision-screen'
import {
  getActiveRemoteVisionServer,
  getRemoteVisionServerSettings
} from '../vision/remote-vision-server'
import { randomUUID } from 'node:crypto'
import {
  BrowserDriver,
  DEFAULT_BROWSER_POINTER,
  type BrowserPointerEvent,
  type CdpTransport
} from './browser-driver'
import { VisionGuard } from '../vision/vision-guard'
import {
  controlVisionTask,
  registerVisionSession,
  waitForVisionUser
} from '../vision/vision-controller'
import { getMainWindow } from '../main-window'
import type { BrowserRailHost, BrowserTaskRequest, WebTaskResult } from './browser-rail'
import {
  getTaskExecutionDevice,
  getTaskRun,
  recordTaskRun,
  reportTaskProgress
} from '../tasks/task-history'
import { getDB } from '../database'
import { registerTaskGuideHandler, TASK_GUIDANCE_TRACE } from '../tasks/task-guide'
import { BrowserHistoryStore } from './browser-history-store'
import { BrowserVisitsStore } from './browser-visits-store'
import { BrowserBookmarksStore } from './browser-bookmarks-store'
import { BrowserOpenTabsStore } from './browser-open-tabs-store'
import { BrowserDownloads } from './browser-downloads'
import { PERSONAL_BROWSER_PARTITION, prepareBrowserPartition } from './browser-partition'
import { attachPageMenu } from './browser-page-input'
import { browserShortcut, type BrowserShortcut } from './browser-shortcuts'
import { fillVaultLogin, hasLoginForm, vaultStateFor } from './browser-vault-fill'
import { READ_PASSWORD_VALUES_SCRIPT, scrubSecretValues } from './browser-secret-scrub'
import {
  sandboxAllows,
  sandboxPartition,
  sandboxProfile,
  sandboxProfiles,
  type SandboxProfile
} from './sandbox-profiles'
import { benchTrace } from './web-use-bench-trace'
import type {
  BrowserChromeCommand,
  BrowserFillOutcome,
  BrowserVaultState
} from '../../shared/browser-library'
import {
  BrowserSessionStore,
  historyViewSessionId,
  isHistoryViewSession,
  type BrowserSessionRecord
} from './browser-session-store'
import type {
  BrowserChromeState,
  BrowserControl,
  BrowserNavigationState,
  BrowserTaskPointer,
  BrowserTaskStatus
} from '../../shared/browser-session'
import {
  BROWSER_REGION_PRIORITY,
  fitWebUseDesktopRegion,
  isBrowserControl,
  isBrowserRegionOwner,
  webUseDesktopZoomFactor,
  type BrowserRegionOwner
} from '../../shared/browser-session'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { retryPlanningGoal, TASK_RETRY_TRACE } from '../tasks/task-retry'
import { runBrowserVisualTask, withActiveBrowserVision } from './browser-visual-task'
import { createBrowserSemanticEvidenceRecorder } from './browser-semantic-evidence'
import { BrowserJourneyRunOwners } from './browser-run-owners'
import { ElectronPlaywrightRelay } from './electron-playwright-relay'
import { PlaywrightMcpSession } from './playwright-mcp-session'
import { runBrowserPlaywrightTask } from './browser-playwright-task'
import { captureBrowserAgentFrame, runBrowserAgentTask } from './browser-agent-task'
import { automationTaskReadStatus, isAutomationTaskTerminal } from '@offgrid/automation'
import { getWebUseSettings } from '../web-use-settings'
import { currentRemoteScreenTaskSession } from '../actions/remote-screen-session'
import {
  activeModelProjectionIdentity,
  getWebUseActiveModelProjection
} from '../vision/vision-task-model-strategy'

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
  /** Every visit, searchable (the History panel), and each task's own trail. */
  private readonly visits = new BrowserVisitsStore(getDB())
  private readonly bookmarks = new BrowserBookmarksStore(getDB())
  private readonly openTabs = new BrowserOpenTabsStore(getDB())
  private readonly downloads = new BrowserDownloads(
    () => app.getPath('downloads'),
    (list) => broadcast('browser:downloads-state', list)
  )
  /** The page each session last recorded, so a repaint is not a second visit. */
  private readonly lastVisit = new Map<string, { url: string; visitId: number | null }>()
  /** The person's closed tabs, newest last, for Reopen closed tab. */
  private readonly closedTabs: string[] = []
  /** Secrets the Vault filled per journey: masked out of everything the models read. */
  private readonly filledSecrets = new Map<string, Set<string>>()
  /** Pages the agent already tried to sign in on, per journey: one autofill per address. */
  private readonly autofillTried = new Map<string, Set<string>>()
  private readonly userMuted = new WeakSet<WebContentsView>()
  private restoringTabs = false
  /** Disposing closes every page; that must not erase the tabs to reopen next launch. */
  private quitting = false
  private readonly runOwners = new BrowserJourneyRunOwners()
  private readonly taskPointers = new Map<string, BrowserPointerEvent>()
  private readonly pointerRestorations = new Map<string, Promise<boolean>>()
  private region: Rect | null = null
  /** Latest rect per hosting surface. The painted region is the highest-priority entry present. */
  private readonly regions = new Map<BrowserRegionOwner, Rect>()
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
    this.visits.migrate()
    this.bookmarks.migrate()
    this.openTabs.migrate()
    const saved = this.openTabs.list()
    // After construction: restoring creates sessions through this host.
    if (saved.length) queueMicrotask(() => this.restoreOpenTabs(saved))
  }

  private broadcastSessions(): void {
    broadcast('browser:sessions-state', this.sessions.snapshot())
    this.saveOpenTabs()
  }

  /** The person's tabs, so the next launch opens them again. Task pages are not kept. */
  private saveOpenTabs(): void {
    if (this.restoringTabs || this.quitting) return
    const snapshot = this.sessions.snapshot()
    this.openTabs.save(
      snapshot.sessions
        .filter((session) => session.kind === 'manual' && session.historyId && !session.profileId)
        .map((session) => ({
          historyId: session.historyId!,
          active: session.sessionId === snapshot.activeSessionId
        }))
    )
  }

  private restoreOpenTabs(saved: ReturnType<BrowserOpenTabsStore['list']>): void {
    this.restoringTabs = true
    let active: string | null = null
    try {
      for (const tab of saved) {
        const opened = this.reopenManual(tab.historyId)
        if (opened && tab.active) active = opened.sessionId
      }
      if (active) this.activateSession(active)
    } finally {
      this.restoringTabs = false
      this.saveOpenTabs()
    }
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
      },
      initialPointer: pointer
    })
  }

  private async restoreTaskPointer(
    record: BrowserSessionRecord<WebContentsView>
  ): Promise<boolean> {
    if (record.kind !== 'task' || record.resource.webContents.isDestroyed()) return false
    const existing = this.pointerRestorations.get(record.sessionId)
    if (existing) return existing
    const restoration = this.driverFor(record)
      .verifyPointer(true)
      .finally(() => {
        if (this.pointerRestorations.get(record.sessionId) === restoration) {
          this.pointerRestorations.delete(record.sessionId)
        }
      })
    this.pointerRestorations.set(record.sessionId, restoration)
    return restoration
  }

  private readChrome(record: BrowserSessionRecord<WebContentsView>): BrowserChromeState {
    const contents = record.resource.webContents
    if (contents.isDestroyed()) return record.chrome
    const navigationHistory = contents.navigationHistory
    const url = contents.getURL()
    return {
      url,
      title: contents.getTitle() || 'New tab',
      ...(record.chrome.faviconUrl ? { faviconUrl: record.chrome.faviconUrl } : {}),
      canGoBack: navigationHistory.canGoBack(),
      canGoForward: navigationHistory.canGoForward(),
      isLoading: contents.isLoading(),
      audible: contents.isCurrentlyAudible(),
      muted: this.userMuted.has(record.resource),
      bookmarked: /^https?:\/\//i.test(url) && this.bookmarks.has(url),
      ...(record.chrome.profileId ? { profileId: record.chrome.profileId } : {})
    }
  }

  /** One history row per address a page shows; a later title only renames it. */
  private noteVisit(
    record: BrowserSessionRecord<WebContentsView>,
    chrome: BrowserChromeState
  ): void {
    if (isHistoryViewSession(record.sessionId) || !/^https?:\/\//i.test(chrome.url)) return
    const last = this.lastVisit.get(record.sessionId)
    if (last?.url === chrome.url) {
      if (last.visitId !== null && chrome.title && chrome.title !== 'New tab') {
        this.visits.retitle(last.visitId, chrome.title)
      }
      return
    }
    const visitId = this.visits.record({
      url: chrome.url,
      title: chrome.title === 'New tab' ? '' : chrome.title,
      ...(record.task ? { taskId: record.task.taskId } : {})
    })
    this.lastVisit.set(record.sessionId, { url: chrome.url, visitId })
  }

  private refreshSession(sessionId: string): void {
    const record = this.sessions.get(sessionId)
    if (!record) return
    const chrome = this.readChrome(record)
    this.sessions.updateChrome(sessionId, chrome)
    this.noteVisit(record, chrome)
    if (record.task) {
      if (!isHistoryViewSession(record.sessionId)) {
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
      }
    } else if (/^https?:\/\//i.test(chrome.url) && !record.chrome.profileId) {
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
      view.webContents.setAudioMuted(!visible || this.userMuted.has(view))
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

  /** Replace every live page for a journey before a retry or after its renderer
   * stops answering CDP. Task history and the plan stay durable; only the old
   * browser process is discarded. */
  private recreateJourneySession(
    record: BrowserSessionRecord<WebContentsView>
  ): BrowserSessionRecord<WebContentsView> {
    const journeyId = record.journeyId
    const task = record.task
    if (!journeyId || !task) return record
    const rootSessionId = record.parentSessionId
      ? (this.sessions.journeyRecords(journeyId).find((page) => !page.parentSessionId)?.sessionId ??
        `journey:${journeyId}`)
      : record.sessionId
    for (const page of this.sessions.journeyRecords(journeyId)) {
      const closed = this.sessions.close(page.sessionId)
      if (!closed) continue
      this.taskPointers.delete(page.sessionId)
      this.pointerRestorations.delete(page.sessionId)
      this.destroyView(closed.resource)
    }
    return this.createSession({
      sessionId: rootSessionId,
      kind: 'task',
      journeyId,
      task
    })
  }

  /** Keep the current result page available, but release completed Web Use
   * renderers from older journeys before a new live preview starts. History can
   * recreate those pages from its saved URL when the user opens them again. */
  private releaseRetainedTaskViews(activeJourneyId: string): void {
    let changed = false
    for (const snapshot of this.sessions.snapshot().sessions) {
      if (
        snapshot.kind !== 'task' ||
        snapshot.journeyId === activeJourneyId ||
        snapshot.status === 'open' ||
        !isAutomationTaskTerminal(snapshot.status)
      ) {
        continue
      }
      const closed = this.sessions.close(snapshot.sessionId)
      if (!closed) continue
      changed = true
      this.taskPointers.delete(snapshot.sessionId)
      this.destroyView(closed.resource)
    }
    if (!changed) return
    this.syncViewVisibility()
    this.broadcastSessions()
  }

  dispose(): void {
    // Closing every page on the way out is not the person closing their tabs: keep the list.
    this.saveOpenTabs()
    this.quitting = true
    this.region = null
    this.runOwners.haltAll('browser host closed')
    this.taskPointers.clear()
    this.pointerRestorations.clear()
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

  /**
   * Record where one surface can host the page, and repaint into whichever surface now wins.
   *
   * Keyed by owner rather than last-write-wins, because two surfaces legitimately report during a
   * handover and their order is not controllable: the arriving one mounts before the departing one
   * cleans up. Keeping a rect per owner makes those two messages commute - a release from a surface
   * that no longer owns the region cannot blank the surface that does.
   */
  setRegion(owner: BrowserRegionOwner, rect: Rect | null): void {
    if (rect) {
      this.regions.set(owner, fitWebUseDesktopRegion(rect))
    } else {
      this.regions.delete(owner)
    }
    this.region = this.winningRegion()
    this.syncViewVisibility()
  }

  private winningRegion(): Rect | null {
    let winner: { rect: Rect; priority: number } | null = null
    for (const [owner, rect] of this.regions) {
      const priority = BROWSER_REGION_PRIORITY[owner]
      if (!winner || priority > winner.priority) winner = { rect, priority }
    }
    return winner?.rect ?? null
  }

  /** The partition a page lives in: the person's own, or a sandbox profile's fenced one. */
  private partitionFor(profile: SandboxProfile | undefined): string {
    const partition = profile ? sandboxPartition(profile) : PERSONAL_BROWSER_PARTITION
    const session = prepareBrowserPartition(
      partition,
      {
        isTaskPage: (contents) => this.isTaskContents(contents),
        attachDownloads: (target) => this.downloads.attach(target)
      },
      profile?.hosts ?? []
    )
    if (profile) this.fenceProfile(session, profile)
    return partition
  }

  private readonly fenced = new WeakSet<Electron.Session>()

  /** A sandbox profile opens only its own sites, whoever asks: page, popup, agent or person. */
  private fenceProfile(session: Electron.Session, profile: SandboxProfile): void {
    if (this.fenced.has(session)) return
    this.fenced.add(session)
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const blocked =
        (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') &&
        !sandboxAllows(profile, details.url)
      callback({ cancel: blocked })
    })
  }

  private isTaskContents(contents: WebContents): boolean {
    for (const session of this.sessions.snapshot().sessions) {
      const live = this.sessions.get(session.sessionId)
      if (live?.resource.webContents === contents) return live.kind === 'task'
    }
    return false
  }

  private createSession(input: {
    sessionId: string
    historyId?: string
    kind: 'manual' | 'task'
    journeyId?: string
    parentSessionId?: string
    task?: BrowserTaskPointer
    /** A sandbox test profile (sandbox-profiles.ts). */
    profileId?: string
    /** A popup's own contents, adopted so window.opener (sign-in popups) keeps working. */
    adopt?: WebContents
  }): BrowserSessionRecord<WebContentsView> {
    const { profileId, adopt, ...identity } = input
    const profile = sandboxProfile(profileId)
    const view = new WebContentsView({
      ...(adopt ? { webContents: adopt } : {}),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        partition: this.partitionFor(profile),
        backgroundThrottling: false
      }
    })
    const win = getMainWindow()
    win?.contentView.addChildView(view)
    const record = this.sessions.create({ ...identity, resource: view })
    if (profile) {
      this.sessions.updateChrome(record.sessionId, { ...record.chrome, profileId: profile.id })
    }
    this.wirePage(record)
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
      // A web page or a blank one a script fills in (OAuth sign-in popups do both). It opens as
      // a tab of this page that keeps window.opener, so the sign-in can report back and close.
      if (url !== '' && url !== 'about:blank' && !normalizeBrowserAddress(url)) {
        return { action: 'deny' }
      }
      if (!/^(https?:\/\/|about:blank$|$)/i.test(url)) return { action: 'deny' }
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents
          const child = this.createSession({
            sessionId: randomUUID(),
            ...(record.kind === 'manual' ? { historyId: randomUUID() } : {}),
            kind: record.kind,
            journeyId: record.journeyId,
            parentSessionId: record.sessionId,
            task: record.task,
            profileId: record.chrome.profileId,
            ...(guest ? { adopt: guest } : {})
          })
          this.activateSession(child.sessionId)
          if (!guest && /^https?:\/\//i.test(url)) void this.loadNatively(child.resource, url)
          return child.resource.webContents
        }
      }
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

  /** The page's own browser behaviour: shortcuts, right-click menu, find, sound, closing. */
  private wirePage(record: BrowserSessionRecord<WebContentsView>): void {
    const contents = record.resource.webContents
    attachPageMenu(contents, {
      openInNewTab: (url) => void this.openTabFrom(record, url),
      download: (url) => contents.downloadURL(url)
    })
    contents.on('before-input-event', (event, input) => {
      // A running task's keys are the agent's (CDP input); its pane belongs to the task.
      if (record.kind === 'task' && record.task?.status === 'running') return
      const shortcut = browserShortcut(input, process.platform)
      if (!shortcut) return
      event.preventDefault()
      this.runShortcut(record.sessionId, shortcut)
    })
    contents.on('found-in-page', (_event, result) => {
      broadcast('browser:find-result', {
        sessionId: record.sessionId,
        activeMatch: result.activeMatchOrdinal,
        matches: result.matches
      })
    })
    contents.on('audio-state-changed', () => this.refreshSession(record.sessionId))
    // window.close() from the page (a finished sign-in popup) ends its tab.
    contents.once('destroyed', () => {
      if (this.sessions.get(record.sessionId)?.resource !== record.resource) return
      this.sessions.close(record.sessionId)
      this.lastVisit.delete(record.sessionId)
      this.taskPointers.delete(record.sessionId)
      try {
        getMainWindow()?.contentView.removeChildView(record.resource)
      } catch {
        /* window already gone */
      }
      this.syncViewVisibility()
      this.broadcastSessions()
    })
  }

  private runShortcut(sessionId: string, shortcut: BrowserShortcut): void {
    const command = (name: BrowserChromeCommand): void =>
      broadcast('browser:command', { sessionId, command: name })
    switch (shortcut.kind) {
      case 'new-tab': {
        const opened = this.newTab(this.sessions.get(sessionId)?.journeyId)
        broadcast('browser:command', { sessionId: opened.sessionId, command: 'focus-address' })
        return
      }
      case 'close-tab':
        this.closeSession(sessionId)
        return
      case 'reopen-closed-tab':
        this.reopenClosedTab()
        return
      case 'back':
      case 'forward':
      case 'devtools':
      case 'print':
        this.control(shortcut.kind, sessionId)
        return
      case 'reload': {
        const contents = this.sessions.get(sessionId)?.resource.webContents
        if (shortcut.hard) contents?.reloadIgnoringCache()
        else contents?.reload()
        return
      }
      case 'bookmark':
        this.toggleBookmark(sessionId)
        return
      case 'next-tab':
      case 'previous-tab':
        this.cycleTab(sessionId, shortcut.kind === 'next-tab' ? 1 : -1)
        return
      case 'chrome':
        command(shortcut.command)
        return
    }
  }

  /** The person's open tabs, in order: what next/previous tab moves through. */
  private cycleTab(sessionId: string, step: number): void {
    const current = this.sessions.get(sessionId)
    const tabs = this.sessions
      .snapshot()
      .sessions.filter((session) =>
        current?.kind === 'task'
          ? session.journeyId === current.journeyId
          : session.kind === 'manual'
      )
    const index = tabs.findIndex((tab) => tab.sessionId === sessionId)
    if (index < 0 || tabs.length < 2) return
    const next = tabs[(index + step + tabs.length) % tabs.length]
    if (next) this.activateSession(next.sessionId)
  }

  /** "Open Link in New Tab": a tab of its own for the person, a page of the journey for a task. */
  private async openTabFrom(
    parent: BrowserSessionRecord<WebContentsView>,
    url: string
  ): Promise<void> {
    const target = normalizeBrowserAddress(url)
    if (!target) return
    if (parent.kind === 'task') {
      await this.openManagedPage(parent, target)
      return
    }
    const opened = this.newTab(parent.journeyId)
    await this.navigate(target, opened.sessionId)
  }

  /** A site-requested page is a managed child tab. It keeps the parent's chat
   * journey and task trace, while the + button remains the only manual-tab path. */
  private async openManagedPage(
    parent: BrowserSessionRecord<WebContentsView>,
    target: string
  ): Promise<BrowserSessionRecord<WebContentsView>> {
    const sessionId = randomUUID()
    const child = this.createSession({
      sessionId,
      ...(parent.kind === 'manual' ? { historyId: sessionId } : {}),
      kind: parent.kind,
      journeyId: parent.journeyId,
      parentSessionId: parent.sessionId,
      task: parent.task,
      profileId: parent.chrome.profileId
    })
    this.activateSession(child.sessionId)
    try {
      await this.loadNatively(child.resource, target)
      this.refreshSession(child.sessionId)
    } catch {
      this.refreshSession(child.sessionId)
    }
    return child
  }

  newTab(journeyId?: string): { sessionId: string } {
    const sessionId = randomUUID()
    const record = this.createSession({
      sessionId,
      historyId: sessionId,
      kind: 'manual',
      ...(journeyId ? { journeyId } : {})
    })
    return { sessionId: record.sessionId }
  }

  /** Open a Chat link as a normal manual page. This is deliberately separate
   * from runTask: reading a source must never start Web Use automation. */
  async openUrl(url: string, journeyId?: string): Promise<{ sessionId: string } | null> {
    if (!/^https?:\/\//i.test(url)) return null
    const target = normalizeBrowserAddress(url)
    if (!target) return null
    const opened = this.newTab(journeyId)
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

  /** Closes every page of a journey (its task page and the tabs it opened). */
  closeJourney(journeyId: string): void {
    for (const record of [...this.sessions.journeyRecords(journeyId)]) {
      const closed = this.sessions.close(record.sessionId)
      if (!closed) continue
      this.taskPointers.delete(record.sessionId)
      this.destroyView(closed.resource)
    }
    this.syncViewVisibility()
    this.broadcastSessions()
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
    if (closed.kind === 'manual' && closed.historyId && !closed.chrome.profileId) {
      this.closedTabs.push(closed.historyId)
      if (this.closedTabs.length > 25) this.closedTabs.shift()
    }
    this.lastVisit.delete(sessionId)
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
    } else if (action === 'devtools') {
      // Its own window: the page's pane stays the page, at the size the agent sees.
      if (contents.isDevToolsOpened()) contents.closeDevTools()
      else contents.openDevTools({ mode: 'detach', activate: true })
    } else if (action === 'print') {
      contents.print({}, () => undefined)
    } else if (action === 'mute') {
      if (this.userMuted.has(record.resource)) this.userMuted.delete(record.resource)
      else this.userMuted.add(record.resource)
      contents.setAudioMuted(this.userMuted.has(record.resource) || !this.isShown(record))
    } else {
      return false
    }
    this.refreshSession(record.sessionId)
    return true
  }

  private isShown(record: BrowserSessionRecord<WebContentsView>): boolean {
    return this.sessions.active?.sessionId === record.sessionId && Boolean(this.region)
  }

  /** Bring back the person's most recently closed tab (Cmd/Ctrl+Shift+T). */
  reopenClosedTab(): { sessionId: string } | null {
    const historyId = this.closedTabs.pop()
    return historyId ? this.reopenManual(historyId) : null
  }

  // History, bookmarks, downloads, find and the Vault: the browser beyond the page.

  searchHistory(query: string, before?: number): ReturnType<BrowserVisitsStore['search']> {
    return this.visits.search(query, before)
  }

  removeHistory(visitId: number): void {
    this.visits.remove(visitId)
  }

  clearHistory(since?: number): void {
    this.visits.clear(since)
    this.lastVisit.clear()
  }

  listBookmarks(): ReturnType<BrowserBookmarksStore['list']> {
    return this.bookmarks.list()
  }

  /** Bookmark the page, or remove it: the star. Returns whether it is bookmarked now. */
  toggleBookmark(sessionId?: string): boolean {
    const record = sessionId ? this.sessions.get(sessionId) : this.sessions.active
    if (!record) return false
    const on = this.bookmarks.toggle({ url: record.chrome.url, title: record.chrome.title })
    this.refreshSession(record.sessionId)
    broadcast('browser:bookmarks-changed', this.bookmarks.list())
    return on
  }

  removeBookmark(bookmarkId: string): void {
    this.bookmarks.remove(bookmarkId)
    for (const session of this.sessions.snapshot().sessions) this.refreshSession(session.sessionId)
    broadcast('browser:bookmarks-changed', this.bookmarks.list())
  }

  renameBookmark(bookmarkId: string, title: string): void {
    this.bookmarks.rename(bookmarkId, title)
    broadcast('browser:bookmarks-changed', this.bookmarks.list())
  }

  listDownloads(): ReturnType<BrowserDownloads['list']> {
    return this.downloads.list()
  }

  downloadAction(
    downloadId: string,
    action: 'cancel' | 'pause' | 'resume' | 'open' | 'show' | 'clear'
  ): boolean {
    if (action === 'clear') {
      this.downloads.clearFinished()
      return true
    }
    if (action === 'cancel') this.downloads.cancel(downloadId)
    else if (action === 'pause') this.downloads.pause(downloadId)
    else if (action === 'resume') this.downloads.resume(downloadId)
    else {
      const file = this.downloads.savedPath(downloadId)
      if (!file) return false
      if (action === 'open') void shell.openPath(file)
      else shell.showItemInFolder(file)
    }
    return true
  }

  /** Find on the page. An empty query clears the highlights. */
  find(sessionId: string, query: string, forward = true, findNext = false): void {
    const contents = this.sessions.get(sessionId)?.resource.webContents
    if (!contents || contents.isDestroyed()) return
    if (!query) {
      contents.stopFindInPage('clearSelection')
      return
    }
    // Electron's `findNext` starts a NEW find session; stepping through matches passes false.
    contents.findInPage(query, { forward, findNext: !findNext })
  }

  stopFind(sessionId: string): void {
    const contents = this.sessions.get(sessionId)?.resource.webContents
    if (contents && !contents.isDestroyed()) contents.stopFindInPage('keepSelection')
  }

  async vaultState(sessionId?: string): Promise<BrowserVaultState> {
    const record = sessionId ? this.sessions.get(sessionId) : this.sessions.active
    if (!record || record.resource.webContents.isDestroyed()) return { state: 'none' }
    return vaultStateFor(record.resource.webContents.getURL())
  }

  /** The key button: fill a Vault login into the page. The renderer never sees the password. */
  async fillLogin(sessionId: string, uuid: string): Promise<BrowserFillOutcome> {
    const record = this.sessions.get(sessionId)
    if (!record || record.resource.webContents.isDestroyed()) {
      return { ok: false, reason: 'no_form' }
    }
    return fillVaultLogin(record.resource.webContents, uuid, (secret) =>
      this.rememberSecret(record.journeyId ?? record.sessionId, secret)
    )
  }

  private rememberSecret(scope: string, secret: string): void {
    const set = this.filledSecrets.get(scope) ?? new Set<string>()
    set.add(secret)
    this.filledSecrets.set(scope, set)
  }

  /** Mask every password the journey's pages hold, and every secret the Vault filled. */
  private async scrubJourney(journeyId: string, text: string): Promise<string> {
    const secrets = new Set(this.filledSecrets.get(journeyId) ?? [])
    for (const page of this.sessions.journeyRecords(journeyId)) {
      const contents = page.resource.webContents
      if (contents.isDestroyed()) continue
      for (const frame of contents.mainFrame.framesInSubtree) {
        const values = (await frame
          .executeJavaScript(READ_PASSWORD_VALUES_SCRIPT)
          .catch(() => [])) as unknown
        if (Array.isArray(values)) {
          for (const value of values) if (typeof value === 'string') secrets.add(value)
        }
      }
    }
    return secrets.size ? scrubSecretValues(text, secrets) : text
  }

  /**
   * The agent's sign-in: when the page shows a login form and the Vault holds exactly one login
   * for the site, fill it. Several logins are the person's choice, so the agent is told to ask.
   */
  private async agentAutofill(journeyId: string): Promise<string | null> {
    const page = this.sessions.findJourney(journeyId)
    const contents = page?.resource.webContents
    if (!page || !contents || contents.isDestroyed()) return null
    const url = contents.getURL()
    const tried = this.autofillTried.get(journeyId) ?? new Set<string>()
    this.autofillTried.set(journeyId, tried)
    if (tried.has(url) || !(await hasLoginForm(contents))) return null
    tried.add(url)
    const state = await vaultStateFor(url)
    const host = new URL(url).host
    if (state.state === 'locked') return `the Vault is locked, so it could not sign in on ${host}`
    if (state.state !== 'available') return null
    if (state.logins.length > 1) {
      return `the Vault has ${state.logins.length} logins for ${host}; ask which one to use`
    }
    const login = state.logins[0]!
    const outcome = await fillVaultLogin(contents, login.uuid, (secret) =>
      this.rememberSecret(journeyId, secret)
    )
    return outcome.ok ? `the Vault filled the login for ${host} as ${outcome.username}` : null
  }

  /** Files the agent may upload: the task uploads folder only, never the rest of the disk. */
  private uploadPath(name: string): string | null {
    const folder = path.join(app.getPath('userData'), 'agent-uploads')
    mkdirSync(folder, { recursive: true })
    const file = path.join(folder, path.basename(name.trim()))
    return name.trim() && existsSync(file) ? file : null
  }

  listSandboxProfiles(): ReturnType<typeof sandboxProfiles> {
    return sandboxProfiles()
  }

  /** Open a sandbox profile's start page in a tab of its own, to sign in to its test account. */
  async openSandboxProfile(profileId: string): Promise<{ sessionId: string } | null> {
    const profile = sandboxProfile(profileId)
    if (!profile) return null
    const sessionId = randomUUID()
    this.createSession({ sessionId, historyId: sessionId, kind: 'manual', profileId })
    this.activateSession(sessionId)
    const record = this.sessions.get(sessionId)
    if (record) await this.loadNatively(record.resource, profile.startUrl)
    this.refreshSession(sessionId)
    return { sessionId }
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
      // A live task without a local page may belong to the paired browser. Opening its
      // details must not allocate a second browser view or navigate a duplicate page.
      if (['running', 'paused', 'waiting', 'reconnecting'].includes(saved.status)) return false
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
        sessionId: historyViewSessionId(task.taskId),
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
    const profile = sandboxProfile(request.profileId)
    if (request.profileId && !profile) {
      return {
        ok: false,
        summary: `No sandbox profile named ${request.profileId}.`,
        steps: [],
        takeovers: 0,
        finalUrl: ''
      }
    }
    const taskModelIdentityPromise = getWebUseActiveModelProjection()
      .then(activeModelProjectionIdentity)
      .catch((error: unknown) => {
        console.warn('[web-use] could not resolve the active model identity', error)
        return undefined
      })
    this.releaseRetainedTaskViews(journeyId)
    let existingRecord = this.sessions.findJourney(journeyId)
    const continuingJourney = Boolean(existingRecord)
    const retryingJourney = Boolean(existingRecord && checkpoint)
    const continuationUrl =
      existingRecord?.resource.webContents.getURL() || existingRecord?.chrome.url
    // A retry must not inherit the renderer that caused the previous failure.
    // The checkpoint restores task progress after a fresh page loads.
    if (existingRecord && checkpoint) {
      existingRecord = this.recreateJourneySession(existingRecord)
    }
    let record =
      existingRecord ??
      this.createSession({
        sessionId: `journey:${journeyId}`,
        kind: 'task',
        journeyId,
        task: { taskId, journeyId, goal, status: 'running', steps: [] },
        ...(profile ? { profileId: profile.id } : {})
      })
    this.activateSession(record.sessionId)
    const view = record.resource
    // A web task with no start URL would begin on a blank pane (no page to act
    // on, and snapshotting about:blank can hang) - default to a real search page
    // so the model always has somewhere to start and can navigate from there.
    const start =
      url ??
      (profile && !continuingJourney ? profile.startUrl : undefined) ??
      explicitBrowserAddress(goal) ??
      (retryingJourney
        ? continuationUrl || 'https://www.google.com'
        : continuingJourney
          ? undefined
          : 'https://www.google.com')
    // The log holds metadata only: never the task the user typed or the page it starts on.
    console.log(`[web-use] runTask goal=${goal.length} chars`)

    // The browser rail's surface is the in-app watched pane (browser:*), which
    // shows the live page + step feed inline - so NO floating supervisor window
    // here (that is for the AX/vision rails, whose driven surface is OUTSIDE the
    // app). The VisionGuard is still registered so the pane's Stop / close halts
    // the loop through the vision:control seam.
    const guard = new VisionGuard({ taskId, kind: 'web_use' })
    const ownership = this.runOwners.replace(journeyId, taskId, guard)
    const owner = ownership.owner
    if (ownership.replaced) {
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
    let releaseSession = (): void => undefined
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
    const taskModelIdentity = await taskModelIdentityPromise
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
        ...(taskModelIdentity ?? {}),
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
    if (request.notice) recordStep(request.notice)
    releaseSession = registerVisionSession(
      taskId,
      guard,
      owner.controller,
      (_snapshot, status, currentAction) => setState(status, currentAction)
    )
    setState('running', 'Preparing the execution plan.')
    const queuedGuidance: string[] = [...(checkpoint?.guidance ?? [])]
    const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
      if (!ownsRun()) return false
      queuedGuidance.push(text)
      recordStep(TASK_GUIDANCE_TRACE)
      controlVisionTask('resume', taskId)
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
      // The planner_actor_evaluator strategy plans with its own planner model; the stages the
      // task shows are that plan (browser-agent-task.ts), not a chat-model plan made first.
      const agentPlanning =
        (currentRemoteScreenTaskSession()?.modelStrategy ?? getWebUseSettings().modelStrategy) ===
        'planner_actor_evaluator'
      const plan =
        checkpoint?.plan ??
        (agentPlanning ? { version: 1 as const, phases: [] } : undefined) ??
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
        if (!(await this.restoreTaskPointer(record))) {
          console.warn('[web-use] browser renderer stopped responding; replacing session')
          record = this.recreateJourneySession(record)
          await this.loadNatively(record.resource, start)
          this.refreshSession(record.sessionId)
          if (!(await this.restoreTaskPointer(record))) {
            throw new Error('The browser page did not respond after session recovery.')
          }
          recordStep('recovered the browser session after it stopped responding')
        }
        if (!ownsRun()) return replacedResult()
        recordStep(`opened ${start}`)
      } else {
        this.refreshSession(record.sessionId)
        if (!(await this.restoreTaskPointer(record))) {
          console.warn('[web-use] browser renderer stopped responding; replacing session')
          const resumeUrl = record.chrome.url || 'https://www.google.com'
          record = this.recreateJourneySession(record)
          await this.loadNatively(record.resource, resumeUrl)
          this.refreshSession(record.sessionId)
          if (!(await this.restoreTaskPointer(record))) {
            throw new Error('The browser page did not respond after session recovery.')
          }
          recordStep('recovered the browser session after it stopped responding')
        }
        if (!ownsRun()) return replacedResult()
        recordStep(`continued at ${record.chrome.url || 'the current page'}`)
      }
      const activePage = (): { view: WebContentsView; driver: BrowserDriver } => {
        const page = this.sessions.findJourney(journeyId) ?? record
        return { view: page.resource, driver: this.driverFor(page) }
      }
      const semanticScreen = createBrowserVisionScreen({
        goal,
        taskId,
        journeyId,
        activePage,
        settings: getWebUseSettings()
      })
      const recordSemanticEvidence = createBrowserSemanticEvidenceRecorder({
        goal,
        taskId,
        journeyId,
        activePage
      })

      const relay = new ElectronPlaywrightRelay({
        pages: () =>
          this.sessions
            .journeyRecords(journeyId)
            .flatMap((page) =>
              page.resource.webContents.isDestroyed()
                ? []
                : [{ id: page.resource.webContents.id, contents: page.resource.webContents }]
            ),
        create: async (target) => {
          const parent = this.sessions.findJourney(journeyId) ?? record
          const page = await this.openManagedPage(parent, target)
          return { id: page.resource.webContents.id, contents: page.resource.webContents }
        },
        close: async (contentsId) => {
          const page = this.sessions
            .journeyRecords(journeyId)
            .find((candidate) => candidate.resource.webContents.id === contentsId)
          if (page?.parentSessionId) this.closeSession(page.sessionId)
        }
      })
      // Every snapshot and tool result passes the password scrub before a model reads it.
      const playwright = new PlaywrightMcpSession(relay, undefined, (text) =>
        this.scrubJourney(journeyId, text)
      )

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

      const runBrowserRails = async (): Promise<{
        semantic: Awaited<ReturnType<typeof runBrowserPlaywrightTask>>
        visual: Awaited<ReturnType<typeof runBrowserVisualTask>>
      }> => {
        const semantic = await (async () => {
          try {
            await playwright.connect()
          } catch (error) {
            if (owner.controller.signal.aborted) throw owner.controller.signal.reason ?? error
            const detail = error instanceof Error ? error.message : String(error)
            return {
              ok: false,
              fallback: true,
              summary: `Playwright semantic control was unavailable: ${detail}`,
              handoffs: 0
            }
          }
          const semanticInput: Parameters<typeof runBrowserPlaywrightTask>[0] = {
            goal,
            plan,
            session: playwright,
            guard,
            activeDriver: () => activePage().driver,
            activeUrl: () => activePage().view.webContents.getURL(),
            waitForUser: async (why, signal) => {
              if (!ownsRun()) return
              await waitForVisionUser(taskId, why, signal)
            },
            takeGuidance: () => (ownsRun() ? queuedGuidance.splice(0) : []),
            onStep: recordStep,
            onPhase: (phaseId) => recordStep(encodeTaskPhase(phaseId)),
            onProgress: (currentStep, phase, action) => {
              if (!ownsRun()) return
              reportTaskProgress({
                taskId,
                journeyId,
                kind: 'web_use',
                title: goal,
                status: 'running',
                phase,
                currentStep,
                currentAction: action
              })
            },
            captureObservationImage: async () => {
              // The semantic route has selected its model before entering this loop.
              // Keep existing text-only model and extension behavior unchanged.
              const { llm } = await import('../llm')
              const session = currentRemoteScreenTaskSession()
              const remote = session ? session.activeServer : getActiveRemoteVisionServer()
              if (remote) {
                const saved = getRemoteVisionServerSettings().servers.find(
                  (server) =>
                    server.id === remote.id &&
                    server.enabled !== false &&
                    server.endpoint === remote.endpoint
                )
                const supportsImages = saved?.modelCatalog?.some(
                  (model) => model.id === remote.model && model.inputModalities?.includes('image')
                )
                return saved?.screenFramesAllowed && supportsImages
                  ? semanticScreen.capture()
                  : undefined
              }
              return llm.hasVision() ? semanticScreen.capture() : undefined
            },
            onObservation: recordSemanticEvidence,
            sandboxProfile: Boolean(profile),
            signal: owner.controller.signal
          }
          const webUse = getWebUseSettings()
          const agentStrategy =
            (currentRemoteScreenTaskSession()?.modelStrategy ?? webUse.modelStrategy) ===
            'planner_actor_evaluator'
          return agentStrategy
            ? runBrowserAgentTask({
                ...semanticInput,
                models: webUse.agentModels,
                screenshot: () => captureBrowserAgentFrame(activePage().view, activePage().driver),
                browser: {
                  autofill: () => this.agentAutofill(journeyId),
                  visits: (address) =>
                    this.visits.taskTrail(taskId).filter((visit) => visit.url === address).length,
                  showTab: (index) => {
                    const page = this.sessions.journeyRecords(journeyId)[index]
                    if (page) this.activateSession(page.sessionId)
                  },
                  uploadPath: (name) => this.uploadPath(name)
                }
              })
            : runBrowserPlaywrightTask(semanticInput)
        })().finally(() => playwright.close())

        // Vision remains a bounded fallback for canvas, maps, remote desktops,
        // and pages that do not publish useful accessibility semantics.
        const visual = semantic.fallback
          ? await withActiveBrowserVision(async ({ selection, identity, decide }) => {
              recordStep(`visual fallback: ${semantic.summary}`)
              if (!ownsRun()) owner.controller.abort()
              owner.controller.signal.throwIfAborted()
              recordTaskRun({ taskId, journeyId, kind: 'web_use', title: goal, ...identity })
              const result = await runBrowserVisualTask({
                goal,
                taskId,
                journeyId,
                adapter: selection.adapter,
                decide,
                guard,
                plan,
                ...(checkpoint?.steps.length ? { resumedSteps: checkpoint.steps } : {}),
                activePage,
                waitForUser: async (why, signal) => {
                  if (!ownsRun()) return
                  await waitForVisionUser(taskId, why, signal)
                },
                onStep: recordStep,
                onPhase: (phaseId) => recordStep(encodeTaskPhase(phaseId)),
                onProgress: (progress) => {
                  if (!ownsRun()) return
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
              // The visual graph can fail before the model lease is released. Publish its
              // terminal guard state now so a failed run never remains visibly "waiting"
              // with a Continue button that cannot resume it.
              if (ownsRun() && guard.isHalted) {
                setState(automationTaskReadStatus(guard.automationStatus), result.summary)
              }
              return result
            })
          : {
              ok: semantic.ok,
              summary: semantic.summary,
              steps,
              handoffs: semantic.handoffs
            }
        return { semantic, visual }
      }

      const strategy =
        currentRemoteScreenTaskSession()?.modelStrategy ?? getWebUseSettings().modelStrategy
      const { semantic, visual } =
        strategy === 'separate_specialist'
          ? await withActiveBrowserVision(async ({ identity }) => {
              recordTaskRun({ taskId, journeyId, kind: 'web_use', title: goal, ...identity })
              return runBrowserRails()
            })
          : await runBrowserRails()
      if (!ownsRun()) return replacedResult()
      const finalContents = activePage().view.webContents
      const finalUrl = finalContents.getURL()
      const finalTitle = finalContents.getTitle()
      if (!visual.ok && !guard.isHalted) guard.fail(visual.summary)
      if (visual.ok && guard.automationStatus !== 'completed') {
        guard.fail('Web Use ended without a verified completion state.')
      }
      const status = automationTaskReadStatus(guard.automationStatus)
      const ok = visual.ok && status === 'done'
      const summary = ok ? visual.summary : guard.snapshot().failure || visual.summary
      setState(status, summary, { url: finalUrl, title: finalTitle })
      return {
        ok,
        summary,
        steps: [...steps],
        takeovers: semantic.handoffs + (semantic.fallback ? visual.handoffs : 0),
        finalUrl
      }
    } catch (error) {
      if (!ownsRun()) return replacedResult()
      if (guard.isHalted || owner.controller.signal.aborted) {
        const summary =
          guard.snapshot().failure ||
          (typeof owner.controller.signal.reason === 'string'
            ? owner.controller.signal.reason
            : 'Stopped')
        recordStep(`stopped: ${summary}`)
        setState(guard.automationStatus === 'failed' ? 'failed' : 'stopped', summary)
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
      console.log(`[web-use] ERROR: ${detail}`)
      recordStep(`error: ${detail}`)
      if (!ownsRun()) return replacedResult()
      const summary = `Web Use stopped: ${detail}`
      guard.fail(summary)
      setState(automationTaskReadStatus(guard.automationStatus), summary)
      return {
        ok: false,
        summary,
        steps,
        takeovers: 0,
        finalUrl: ''
      }
    } finally {
      if (benchTrace.current) {
        benchTrace.current.visits = this.visits
          .taskTrail(taskId)
          .map((visit) => ({ url: visit.url, title: visit.title, at: visit.visitedAt }))
      }
      this.filledSecrets.delete(journeyId)
      this.autofillTried.delete(journeyId)
      releaseGuidance()
      this.runOwners.release(owner)
      releaseSession()
    }
  }
}

let host: BrowserHost | null = null

/** Closes a finished journey's pages (the Web Use task list runner, between tasks). */
export function closeBrowserJourney(journeyId: string): void {
  browserHost().closeJourney(journeyId)
}

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
  ipcMain.on('browser:set-region', (event, owner: unknown, raw: unknown) => {
    if (!isBrowserRegionOwner(owner)) return
    const rect = parseRect(raw)
    const zoomFactor = event.sender.getZoomFactor()
    browserHost().setRegion(
      owner,
      rect
        ? {
            x: rect.x * zoomFactor,
            y: rect.y * zoomFactor,
            width: rect.width * zoomFactor,
            height: rect.height * zoomFactor
          }
        : null
    )
  })
  ipcMain.handle('browser:new-tab', (_event, journeyId: unknown) =>
    browserHost().newTab(typeof journeyId === 'string' ? journeyId : undefined)
  )
  ipcMain.handle('browser:open-url', (_event, url: unknown, journeyId: unknown) =>
    typeof url === 'string'
      ? browserHost().openUrl(url, typeof journeyId === 'string' ? journeyId : undefined)
      : null
  )
  ipcMain.handle('browser:get-sessions', () => browserHost().getSessions())
  ipcMain.handle('browser:activate-session', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? browserHost().activateSession(sessionId) : false
  )
  ipcMain.handle('browser:close-session', (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? browserHost().closeSession(sessionId) : false
  )
  ipcMain.handle('browser:control', (_e, action: unknown, sessionId: unknown) => {
    if (!isBrowserControl(action)) return false
    return browserHost().control(action, typeof sessionId === 'string' ? sessionId : undefined)
  })
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined
  ipcMain.handle('browser:reopen-closed-tab', () => browserHost().reopenClosedTab())
  ipcMain.handle('browser:history-search', (_e, query: unknown, before: unknown) =>
    browserHost().searchHistory(str(query) ?? '', typeof before === 'number' ? before : undefined)
  )
  ipcMain.handle('browser:history-remove', (_e, visitId: unknown) => {
    if (typeof visitId === 'number') browserHost().removeHistory(visitId)
  })
  ipcMain.handle('browser:history-clear', (_e, since: unknown) =>
    browserHost().clearHistory(typeof since === 'number' ? since : undefined)
  )
  ipcMain.handle('browser:bookmarks-list', () => browserHost().listBookmarks())
  ipcMain.handle('browser:bookmark-toggle', (_e, sessionId: unknown) =>
    browserHost().toggleBookmark(str(sessionId))
  )
  ipcMain.handle('browser:bookmark-remove', (_e, bookmarkId: unknown) => {
    if (typeof bookmarkId === 'string') browserHost().removeBookmark(bookmarkId)
  })
  ipcMain.handle('browser:bookmark-rename', (_e, bookmarkId: unknown, title: unknown) => {
    if (typeof bookmarkId === 'string' && typeof title === 'string') {
      browserHost().renameBookmark(bookmarkId, title)
    }
  })
  ipcMain.handle('browser:downloads-list', () => browserHost().listDownloads())
  ipcMain.handle('browser:download-action', (_e, downloadId: unknown, action: unknown) => {
    const allowed = ['cancel', 'pause', 'resume', 'open', 'show', 'clear'] as const
    const chosen = allowed.find((candidate) => candidate === action)
    return chosen ? browserHost().downloadAction(str(downloadId) ?? '', chosen) : false
  })
  ipcMain.handle(
    'browser:find',
    (_e, sessionId: unknown, query: unknown, forward: unknown, findNext: unknown) => {
      if (typeof sessionId !== 'string' || typeof query !== 'string') return
      browserHost().find(sessionId, query, forward !== false, findNext === true)
    }
  )
  ipcMain.handle('browser:stop-find', (_e, sessionId: unknown) => {
    if (typeof sessionId === 'string') browserHost().stopFind(sessionId)
  })
  ipcMain.handle('browser:vault-state', (_e, sessionId: unknown) =>
    browserHost().vaultState(str(sessionId))
  )
  ipcMain.handle('browser:vault-fill', (_e, sessionId: unknown, uuid: unknown) =>
    typeof sessionId === 'string' && typeof uuid === 'string'
      ? browserHost().fillLogin(sessionId, uuid)
      : { ok: false, reason: 'no_login' }
  )
  ipcMain.handle('browser:sandbox-profiles', () => browserHost().listSandboxProfiles())
  ipcMain.handle('browser:open-sandbox-profile', (_e, profileId: unknown) =>
    typeof profileId === 'string' ? browserHost().openSandboxProfile(profileId) : null
  )
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
