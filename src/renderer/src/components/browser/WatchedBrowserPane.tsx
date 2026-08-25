/**
 * The single task side panel for Web Use and Computer Use runs. Each run keeps
 * one tab, its status, and its log. Closing the panel or a tab only hides it;
 * the owning main-process rail continues the task and retains its state.
 */
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowRight,
  CursorClick,
  Gear,
  Plus,
  X
} from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { SidePanel } from '@renderer/components/SidePanel'
import { onOpenTaskSidePanel, type OpenTaskPanelRequest } from '@renderer/lib/task-side-panel'
import { useTaskSessions, type TaskSession } from '@renderer/lib/task-session-store'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import { ComputerUseStepDetails } from '@renderer/components/tasks/ComputerUseStepDetails'
import { ComputerUseSettingsSection } from '@renderer/components/ComputerUseSettingsSection'
import type {
  BrowserNavigationState,
  BrowserPointerEvent,
  BrowserSessionsSnapshot,
  ManualBrowserHistoryEntry
} from '../../../../shared/browser-session'

interface TakeoverRequest {
  taskId: string
  why: string
}

type TaskStatus = TaskSession['status']
type TaskTab = TaskSession & {
  notice?: string
  sessionId?: string
  manual?: boolean
  manualHistoryId?: string
  faviconUrl?: string
}

type NavigationState = Omit<BrowserNavigationState, 'sessionId'> & { sessionId?: string }
type ManualBrowserHistory = Pick<
  ManualBrowserHistoryEntry,
  'historyId' | 'title' | 'url' | 'updatedAt'
>

const EMPTY_NAVIGATION: NavigationState = {
  url: '',
  title: 'New tab',
  canGoBack: false,
  canGoForward: false,
  isLoading: false
}

function tabLabel(tab: TaskTab): string {
  if (tab.manual) return 'Browser'
  return tab.kind === 'web_use' ? 'Web Use' : 'Computer Use'
}

function statusTone(status: TaskStatus): string {
  if (status === 'failed') return 'text-red-500'
  if (status === 'paused') return 'text-amber-500'
  if (status === 'done') return 'text-green-500'
  return 'text-neutral-400'
}

function taskTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '—'
}

export function WatchedBrowserPane(): React.JSX.Element | null {
  const { tasks: persistedTasks, lastChangedTaskId } = useTaskSessions()
  const [browserState, setBrowserState] = useState<BrowserSessionsSnapshot>({
    activeSessionId: null,
    sessions: []
  })
  const [manualHistory, setManualHistory] = useState<ManualBrowserHistory[]>([])
  const [agentPointer, setAgentPointer] = useState<BrowserPointerEvent | null>(null)
  const tabs = useMemo<TaskTab[]>(() => {
    const taskTabs = persistedTasks.map((task) => {
      const session = browserState.sessions.find((item) => item.taskId === task.taskId)
      return {
        ...task,
        sessionId: session?.sessionId,
        faviconUrl: session?.faviconUrl
      }
    })
    const liveHistoryIds = new Set(
      browserState.sessions
        .filter((session) => session.kind === 'manual')
        .map((session) => session.historyId)
        .filter((value): value is string => Boolean(value))
    )
    const liveManual = browserState.sessions
      .filter((session) => session.kind === 'manual' && session.historyId)
      .map<TaskTab>((session) => {
        const history = manualHistory.find((item) => item.historyId === session.historyId)
        return {
          taskId: `manual:${session.historyId}`,
          kind: 'web_use',
          title: session.title || 'New tab',
          status: 'running',
          steps: [],
          startedAt: history?.updatedAt ?? 0,
          updatedAt: history?.updatedAt ?? 0,
          lastUrl: session.url,
          lastTitle: session.title,
          sessionId: session.sessionId,
          manual: true,
          manualHistoryId: session.historyId,
          faviconUrl: session.faviconUrl
        }
      })
    const closedManual = manualHistory
      .filter((history) => !liveHistoryIds.has(history.historyId))
      .map<TaskTab>((history) => ({
        taskId: `manual:${history.historyId}`,
        kind: 'web_use',
        title: history.title || 'Browser tab',
        status: 'stopped',
        summary: 'This browser tab is closed. Open it to continue browsing.',
        steps: [],
        startedAt: history.updatedAt,
        finishedAt: history.updatedAt,
        updatedAt: history.updatedAt,
        lastUrl: history.url,
        lastTitle: history.title,
        manual: true,
        manualHistoryId: history.historyId
      }))
    return [...taskTabs, ...liveManual, ...closedManual].sort(
      (a, b) => b.updatedAt - a.updatedAt || b.taskId.localeCompare(a.taskId)
    )
  }, [browserState.sessions, manualHistory, persistedTasks])
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [takeover, setTakeover] = useState<TakeoverRequest | null>(null)
  const [navigation, setNavigation] = useState<NavigationState>(EMPTY_NAVIGATION)
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState('')
  const regionRef = useRef<HTMLDivElement>(null)
  const receivedSessionEventRef = useRef(false)
  const tabsRef = useRef<TaskTab[]>(tabs)
  const hiddenIdsRef = useRef(hiddenIds)

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    hiddenIdsRef.current = hiddenIds
  }, [hiddenIds])

  useEffect(() => {
    const browser = window.api.browser
    const refreshHistory = (): void => {
      void browser?.listManualHistory().then((history) => setManualHistory(history))
    }
    void browser?.getSessions().then((initial) => {
      // A live session event can arrive while the initial invoke is in flight.
      // Never replace newer host state with the stale bootstrap response.
      if (!receivedSessionEventRef.current) setBrowserState(initial)
    })
    refreshHistory()
    const offSessions = browser?.onSessionsState((event) => {
      receivedSessionEventRef.current = true
      setBrowserState(event as BrowserSessionsSnapshot)
      refreshHistory()
    })
    const offNavigation = window.api.browser?.onNavigationState((event) => {
      const state = event as NavigationState
      if (state.sessionId) {
        setBrowserState((current) => ({
          ...current,
          sessions: current.sessions.map((session) =>
            session.sessionId === state.sessionId ? { ...session, ...state } : session
          )
        }))
      }
      setNavigation(state)
      setAddressError('')
    })
    const offPointer = browser?.onPointer((event) => setAgentPointer(event as BrowserPointerEvent))
    const offTakeover = window.api.browser?.onTakeover((event) =>
      setTakeover(event as TakeoverRequest)
    )
    const offOpen = onOpenTaskSidePanel((request: OpenTaskPanelRequest) => {
      const currentTabs = tabsRef.current
      if (!request.taskId && !request.kind) {
        // The permanent Tasks button is the history entry point. Restore every
        // hidden tab so closing a tab never makes an old run unreachable.
        setHiddenIds(new Set())
        if (currentTabs[0]) setActiveId(currentTabs[0].taskId)
        setVisible(true)
        return
      }
      const requested =
        (request.taskId ? currentTabs.find((tab) => tab.taskId === request.taskId) : undefined) ??
        (request.kind
          ? [...currentTabs].reverse().find((tab) => tab.kind === request.kind)
          : undefined) ??
        currentTabs[0]
      if (requested) {
        setHiddenIds((current) => {
          const next = new Set(current)
          next.delete(requested.taskId)
          return next
        })
        setActiveId(requested.taskId)
        setVisible(true)
      } else if (request.kind === 'web_use') {
        void window.api.browser?.reopen(request.taskId)
      }
    })

    return () => {
      offSessions?.()
      offNavigation?.()
      offPointer?.()
      offTakeover?.()
      offOpen()
    }
  }, [])

  useEffect(() => {
    const selected = browserState.sessions.find(
      (session) => session.sessionId === browserState.activeSessionId
    )
    if (!selected) return
    queueMicrotask(() =>
      setActiveId(
        selected.kind === 'manual' && selected.historyId
          ? `manual:${selected.historyId}`
          : (selected.taskId ?? null)
      )
    )
  }, [browserState.activeSessionId, browserState.sessions])

  useEffect(() => {
    if (!lastChangedTaskId || hiddenIdsRef.current.has(lastChangedTaskId)) return
    const changed = tabs.find((tab) => tab.taskId === lastChangedTaskId)
    if (!changed || changed.status === 'done') return
    queueMicrotask(() => {
      setActiveId(changed.taskId)
      setVisible(true)
    })
  }, [lastChangedTaskId, tabs])

  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !hiddenIds.has(tab.taskId)),
    [tabs, hiddenIds]
  )
  const active = tabs.find((tab) => tab.taskId === activeId) ?? visibleTabs[0] ?? null

  const activeBrowserSession = active?.sessionId
    ? browserState.sessions.find((session) => session.sessionId === active.sessionId)
    : undefined

  useEffect(() => {
    if (!active) return
    if (activeBrowserSession) {
      queueMicrotask(() => {
        setNavigation(activeBrowserSession)
        setAddress(activeBrowserSession.url)
        setAddressError('')
      })
      return
    }
    if (active.kind !== 'web_use') return
    const historicNavigation: NavigationState = {
      url: active.lastUrl ?? '',
      title: active.lastTitle ?? 'Saved page',
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }
    queueMicrotask(() => {
      setNavigation(historicNavigation)
      setAddress(historicNavigation.url)
      setAddressError('')
    })
  }, [active, activeBrowserSession])

  useEffect(() => {
    const element = regionRef.current
    if (!visible || active?.kind !== 'web_use' || !active.sessionId || !element) {
      window.api.browser?.setRegion(null)
      return
    }
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      window.api.browser?.setRegion({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.api.browser?.setRegion(null)
    }
  }, [active?.kind, active?.sessionId, active?.taskId, visible])

  const hidePanel = (): void => {
    window.api.browser?.setRegion(null)
    setVisible(false)
  }

  const newBrowserTab = async (): Promise<void> => {
    setVisible(true)
    setAddressError('')
    await window.api.browser?.newTab()
  }

  const activateTab = async (tab: TaskTab): Promise<void> => {
    setActiveId(tab.taskId)
    setHiddenIds((current) => {
      const next = new Set(current)
      next.delete(tab.taskId)
      return next
    })
    if (tab.sessionId) {
      await window.api.browser?.activateSession(tab.sessionId)
    } else if (tab.manualHistoryId) {
      await window.api.browser?.reopenManual(tab.manualHistoryId)
    } else if (tab.kind === 'web_use') {
      await window.api.browser?.reopen(tab.taskId)
    }
  }

  const closeTab = (tab: TaskTab): void => {
    if (tab.sessionId) void window.api.browser?.closeSession(tab.sessionId)
    setHiddenIds((current) => new Set(current).add(tab.taskId))
    const next = visibleTabs.find((candidate) => candidate.taskId !== tab.taskId)
    if (next) void activateTab(next)
    else hidePanel()
  }

  if (!visible) return null

  if (!active || visibleTabs.length === 0) {
    return (
      <SidePanel
        ariaLabel="Task activity"
        onClose={hidePanel}
        className="w-[48vw] min-w-[560px] max-w-[90vw]"
      >
        <div data-testid="task-side-panel" className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
            <span className="text-xs uppercase tracking-wide text-neutral-400">Tasks</span>
            <div className="flex items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setSettingsOpen((value) => !value)}
                aria-label="Computer Use settings"
                className="h-7 w-7 rounded-sm"
              >
                <Gear size={14} />
              </Button>
              <Button size="sm" variant="ghost" onClick={hidePanel} aria-label="Close task panel">
                Close
              </Button>
            </div>
          </div>
          {settingsOpen ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <ComputerUseSettingsSection />
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
              <p className="text-sm text-neutral-200">No task history yet</p>
              <p className="mt-2 max-w-sm text-xs leading-5 text-neutral-500">
                Web Use and Computer Use runs will appear here with their status, steps, and
                results.
              </p>
              <Button className="mt-4" onClick={() => void newBrowserTab()}>
                <Plus size={14} />
                New browser tab
              </Button>
            </div>
          )}
        </div>
      </SidePanel>
    )
  }

  const submitAddress = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const result = await window.api.browser?.navigate(address, active.sessionId)
    if (result && !result.ok) {
      setAddressError(result.detail ?? 'This address could not be opened.')
    }
  }
  const resolveTakeover = (outcome: 'resumed' | 'cancelled'): void => {
    if (!takeover) return
    void window.api.browser?.resolveTakeover(takeover.taskId, outcome)
    setTakeover(null)
  }
  const computerControl = (command: 'stop' | 'pause' | 'resume'): void => {
    void window.api.vision?.control(command)
  }

  return (
    <SidePanel
      ariaLabel="Tasks"
      onClose={hidePanel}
      className="w-[48vw] min-w-[560px] max-w-[90vw]"
    >
      <div data-testid="task-side-panel" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <span className="text-xs uppercase tracking-wide text-neutral-400">Tasks</span>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => setSettingsOpen((value) => !value)}
              aria-label="Computer Use settings"
              className="h-7 w-7 rounded-sm"
            >
              <Gear size={14} />
            </Button>
            <Button size="sm" variant="ghost" onClick={hidePanel} aria-label="Close task panel">
              Close
            </Button>
          </div>
        </div>

        {settingsOpen ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <ComputerUseSettingsSection />
          </div>
        ) : (
          <div className="contents">
            <div className="flex min-w-0 items-end gap-1 overflow-x-auto border-b border-neutral-800 bg-neutral-950 px-2 pt-2">
              {visibleTabs.map((tab) => (
                <div
                  key={tab.taskId}
                  data-testid={`task-tab-${tab.taskId}`}
                  className={`flex min-w-[170px] max-w-[260px] items-center gap-2 border border-b-0 px-3 py-2 text-left text-xs transition-colors ${
                    active.taskId === tab.taskId
                      ? 'border-neutral-700 bg-neutral-900 text-neutral-100'
                      : 'border-transparent text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-300'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => void activateTab(tab)}
                    className="min-w-0 flex-1 text-left"
                  >
                    {tab.faviconUrl ? (
                      <img src={tab.faviconUrl} alt="" className="mr-1 inline h-3 w-3" />
                    ) : null}
                    <span className="block text-[9px] uppercase tracking-wide text-green-500">
                      {tabLabel(tab)}
                    </span>
                    <span className="block truncate">{tab.title}</span>
                  </button>
                  <span className={`text-[9px] uppercase ${statusTone(tab.status)}`}>
                    {tab.manual ? (tab.sessionId ? 'open' : 'closed') : tab.status}
                  </span>
                  <button
                    type="button"
                    aria-label={`Close ${tabLabel(tab)} tab`}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(tab)
                    }}
                    className="text-neutral-600 hover:text-neutral-200"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="New browser tab"
                onClick={() => void newBrowserTab()}
                className="mb-1 h-7 w-7 shrink-0 rounded-sm"
              >
                <Plus size={14} />
              </Button>
            </div>

            <div className="border-b border-neutral-800 px-4 py-2 text-[10px] text-neutral-500">
              <span>Started {taskTime(active.startedAt)}</span>
              {active.finishedAt ? <span> · Finished {taskTime(active.finishedAt)}</span> : null}
            </div>

            {active.kind === 'web_use' ? (
              <>
                <div className="border-b border-neutral-800 bg-neutral-900 px-2 py-2">
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Go back"
                      disabled={!active.sessionId || !navigation.canGoBack}
                      onClick={() => void window.api.browser?.control('back', active.sessionId)}
                      className="h-7 w-7 rounded-sm"
                    >
                      <ArrowLeft size={15} />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label="Go forward"
                      disabled={!active.sessionId || !navigation.canGoForward}
                      onClick={() => void window.api.browser?.control('forward', active.sessionId)}
                      className="h-7 w-7 rounded-sm"
                    >
                      <ArrowRight size={15} />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={navigation.isLoading ? 'Stop loading' : 'Reload page'}
                      disabled={!active.sessionId}
                      onClick={() =>
                        void window.api.browser?.control(
                          navigation.isLoading ? 'stop' : 'reload',
                          active.sessionId
                        )
                      }
                      className="h-7 w-7 rounded-sm"
                    >
                      {navigation.isLoading ? <X size={14} /> : <ArrowClockwise size={15} />}
                    </Button>
                    <form
                      onSubmit={(event) => void submitAddress(event)}
                      className="min-w-0 flex-1"
                    >
                      <input
                        aria-label="Browser address"
                        value={address}
                        readOnly={!active.sessionId}
                        onChange={(event) => setAddress(event.target.value)}
                        className="h-7 w-full rounded-sm border border-neutral-700 bg-neutral-950 px-2 text-xs text-neutral-200 outline-none transition-colors focus:border-green-500"
                        placeholder="Enter a website or search"
                        spellCheck={false}
                      />
                    </form>
                  </div>
                  {addressError ? (
                    <p className="mt-1 text-[11px] text-red-500">{addressError}</p>
                  ) : null}
                </div>

                {!active.sessionId ? (
                  <div
                    data-testid="watched-failure"
                    className="flex min-h-0 flex-1 flex-col justify-center border-b border-neutral-800 bg-neutral-900 p-5"
                  >
                    <p className={`text-xs uppercase tracking-wide ${statusTone(active.status)}`}>
                      {tabLabel(active)} {active.status}
                    </p>
                    <p className="mt-2 text-sm text-neutral-200">
                      {active.summary || 'This run has finished.'}
                    </p>
                    <p className="mt-2 text-xs text-neutral-500">Check the run log below.</p>
                  </div>
                ) : (
                  <div
                    ref={regionRef}
                    data-testid="watched-web-region"
                    className="relative min-h-0 flex-1 overflow-hidden border-b border-neutral-800 bg-neutral-900"
                  >
                    {agentPointer?.sessionId === active.sessionId ? (
                      <div
                        data-testid="browser-agent-pointer"
                        className="pointer-events-none absolute z-20 text-green-500"
                        style={{ left: agentPointer.x, top: agentPointer.y }}
                        aria-label="Off Grid AI pointer"
                      >
                        {agentPointer.phase === 'pressed' ? (
                          <span className="absolute -left-3 -top-3 h-6 w-6 animate-ping rounded-full border border-green-500" />
                        ) : null}
                        <CursorClick className="h-5 w-5 drop-shadow" weight="fill" />
                      </div>
                    ) : null}
                  </div>
                )}

                {takeover?.taskId === active.taskId ? (
                  <div className="border-b border-neutral-800 bg-neutral-950 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[10px] uppercase tracking-wide text-amber-500">
                          Your turn
                        </p>
                        <p className="mt-1 text-xs text-neutral-200">{takeover.why}</p>
                        <p className="mt-1 text-[11px] text-neutral-500">
                          Complete this step in the page. Off Grid AI does not read your password or
                          codes.
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" onClick={() => resolveTakeover('resumed')}>
                          Resume
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resolveTakeover('cancelled')}
                        >
                          Cancel task
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="border-b border-neutral-800 px-4 py-3">
                  <p className="text-sm text-neutral-200">{active.title}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    Off Grid AI is acting on your screen. Move the mouse or press Esc to take over.
                  </p>
                  {active.notice ? (
                    <p className="mt-2 border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-500">
                      {active.notice}
                    </p>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 bg-neutral-900 p-3">
                  {active.screenshotPath ? (
                    <img
                      src={captureUrlForPath(active.screenshotPath)}
                      alt="Last screen from this Computer Use run"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <p className="text-xs text-neutral-600">
                      {active.status === 'running'
                        ? 'Waiting for the first screen update.'
                        : 'No screen image was saved for this run.'}
                    </p>
                  )}
                </div>
                {(active.status === 'running' || active.status === 'paused') && (
                  <div className="flex items-center gap-2 border-t border-neutral-800 px-4 py-3">
                    <Button size="sm" variant="destructive" onClick={() => computerControl('stop')}>
                      Stop
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        computerControl(active.status === 'paused' ? 'resume' : 'pause')
                      }
                    >
                      {active.status === 'paused' ? 'Resume' : 'Pause'}
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="max-h-40 overflow-y-auto border-t border-neutral-800 bg-neutral-950 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wide text-neutral-500">Run log</p>
              {active.steps.length ? (
                <ol
                  data-testid="watched-step-feed"
                  className="mt-1 space-y-1 text-[11px] text-neutral-400"
                >
                  {active.steps.map((step, index) => (
                    <li key={`${index}-${step}`} className="flex gap-2">
                      <span className="text-neutral-600">{String(index + 1).padStart(2, '0')}</span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-1 text-[11px] text-neutral-600">
                  Waiting for the first task step.
                </p>
              )}
              {active.summary ? (
                <p
                  className={`mt-2 border-t border-neutral-800 pt-2 text-xs ${statusTone(active.status)}`}
                >
                  {active.summary}
                </p>
              ) : null}
              <ComputerUseStepDetails details={active.stepDetails} />
            </div>
          </div>
        )}
      </div>
    </SidePanel>
  )
}
