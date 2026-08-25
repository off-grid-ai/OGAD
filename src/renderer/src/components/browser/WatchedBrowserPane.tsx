/**
 * The single task side panel for Web Use and Computer Use runs. Each run keeps
 * one tab, its status, and its log. Closing the panel or a tab only hides it;
 * the owning main-process rail continues the task and retains its state.
 */
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowClockwise, ArrowLeft, ArrowRight, X } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { SidePanel } from '@renderer/components/SidePanel'
import {
  onOpenTaskSidePanel,
  type OpenTaskPanelRequest,
  type TaskPanelKind
} from '@renderer/lib/task-side-panel'
import { useTaskSessions, type TaskSession } from '@renderer/lib/task-session-store'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'

interface TakeoverRequest {
  taskId: string
  why: string
}

type TaskStatus = TaskSession['status']
type TaskTab = TaskSession & { notice?: string }

interface NavigationState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

const EMPTY_NAVIGATION: NavigationState = {
  url: '',
  title: 'New tab',
  canGoBack: false,
  canGoForward: false,
  isLoading: false
}

function tabLabel(kind: TaskPanelKind): string {
  return kind === 'web_use' ? 'Web Use' : 'Computer Use'
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
  const tabs = persistedTasks as TaskTab[]
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const [takeover, setTakeover] = useState<TakeoverRequest | null>(null)
  const [navigation, setNavigation] = useState<NavigationState>(EMPTY_NAVIGATION)
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState('')
  const regionRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<TaskTab[]>(tabs)
  const hiddenIdsRef = useRef(hiddenIds)

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    hiddenIdsRef.current = hiddenIds
  }, [hiddenIds])

  useEffect(() => {
    const offNavigation = window.api.browser?.onNavigationState?.((event) => {
      const state = event as NavigationState
      setNavigation(state)
      setAddress(state.url)
      setAddressError('')
    })
    const offTakeover = window.api.browser?.onTakeover?.((event) =>
      setTakeover(event as TakeoverRequest)
    )
    const offOpen = onOpenTaskSidePanel((request: OpenTaskPanelRequest) => {
      const currentTabs = tabsRef.current
      if (!request.taskId && !request.kind) {
        // The permanent Tasks button is the history entry point. Restore every
        // hidden tab so closing a tab never makes an old run unreachable.
        setHiddenIds(new Set())
        if (currentTabs[0]) setActiveId(currentTabs[0].taskId)
        setVisible(currentTabs.length > 0)
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
      offNavigation?.()
      offTakeover?.()
      offOpen()
    }
  }, [])

  useEffect(() => {
    if (!lastChangedTaskId || hiddenIdsRef.current.has(lastChangedTaskId)) return
    const changed = tabs.find((tab) => tab.taskId === lastChangedTaskId)
    if (!changed || changed.status === 'done') return
    setActiveId(changed.taskId)
    setVisible(true)
  }, [lastChangedTaskId, tabs])

  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !hiddenIds.has(tab.taskId)),
    [tabs, hiddenIds]
  )
  const active = tabs.find((tab) => tab.taskId === activeId) ?? visibleTabs[0] ?? null

  useEffect(() => {
    if (!active || active.kind !== 'web_use' || active.status === 'running') return
    const historicNavigation: NavigationState = {
      url: active.lastUrl ?? '',
      title: active.lastTitle ?? 'Saved page',
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }
    setNavigation(historicNavigation)
    setAddress(historicNavigation.url)
    setAddressError('')
  }, [active?.kind, active?.lastTitle, active?.lastUrl, active?.status, active?.taskId])

  useEffect(() => {
    const element = regionRef.current
    if (!visible || active?.kind !== 'web_use' || active.status !== 'running' || !element) {
      window.api.browser?.setRegion?.(null)
      return
    }
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      window.api.browser?.setRegion?.({
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
      window.api.browser?.setRegion?.(null)
    }
  }, [active?.kind, active?.status, active?.taskId, visible])

  if (!visible || !active || visibleTabs.length === 0) return null

  const hidePanel = (): void => {
    window.api.browser?.setRegion?.(null)
    setVisible(false)
  }
  const closeTab = (taskId: string): void => {
    setHiddenIds((current) => new Set(current).add(taskId))
    const next = visibleTabs.find((tab) => tab.taskId !== taskId)
    if (next) setActiveId(next.taskId)
    else hidePanel()
  }
  const submitAddress = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const result = await window.api.browser?.navigate(address)
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
          <Button size="sm" variant="ghost" onClick={hidePanel} aria-label="Close task panel">
            Close
          </Button>
        </div>

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
                onClick={() => setActiveId(tab.taskId)}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block text-[9px] uppercase tracking-wide text-green-500">
                  {tabLabel(tab.kind)}
                </span>
                <span className="block truncate">{tab.title}</span>
              </button>
              <span className={`text-[9px] uppercase ${statusTone(tab.status)}`}>{tab.status}</span>
              <button
                type="button"
                aria-label={`Close ${tabLabel(tab.kind)} tab`}
                onClick={(event) => {
                  event.stopPropagation()
                  closeTab(tab.taskId)
                }}
                className="text-neutral-600 hover:text-neutral-200"
              >
                <X size={12} />
              </button>
            </div>
          ))}
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
                  disabled={active.status !== 'running' || !navigation.canGoBack}
                  onClick={() => void window.api.browser?.control('back')}
                  className="h-7 w-7 rounded-sm"
                >
                  <ArrowLeft size={15} />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Go forward"
                  disabled={active.status !== 'running' || !navigation.canGoForward}
                  onClick={() => void window.api.browser?.control('forward')}
                  className="h-7 w-7 rounded-sm"
                >
                  <ArrowRight size={15} />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={navigation.isLoading ? 'Stop loading' : 'Reload page'}
                  disabled={active.status !== 'running'}
                  onClick={() =>
                    void window.api.browser?.control(navigation.isLoading ? 'stop' : 'reload')
                  }
                  className="h-7 w-7 rounded-sm"
                >
                  {navigation.isLoading ? <X size={14} /> : <ArrowClockwise size={15} />}
                </Button>
                <form onSubmit={(event) => void submitAddress(event)} className="min-w-0 flex-1">
                  <input
                    aria-label="Browser address"
                    value={address}
                    readOnly={active.status !== 'running'}
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

            {active.status !== 'running' ? (
              <div
                data-testid="watched-failure"
                className="flex min-h-0 flex-1 flex-col justify-center border-b border-neutral-800 bg-neutral-900 p-5"
              >
                <p className={`text-xs uppercase tracking-wide ${statusTone(active.status)}`}>
                  Web Use {active.status}
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
                className="min-h-0 flex-1 border-b border-neutral-800 bg-neutral-900"
              />
            )}

            {takeover?.taskId === active.taskId ? (
              <div className="border-b border-neutral-800 bg-neutral-950 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-wide text-amber-500">Your turn</p>
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
                  onClick={() => computerControl(active.status === 'paused' ? 'resume' : 'pause')}
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
            <p className="mt-1 text-[11px] text-neutral-600">Waiting for the first task step.</p>
          )}
          {active.summary ? (
            <p
              className={`mt-2 border-t border-neutral-800 pt-2 text-xs ${statusTone(active.status)}`}
            >
              {active.summary}
            </p>
          ) : null}
        </div>
      </div>
    </SidePanel>
  )
}
