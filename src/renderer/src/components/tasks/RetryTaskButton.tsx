import { useEffect, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import type { TaskSession } from '@renderer/lib/task-session-store'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

interface RetryAvailability {
  available: boolean
  reason?: string
  executionDeviceName?: string
  phases?: ReadonlyArray<{ index: number; title: string }>
  activePhaseIndex?: number
}

const STOPPING_REASON = 'The earlier run is still stopping.'
const STOPPING_RECHECK_MS = 500

/** One retry control for task details and linked Chat work cards. */
export function RetryTaskButton({
  task,
  onStarted
}: Readonly<{
  task: TaskSession
  onStarted?: (taskId: string) => void
}>): React.JSX.Element | null {
  const [availability, setAvailability] = useState<RetryAvailability | null>(null)
  const [retrying, setRetrying] = useState(false)
  const retrySupported = Boolean(window.api.tasks?.retryAvailability && window.api.tasks.retry)

  useEffect(() => {
    if (task.status !== 'failed' && task.status !== 'stopped') return
    const check = window.api.tasks?.retryAvailability
    if (!check) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      void check(task.taskId).then((result) => {
        if (!current) return
        setAvailability(result)
        if (!result.available && result.reason === STOPPING_REASON) {
          timer = setTimeout(refresh, STOPPING_RECHECK_MS)
        }
      })
    }
    refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [task.taskId, task.status])

  if (task.status !== 'failed' && task.status !== 'stopped') return null
  const resolvedAvailability = retrySupported
    ? availability
    : { available: false, reason: 'Retry is not available in this build.' }
  const unavailableLabel = resolvedAvailability?.executionDeviceName
    ? `Continue on ${resolvedAvailability.executionDeviceName}`
    : 'Continue unavailable'

  const actionLabel = task.status === 'stopped' ? 'Continue' : 'Retry'
  const continueTask = (phaseIndex?: number): void => {
    const retry = window.api.tasks?.retry
    if (!retry) return
    setRetrying(true)
    void retry(task.taskId, phaseIndex)
      .then((result) => {
        if (result.taskId) {
          onStarted?.(result.taskId)
          if (!onStarted) openTaskSidePanel({ taskId: result.taskId, kind: task.kind })
        } else {
          setAvailability(result)
        }
      })
      .catch(() => {
        setAvailability({
          available: false,
          reason: 'The task could not continue. Try again on the execution device.'
        })
      })
      .finally(() => setRetrying(false))
  }
  const earlierPhases =
    resolvedAvailability?.phases?.filter(
      (phase) => phase.index <= (resolvedAvailability.activePhaseIndex ?? phase.index)
    ) ?? []

  return (
    <div className="mt-2">
      <div className="flex items-stretch">
        <button
          type="button"
          disabled={retrying || resolvedAvailability?.available !== true}
          title={resolvedAvailability?.reason}
          className="border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => continueTask()}
        >
          {retrying
            ? 'Continuing...'
            : resolvedAvailability === null
              ? 'Checking...'
              : resolvedAvailability.available
                ? actionLabel
                : unavailableLabel}
        </button>
        {earlierPhases.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              asChild
              disabled={retrying || resolvedAvailability?.available !== true}
            >
              <button
                type="button"
                aria-label="Continue from a saved plan step"
                className="border border-l-0 border-neutral-700 px-1.5 text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500 focus-visible:border-green-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CaretDown aria-hidden className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-w-80 border-neutral-800 bg-neutral-950 text-neutral-200 shadow-none"
            >
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-neutral-500">
                Continue from plan step
              </DropdownMenuLabel>
              {earlierPhases.map((phase) => (
                <DropdownMenuItem
                  key={phase.index}
                  className="text-xs focus:bg-green-500/15 focus:text-green-300"
                  onSelect={() => continueTask(phase.index)}
                >
                  {phase.index + 1}. {phase.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {resolvedAvailability?.available === false && resolvedAvailability.reason ? (
        <p role="alert" className="mt-1.5 text-[10px] text-red-500">
          {resolvedAvailability.reason}
        </p>
      ) : null}
    </div>
  )
}
