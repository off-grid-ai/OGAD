import { useCallback, useEffect, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ComputerUseStepDetails } from '@renderer/components/tasks/ComputerUseStepDetails'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import { taskTime, type TaskTab } from './task-types'
import { TaskGuideComposer } from './TaskGuideComposer'
import { TaskExecutionPlanView } from './TaskExecutionPlanView'
import { TaskLiveActivity } from './TaskLiveActivity'
import {
  countTaskTraceSteps,
  decodeTaskExecutionPlan,
  isTaskPlanControlStep
} from '../../../../../shared/task-execution-plan'

function guidanceLabel(step: string): string | null {
  if (step.startsWith('GUIDANCE ACCEPTED · ')) return 'Accepted. Applying to the next decision.'
  if (step.startsWith('GUIDANCE APPLIED · ')) return 'Applied to the next decision.'
  // Old builds stored private guidance after this prefix. Never render it.
  if (step.startsWith('USER GUIDANCE · ')) return 'Accepted. Applying to the next decision.'
  return null
}

interface RetryAvailability {
  available: boolean
  reason?: string
  executionDeviceName?: string
}

function retryButtonLabel(retrying: boolean, availability: RetryAvailability | null): string {
  if (retrying) return 'Retrying…'
  if (availability?.available) return 'Retry failed step'
  if (availability?.executionDeviceName) return `Retry on ${availability.executionDeviceName}`
  return 'Retry failed step'
}

function LegacySteps({
  steps,
  guidanceMessages = []
}: {
  steps: readonly string[]
  guidanceMessages?: readonly string[]
}): React.JSX.Element {
  const visibleSteps = steps.filter((step) => !isTaskPlanControlStep(step))
  let guidanceIndex = 0
  if (!visibleSteps.length) {
    return <p className="text-[10px] text-muted-foreground">No steps were recorded.</p>
  }
  return (
    <ol className="space-y-1" aria-label="Ordered task steps">
      {visibleSteps.map((step, index) => {
        const guidance = guidanceLabel(step)
        const guidanceMessage =
          step.startsWith('GUIDANCE ACCEPTED · ') || step.startsWith('USER GUIDANCE · ')
            ? guidanceMessages[guidanceIndex++]
            : undefined
        return (
          <li
            key={`${index}-${step}`}
            className="flex gap-2 border-b border-border py-2 text-[10px] text-muted-foreground"
          >
            <span className="text-green-500">{index + 1}</span>
            <span>
              {guidance ? (
                <>
                  <span className="mr-1.5 border border-green-500/40 px-1 py-0.5 text-[8px] uppercase tracking-wide text-green-500">
                    User guidance
                  </span>
                  {guidanceMessage || guidance}
                </>
              ) : (
                step
              )}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function TaskEvidence({
  task,
  guidanceMessages,
  showScreenshots,
  showDecisionDetails
}: {
  task: TaskTab
  guidanceMessages: readonly string[]
  showScreenshots: boolean
  showDecisionDetails: boolean
}): React.JSX.Element {
  const hasPlan = task.steps.some((step) => decodeTaskExecutionPlan(step) !== null)
  const guidance = task.steps.filter((step) => guidanceLabel(step) !== null)
  const ordinarySteps = task.steps.filter((step) => guidanceLabel(step) === null)
  return (
    <>
      {showScreenshots && task.screenshotPath ? (
        <img
          src={captureUrlForPath(task.screenshotPath)}
          alt="Latest task screenshot"
          className="mb-3 max-h-48 w-full border border-border object-contain"
        />
      ) : null}
      {hasPlan ? (
        <TaskExecutionPlanView
          task={task}
          guidanceMessages={guidanceMessages}
          showScreenshots={showScreenshots}
          showDecisionDetails={showDecisionDetails}
        />
      ) : task.stepDetails?.length ? (
        <>
          {guidance.length ? (
            <LegacySteps steps={guidance} guidanceMessages={guidanceMessages} />
          ) : null}
          <ComputerUseStepDetails details={task.stepDetails} showScreenshots={showScreenshots} />
        </>
      ) : (
        <LegacySteps
          steps={ordinarySteps.length || !guidance.length ? task.steps : guidance}
          guidanceMessages={guidanceMessages}
        />
      )}
      {task.summary ? <p className="mt-2 text-[10px] text-foreground">{task.summary}</p> : null}
    </>
  )
}

export function TaskRunDetails({
  task,
  onRetryStarted,
  showScreenshots,
  showDecisionDetails
}: {
  task: TaskTab
  onRetryStarted: (taskId: string) => void
  showScreenshots: boolean
  showDecisionDetails: boolean
}): React.JSX.Element {
  const [retryAvailability, setRetryAvailability] = useState<RetryAvailability | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [guidanceMessages, setGuidanceMessages] = useState<string[]>([])

  const loadGuidanceMessages = useCallback(async (): Promise<void> => {
    if (!task.journeyId || task.journeyId === task.taskId) {
      setGuidanceMessages([])
      return
    }
    const getMessages = (window.api as Partial<Pick<typeof window.api, 'getRagMessages'>>)
      .getRagMessages
    if (!getMessages) {
      setGuidanceMessages([])
      return
    }
    const rows = await getMessages(task.journeyId)
    const messages = rows.flatMap((row) => {
      let context = row.context as
        | { taskGuidance?: { taskId?: string } }
        | string
        | null
        | undefined
      if (typeof context === 'string') {
        try {
          context = JSON.parse(context) as { taskGuidance?: { taskId?: string } }
        } catch {
          return []
        }
      }
      return context?.taskGuidance?.taskId === task.taskId ? [row.content] : []
    })
    setGuidanceMessages(messages)
  }, [task.journeyId, task.taskId])

  useEffect(() => {
    void loadGuidanceMessages()
    const refresh = (event: Event): void => {
      const conversationId = (event as CustomEvent<{ conversationId?: string }>).detail
        .conversationId
      if (conversationId === task.journeyId) void loadGuidanceMessages()
    }
    window.addEventListener('og:task-guidance-message', refresh)
    return () => window.removeEventListener('og:task-guidance-message', refresh)
  }, [loadGuidanceMessages, task.journeyId])

  useEffect(() => {
    if (task.status !== 'failed') return
    let active = true
    const availability = window.api.tasks?.retryAvailability
    if (!availability) {
      setRetryAvailability({
        available: false,
        reason: 'Retry is unavailable until the desktop app finishes updating.'
      })
      return
    }
    void availability(task.taskId).then((result) => {
      if (active) setRetryAvailability(result)
    })
    return () => {
      active = false
    }
  }, [task.status, task.taskId])

  const retry = async (): Promise<void> => {
    setRetrying(true)
    try {
      const retryTask = window.api.tasks?.retry
      if (!retryTask) {
        setRetryAvailability({
          available: false,
          reason: 'Retry is unavailable until the desktop app finishes updating.'
        })
        return
      }
      const result = await retryTask(task.taskId)
      if (result.available && result.taskId) {
        setRetryAvailability(result)
        onRetryStarted(result.taskId)
      } else {
        setRetryAvailability({
          available: false,
          reason: result.reason || 'Retry did not resume this task.'
        })
      }
    } catch {
      setRetryAvailability({
        available: false,
        reason: 'Retry could not start. Try again on the execution device.'
      })
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div data-testid={`task-details-${task.taskId}`} className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="relative mb-3 border-b border-border pb-3">
          <p className="mb-1 text-[9px] uppercase tracking-wide text-muted-foreground">
            Task record
          </p>
          <p className="text-xs text-foreground">{task.title}</p>
          <p className="mt-1 text-[9px] uppercase tracking-wide text-muted-foreground">
            {task.status} / {countTaskTraceSteps(task.steps)} steps / {taskTime(task.updatedAt)}
          </p>
          <p className="mt-1 text-[9px] text-muted-foreground">
            {task.executionDeviceName || 'Unknown device'} / started {taskTime(task.startedAt)}
            {task.finishedAt ? ` / finished ${taskTime(task.finishedAt)}` : ''}
          </p>
        </div>
        <TaskEvidence
          task={task}
          guidanceMessages={guidanceMessages}
          showScreenshots={showScreenshots}
          showDecisionDetails={showDecisionDetails}
        />
        {task.status === 'failed' ? (
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[10px]"
              onClick={() => void retry()}
              disabled={retrying || retryAvailability?.available !== true}
              title={retryAvailability?.reason}
            >
              {retryButtonLabel(retrying, retryAvailability)}
            </Button>
            {retryAvailability?.available === false && retryAvailability.reason ? (
              <p role="alert" className="mt-1.5 text-[10px] text-red-500">
                {retryAvailability.reason}
              </p>
            ) : null}
          </div>
        ) : null}
        {task.journeyId && task.journeyId !== task.taskId ? (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2 h-7 text-[10px]"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('og:navigate', {
                  detail: { view: 'memory-chat', conversationId: task.journeyId }
                })
              )
            }
          >
            Return to originating Chat
          </Button>
        ) : null}
      </div>
      <TaskLiveActivity task={task} />
      {['running', 'paused', 'waiting', 'reconnecting'].includes(task.status) ? (
        <>
          <TaskGuideComposer taskId={task.taskId} journeyId={task.journeyId} />
        </>
      ) : null}
    </div>
  )
}
