import { useEffect, useState } from 'react'
import type { TaskSession } from '@renderer/lib/task-session-store'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'

interface RetryAvailability {
  available: boolean
  reason?: string
  executionDeviceName?: string
}

/** One retry control for task details and linked Chat work cards. */
export function RetryTaskButton({
  task
}: Readonly<{ task: TaskSession }>): React.JSX.Element | null {
  const [availability, setAvailability] = useState<RetryAvailability | null>(null)
  const [retrying, setRetrying] = useState(false)
  const retrySupported = Boolean(window.api.tasks?.retryAvailability && window.api.tasks.retry)

  useEffect(() => {
    if (task.status !== 'failed') return
    const check = window.api.tasks?.retryAvailability
    if (!check) return
    let current = true
    void check(task.taskId).then((result) => {
      if (current) setAvailability(result)
    })
    return () => {
      current = false
    }
  }, [task.taskId, task.status])

  if (task.status !== 'failed') return null
  const resolvedAvailability = retrySupported
    ? availability
    : { available: false, reason: 'Retry is not available in this build.' }
  const unavailableLabel = resolvedAvailability?.executionDeviceName
    ? `Retry on ${resolvedAvailability.executionDeviceName}`
    : 'Retry unavailable'

  return (
    <button
      type="button"
      disabled={retrying || resolvedAvailability?.available !== true}
      title={resolvedAvailability?.reason}
      className="mt-2 border border-neutral-700 px-2 py-1 text-[10px] text-neutral-300 hover:border-green-500 hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-50"
      onClick={() => {
        const retry = window.api.tasks?.retry
        if (!retry) return
        setRetrying(true)
        void retry(task.taskId).then((result) => {
          setRetrying(false)
          if (result.taskId) {
            openTaskSidePanel({ taskId: result.taskId, kind: task.kind })
          } else {
            setAvailability(result)
          }
        })
      }}
    >
      {retrying
        ? 'Retrying...'
        : resolvedAvailability === null
          ? 'Checking retry...'
          : resolvedAvailability.available
            ? 'Retry'
            : unavailableLabel}
    </button>
  )
}
