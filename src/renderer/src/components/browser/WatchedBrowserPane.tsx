/**
 * The docked task workspace for Web Use and Computer Use. The main app stays
 * mounted beside it, so Chat remains usable while a task runs.
 */
import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Plus } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import {
  closeTaskWorkspace,
  showTaskWorkspace,
  useTaskWorkspaceOpen
} from '@renderer/lib/task-side-panel'
import { taskSessionsForJourney, useTaskSessions } from '@renderer/lib/task-session-store'
import { ComputerUseSettingsSection } from '@renderer/components/ComputerUseSettingsSection'
import { TaskHeaderControls } from './tasks/TaskHeaderControls'
import { TaskWorkspaceLayout } from './tasks/TaskWorkspaceLayout'
import type { TaskTab } from './tasks/task-types'
import { useTaskFeeds } from './tasks/useTaskFeeds'
import { useTaskTabs } from './tasks/useTaskTabs'
import { useTaskSelection } from './tasks/useTaskSelection'
import { useActiveTask } from './tasks/useActiveTask'

interface WatchedBrowserPaneProps {
  mainWorkspaceCollapsed?: boolean
  onToggleMainWorkspace?: () => void
  onDetailModeChange?: (detailOpen: boolean) => void
  routeActive?: boolean
  /** Existing chats show only their own tasks. Null means a fresh chat and shows all tasks. */
  conversationId?: string | null
  /** The global Tasks route uses the same workspace without docked-panel chrome. */
  standalone?: boolean
}

export function WatchedBrowserPane({
  mainWorkspaceCollapsed = false,
  onToggleMainWorkspace,
  onDetailModeChange,
  routeActive = true,
  conversationId = null,
  standalone = false
}: WatchedBrowserPaneProps = {}): React.JSX.Element | null {
  const { tasks: persistedTasks, ready: taskHistoryReady, lastChangedTaskId } = useTaskSessions()
  const visible = useTaskWorkspaceOpen()
  const paneVisible = standalone || (visible && routeActive)
  const {
    browserState,
    manualHistory,
    agentPointer,
    liveComputerState,
    takeover,
    setTakeover,
    navigation,
    setNavigation
  } = useTaskFeeds()
  const [controlError, setControlError] = useState('')
  const allTabs = useTaskTabs(persistedTasks, browserState, manualHistory)
  const tabs = useMemo(
    () =>
      taskSessionsForJourney(allTabs, conversationId).filter(
        (tab) => !conversationId || !tab.manual
      ),
    [allTabs, conversationId]
  )
  const {
    activeId,
    setActiveId,
    hiddenIds,
    setHiddenIds,
    detailTaskId,
    immersiveTaskId,
    setDetailTaskId
  } = useTaskSelection(tabs, browserState, lastChangedTaskId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState('')

  useEffect(() => {
    if (paneVisible) return
    ;(
      window.api.browser as Partial<NonNullable<typeof window.api.browser>> | undefined
    )?.setRegion?.(null)
  }, [paneVisible])
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !hiddenIds.has(tab.taskId)),
    [tabs, hiddenIds]
  )
  const visibleTaskTabs = visibleTabs.filter((tab) => !tab.manual)
  const visibleManualTabs = visibleTabs.filter((tab) => tab.manual)
  const {
    active,
    activeIsLive,
    activeComputerIsLocal,
    activeWebIsLocal,
    activeEscNotice,
    activeJourneyPages
  } = useActiveTask({
    tabs,
    visibleTabs,
    activeId,
    browserState,
    liveComputerState,
    setNavigation,
    setAddress,
    setAddressError
  })
  const immersiveBrowserDetail = Boolean(
    immersiveTaskId !== null &&
    active?.taskId === immersiveTaskId &&
    active.kind === 'web_use' &&
    activeIsLive &&
    activeWebIsLocal
  )

  useEffect(() => {
    onDetailModeChange?.(immersiveBrowserDetail)
    return () => {
      if (immersiveBrowserDetail) onDetailModeChange?.(false)
    }
  }, [immersiveBrowserDetail, onDetailModeChange])

  useEffect(() => {
    setControlError('')
  }, [active?.taskId])

  const hidePanel = (): void => {
    ;(
      window.api.browser as Partial<NonNullable<typeof window.api.browser>> | undefined
    )?.setRegion?.(null)
    closeTaskWorkspace()
  }

  const newBrowserTab = async (): Promise<void> => {
    showTaskWorkspace()
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
    // A task tab is a journey workspace. Closing it only hides the workspace;
    // page close and Stop are separate, explicit actions.
    if (tab.manual && tab.sessionId) void window.api.browser?.closeSession(tab.sessionId)
    setHiddenIds((current) => new Set(current).add(tab.taskId))
    const next = visibleTabs.find((candidate) => candidate.taskId !== tab.taskId)
    if (next) void activateTab(next)
    else hidePanel()
  }

  if (!paneVisible) return null

  if (!active || visibleTabs.length === 0) {
    return (
      <section
        aria-label="Task activity"
        data-testid="task-side-panel"
        className="flex h-full min-h-0 flex-1 flex-col border-l border-border bg-background font-mono text-foreground"
      >
        <TaskHeaderControls
          settingsOpen={settingsOpen}
          mainWorkspaceCollapsed={mainWorkspaceCollapsed}
          historyOpen={false}
          showHistory={false}
          onToggleMainWorkspace={onToggleMainWorkspace}
          onToggleHistory={() => undefined}
          onToggleSettings={() => setSettingsOpen((value) => !value)}
          onClose={hidePanel}
          showClose={!standalone}
        />
        {settingsOpen ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <ComputerUseSettingsSection />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
            <p className="text-sm text-foreground">
              {taskHistoryReady ? 'No task history yet' : 'Loading task history…'}
            </p>
            <p className="mt-2 max-w-sm text-xs leading-5 text-muted-foreground">
              {taskHistoryReady
                ? 'Web Use and Computer Use runs will appear here with their status, steps, and results.'
                : 'Your synced task records are loading.'}
            </p>
            {taskHistoryReady ? (
              <Button className="mt-4" onClick={() => void newBrowserTab()}>
                <Plus size={14} />
                New browser tab
              </Button>
            ) : null}
          </div>
        )}
      </section>
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
  const computerControl = async (
    command: 'stop' | 'pause' | 'takeover' | 'resume'
  ): Promise<void> => {
    setControlError('')
    try {
      const result = await window.api.vision?.control(command, active.taskId)
      if (!result) setControlError(`Could not ${command} this task on this device.`)
    } catch {
      setControlError(`Could not ${command} this task. Try again on the execution device.`)
    }
  }
  const stopWebTask = async (): Promise<void> => {
    setControlError('')
    try {
      const result = await window.api.browser?.stopTask(active.taskId)
      if (!result) setControlError('Could not stop Web Use on this device.')
    } catch {
      setControlError('Could not stop Web Use. Try again on the execution device.')
    }
  }
  return (
    <TaskWorkspaceLayout
      settingsOpen={settingsOpen}
      mainWorkspaceCollapsed={mainWorkspaceCollapsed}
      visibleTasks={visibleTaskTabs}
      active={active}
      detailTaskId={detailTaskId}
      onDetailTaskChange={setDetailTaskId}
      onActivateTask={(task) => void activateTab(task)}
      onToggleMainWorkspace={onToggleMainWorkspace}
      onToggleSettings={() => setSettingsOpen((value) => !value)}
      onClose={hidePanel}
      showClose={!standalone}
      live={{
        active,
        activeStatus: active.status,
        activeIsLive,
        activeComputerIsLocal,
        activeWebIsLocal,
        activeEscNotice,
        controlError,
        journeyPages: activeJourneyPages,
        manualTabs: visibleManualTabs,
        navigation,
        address,
        addressError,
        pointer: agentPointer,
        takeover,
        onAddressChange: setAddress,
        onSubmitAddress: (event) => void submitAddress(event),
        onActivatePage: (sessionId) => void window.api.browser?.activateSession(sessionId),
        onActivateTab: (tab) => void activateTab(tab),
        onClosePage: (sessionId) => void window.api.browser?.closeSession(sessionId),
        onCloseTab: closeTab,
        onNewTab: () => void newBrowserTab(),
        onStopWeb: () => void stopWebTask(),
        onComputerControl: (command) => void computerControl(command),
        onResolveTakeover: resolveTakeover
      }}
    />
  )
}
