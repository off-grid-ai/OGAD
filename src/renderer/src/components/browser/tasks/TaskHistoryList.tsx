import { useState } from 'react'
import { ArrowLeft, Brain, Eye, EyeSlash } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { TaskRunDetails } from './TaskRunDetails'
import { statusTone, tabLabel, taskTime, type TaskTab } from './task-types'
import { countTaskTraceSteps } from '../../../../../shared/task-execution-plan'

export function TaskHistoryList({
  tasks,
  active,
  expandedTaskId,
  onOpenDetails,
  onCloseDetails,
  onRetryStarted
}: {
  tasks: TaskTab[]
  active: TaskTab
  expandedTaskId: string | null
  onOpenDetails: (taskId: string) => void
  onCloseDetails: () => void
  onRetryStarted: (taskId: string) => void
}): React.JSX.Element {
  const [showScreenshots, setShowScreenshots] = useState(true)
  const [showDecisionDetails, setShowDecisionDetails] = useState(true)
  const detailTask = expandedTaskId
    ? (tasks.find((task) => task.taskId === expandedTaskId) ?? active)
    : null
  return (
    <aside
      aria-label="Task history"
      className="flex h-full min-h-0 flex-col border-r border-border bg-background"
    >
      <div className="border-b border-border px-3 py-2">
        {detailTask ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-1.5 text-[10px]"
              onClick={onCloseDetails}
              aria-label="Back to Task History"
            >
              <ArrowLeft size={13} /> Task History
            </Button>
            <div className="flex items-center gap-0.5">
              <Button
                type="button"
                size="icon"
                variant={showDecisionDetails ? 'secondary' : 'ghost'}
                className="h-6 w-6"
                onClick={() => setShowDecisionDetails((value) => !value)}
                aria-label={showDecisionDetails ? 'Hide decision details' : 'Show decision details'}
                title={showDecisionDetails ? 'Hide decision details' : 'Show decision details'}
                aria-pressed={showDecisionDetails}
              >
                <Brain size={13} />
              </Button>
              <Button
                type="button"
                size="icon"
                variant={showScreenshots ? 'secondary' : 'ghost'}
                className="h-6 w-6"
                onClick={() => setShowScreenshots((value) => !value)}
                aria-label={showScreenshots ? 'Hide screenshots' : 'Show screenshots'}
                title={showScreenshots ? 'Hide screenshots' : 'Show screenshots'}
                aria-pressed={showScreenshots}
              >
                {showScreenshots ? <Eye size={13} /> : <EyeSlash size={13} />}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Task history
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
            </p>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {detailTask ? (
          <TaskRunDetails
            task={detailTask}
            onRetryStarted={onRetryStarted}
            showScreenshots={showScreenshots}
            showDecisionDetails={showDecisionDetails}
          />
        ) : tasks.length ? (
          tasks.map((task) => (
            <div key={task.taskId} className="mb-1">
              <button
                type="button"
                onClick={() => onOpenDetails(task.taskId)}
                aria-current={active.taskId === task.taskId ? 'true' : undefined}
                className={`mb-1 w-full border px-2.5 py-2 text-left transition-colors last:mb-0 ${active.taskId === task.taskId ? 'border-border bg-muted text-foreground' : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground'}`}
                data-testid={`task-tab-${task.taskId}`}
              >
                <span className="flex items-center justify-between gap-2 text-[9px] uppercase tracking-wide">
                  <span className="text-green-500">{tabLabel(task)}</span>
                  <span className={statusTone(task.status)}>{task.status}</span>
                </span>
                <span className="mt-1 block truncate text-xs">{task.title}</span>
                <span className="mt-1 block truncate text-[9px] text-muted-foreground">
                  {task.executionDeviceName ? `${task.executionDeviceName} / ` : ''}
                  {taskTime(task.updatedAt)} / {countTaskTraceSteps(task.steps)}{' '}
                  {countTaskTraceSteps(task.steps) === 1 ? 'step' : 'steps'}
                </span>
              </button>
            </div>
          ))
        ) : (
          <p className="px-2 py-3 text-[10px] leading-4 text-muted-foreground">
            Completed tasks stay here.
          </p>
        )}
      </div>
    </aside>
  )
}
