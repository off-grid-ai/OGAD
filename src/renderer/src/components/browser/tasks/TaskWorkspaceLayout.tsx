import { useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle
} from 'react-resizable-panels'
import { ComputerUseSettingsSection } from '@renderer/components/ComputerUseSettingsSection'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import { LiveTaskSurface, type LiveTaskSurfaceProps } from './LiveTaskSurface'
import { TaskHeaderControls } from './TaskHeaderControls'
import { TaskHistoryList } from './TaskHistoryList'
import type { TaskTab } from './task-types'

interface TaskWorkspaceLayoutProps {
  settingsOpen: boolean
  mainWorkspaceCollapsed: boolean
  visibleTasks: TaskTab[]
  active: TaskTab
  live: LiveTaskSurfaceProps
  detailTaskId: string | null
  onDetailTaskChange: (taskId: string | null) => void
  onActivateTask: (task: TaskTab) => void
  onToggleMainWorkspace?: () => void
  onToggleSettings: () => void
  onClose: () => void
  showClose?: boolean
}

function resizeHistory({
  key,
  size,
  setSize,
  panel
}: {
  key: string
  size: number
  setSize: (size: number) => void
  panel: ImperativePanelHandle | null
}): void {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
  const next = Math.min(60, Math.max(30, size + (key === 'ArrowRight' ? 5 : -5)))
  setSize(next)
  try {
    panel?.resize(next)
  } catch {
    // The next measured layout applies the announced size.
  }
}

export function TaskWorkspaceLayout(props: TaskWorkspaceLayoutProps): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(true)
  const [historySize, setHistorySize] = useState(34)
  const [historyDragging, setHistoryDragging] = useState(false)
  const reduceMotion = useReducedMotion()
  const historyPanelRef = useRef<ImperativePanelHandle>(null)
  const historyListSizeRef = useRef<number | null>(null)
  const panelTransition =
    reduceMotion || historyDragging ? 'none' : 'flex-grow 420ms cubic-bezier(0.22, 1, 0.36, 1)'
  const toggleHistory = (): void => {
    const nextOpen = !historyOpen
    setHistoryOpen(nextOpen)
    try {
      if (nextOpen) historyPanelRef.current?.expand()
      else historyPanelRef.current?.collapse()
    } catch {
      // The next measured layout restores the requested state.
    }
  }
  const openDetails = (taskId: string): void => {
    const task = props.visibleTasks.find((candidate) => candidate.taskId === taskId)
    if (task) props.onActivateTask(task)
    props.onDetailTaskChange(taskId)
    try {
      const currentSize = historyPanelRef.current?.getSize()
      if (currentSize !== undefined) historyListSizeRef.current = currentSize
      historyPanelRef.current?.resize(34)
    } catch {
      // The first measured browser frame applies the wider default.
    }
  }
  const closeDetails = (): void => {
    props.onDetailTaskChange(null)
    try {
      if (historyListSizeRef.current !== null)
        historyPanelRef.current?.resize(historyListSizeRef.current)
    } catch {
      // The saved panel layout restores after its first measured frame.
    }
    historyListSizeRef.current = null
  }

  return (
    <section
      aria-label="Tasks"
      data-testid="task-side-panel"
      className="flex h-full min-h-0 flex-1 flex-col border-l border-border bg-background font-mono text-foreground"
    >
      <TaskHeaderControls
        settingsOpen={props.settingsOpen}
        mainWorkspaceCollapsed={props.mainWorkspaceCollapsed}
        historyOpen={historyOpen}
        onToggleMainWorkspace={props.onToggleMainWorkspace}
        onToggleHistory={toggleHistory}
        onToggleSettings={props.onToggleSettings}
        onClose={props.onClose}
        showClose={props.showClose}
      />
      {props.settingsOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ComputerUseSettingsSection />
        </div>
      ) : (
        <PanelGroup
          direction="horizontal"
          autoSaveId="offgrid-task-history-live-layout"
          className="min-h-0 flex-1"
        >
          <Panel
            ref={historyPanelRef}
            id="task-history"
            order={1}
            defaultSize={34}
            minSize={30}
            collapsible
            collapsedSize={0}
            style={{ transition: panelTransition }}
            onCollapse={() => setHistoryOpen(false)}
            onExpand={() => setHistoryOpen(true)}
            onResize={setHistorySize}
          >
            <TaskHistoryList
              tasks={props.visibleTasks}
              active={props.active}
              expandedTaskId={props.detailTaskId}
              onOpenDetails={openDetails}
              onCloseDetails={closeDetails}
              onRetryStarted={(taskId) => {
                props.onDetailTaskChange(taskId)
                openTaskSidePanel({
                  taskId,
                  kind: props.active.kind,
                  detail: true,
                  immersive: true
                })
              }}
            />
          </Panel>
          <PanelResizeHandle
            aria-label="Resize task history and live task"
            title="Drag to resize task history and live task"
            className="group relative w-2 shrink-0 cursor-col-resize border-x border-border bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
            onDragging={setHistoryDragging}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              event.stopPropagation()
              resizeHistory({
                key: event.key,
                size: historySize,
                setSize: setHistorySize,
                panel: historyPanelRef.current
              })
            }}
            aria-valuemin={30}
            aria-valuemax={60}
            aria-valuenow={Math.round(historySize)}
            aria-valuetext={`Task history ${Math.round(historySize)} percent`}
          >
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-transparent group-hover:bg-green-500/50 group-focus-visible:bg-green-500 group-data-[resize-handle-state=drag]:bg-green-500" />
          </PanelResizeHandle>
          <Panel
            id="task-surface"
            order={2}
            defaultSize={66}
            minSize={40}
            style={{ transition: panelTransition }}
          >
            <LiveTaskSurface {...props.live} />
          </Panel>
        </PanelGroup>
      )}
    </section>
  )
}
