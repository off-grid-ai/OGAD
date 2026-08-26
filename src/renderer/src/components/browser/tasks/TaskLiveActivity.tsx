import { useEffect, useMemo, useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { Button } from '@renderer/components/ui/button'
import { ChatThinkingBlock } from '@renderer/components/ChatThinkingBlock'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import {
  countTaskTraceSteps,
  isTaskPlanControlStep,
  taskExecutionPlanProgress
} from '../../../../../shared/task-execution-plan'
import type { TaskTab } from './task-types'

const LIVE_PHASE_LABEL: Partial<Record<NonNullable<TaskTab['phase']>, string>> = {
  preparing: 'Preparing task',
  observing: 'Capturing the current screen',
  thinking: 'Model working',
  acting: 'Performing the selected action',
  checking: 'Checking the visible result',
  waiting: 'Waiting for you',
  paused: 'Paused'
}

function lastVerifiedAction(steps: readonly string[]): string | undefined {
  return [...steps]
    .reverse()
    .find((step) =>
      /^(?:opened|navigated|click(?:ed)?|double_click|right_click|middle_click|triple_click|drag(?:ged)?|move to|type(?:d| text)?|hotkey|press(?:ed)?|key_down|key_up|scroll(?:ed)?)\b/i.test(
        step
      )
    )
}

function recentTraceUpdates(steps: readonly string[]): string[] {
  return steps.filter((step) => !isTaskPlanControlStep(step)).slice(-4)
}

export function TaskLiveActivity({ task }: { task: TaskTab }): React.JSX.Element | null {
  const [elapsed, setElapsed] = useState(0)
  const [expanded, setExpanded] = useState(true)
  const live = ['running', 'waiting', 'paused', 'reconnecting'].includes(task.status)
  const webReasoning = task.kind === 'web_use' ? task.currentReasoning?.trim() : undefined
  const hasWebReasoningState =
    task.kind === 'web_use' && (Boolean(webReasoning) || task.reasoningLive !== undefined)
  const traceStep = countTaskTraceSteps(task.steps)
  const currentStep = task.currentStep ?? traceStep
  const traceUpdates = useMemo(() => recentTraceUpdates(task.steps), [task.steps])
  const currentAction = task.currentAction?.trim() || traceUpdates.at(-1) || ''
  const phase = task.phase ?? (traceStep > 0 ? 'acting' : 'preparing')
  const activityKey = `${phase}:${currentStep}:${currentAction}`
  const progress = taskExecutionPlanProgress(task.steps)
  const milestone = progress?.plan.phases[progress.activePhaseIndex]?.title
  const decision = [...(task.stepDetails ?? [])]
    .reverse()
    .find((detail) => detail.decisionSummary || detail.decisionRationale)
  const verifiedAction = lastVerifiedAction(task.steps)
  const taskModelName = task.modelName?.trim() || task.modelId?.trim()
  const updates = traceUpdates.length ? traceUpdates : currentAction ? [currentAction] : []

  useEffect(() => {
    if (!live) return
    const startedAt = Date.now()
    const reset = window.setTimeout(() => setElapsed(0), 0)
    const timer = window.setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000))),
      1_000
    )
    return () => {
      window.clearTimeout(reset)
      window.clearInterval(timer)
    }
  }, [activityKey, live])

  if (!live && !hasWebReasoningState) return null
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
      <section
        data-testid="task-live-activity"
        aria-label={live ? 'Live model activity' : 'Model activity'}
        aria-live="polite"
        className="mx-2.5 mb-2 border border-green-500/30 bg-green-500/5 px-2.5 py-2 text-[9px]"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`h-2 w-2 shrink-0 rounded-full bg-green-500 ${live ? 'animate-pulse motion-reduce:animate-none' : ''}`}
          />
          <span className="shrink-0 uppercase tracking-wide text-green-500">
            {LIVE_PHASE_LABEL[phase] ?? phase}
          </span>
          {!expanded ? (
            <span className="min-w-0 truncate text-muted-foreground">
              Milestone: {milestone || 'Preparing the plan'}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
            Step {currentStep} | {elapsed}s
          </span>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="group h-5 px-1.5 text-[9px] font-normal uppercase tracking-wide text-muted-foreground"
            >
              {expanded ? 'Collapse' : 'Expand'}
              <CaretDown
                aria-hidden="true"
                className="size-3 transition-transform duration-150 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
              />
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:duration-150 motion-reduce:animate-none">
          <dl className="mt-2 grid gap-px overflow-hidden border border-border bg-border sm:grid-cols-2">
            <div className="bg-background px-2 py-1.5">
              <dt className="uppercase tracking-wide text-muted-foreground">Current milestone</dt>
              <dd className="mt-0.5 leading-4 text-foreground">
                {milestone || 'Preparing the plan'}
              </dd>
            </div>
            <div className="bg-background px-2 py-1.5">
              <dt className="uppercase tracking-wide text-muted-foreground">Current operation</dt>
              <dd className="mt-0.5 leading-4 text-foreground">
                {currentAction || 'Preparing the next update'}
              </dd>
            </div>
            <div className="bg-background px-2 py-1.5">
              <dt className="uppercase tracking-wide text-muted-foreground">Latest decision</dt>
              <dd className="mt-0.5 leading-4 text-foreground">
                {decision?.decisionSummary || 'Waiting for the first final decision'}
              </dd>
            </div>
            <div className="bg-background px-2 py-1.5">
              <dt className="uppercase tracking-wide text-muted-foreground">Visible evidence</dt>
              <dd className="mt-0.5 leading-4 text-foreground">
                {decision?.decisionRationale || verifiedAction || 'Waiting for a verified result'}
              </dd>
            </div>
          </dl>
          <p className="mt-1.5 truncate text-muted-foreground" title={taskModelName}>
            Active model: {taskModelName || 'Not recorded for this run'}
          </p>
          {hasWebReasoningState ? (
            <div className="mt-2 border-t border-green-500/20 pt-1.5">
              <ChatThinkingBlock
                className="max-w-full"
                content={
                  webReasoning ||
                  (task.reasoningLive
                    ? 'Waiting for model reasoning…'
                    : 'No model reasoning was returned.')
                }
                live={task.reasoningLive === true}
                label={task.reasoningLive ? 'Web Use thinking…' : 'Web Use reasoning complete'}
              />
            </div>
          ) : null}
          <div className="mt-2 border-t border-green-500/20 pt-1.5">
            <p className="uppercase tracking-wide text-muted-foreground">
              {live ? 'Live updates' : 'Final updates'}
            </p>
            <ol className="mt-1 space-y-0.5" aria-label="Recent live task updates">
              {(updates.length ? updates : ['Preparing the first live update']).map(
                (update, index) => (
                  <li
                    key={`${index}:${update}`}
                    className={
                      index === updates.length - 1
                        ? 'animate-in fade-in slide-in-from-bottom-1 leading-4 text-foreground duration-300 motion-reduce:animate-none'
                        : 'leading-4 text-muted-foreground'
                    }
                  >
                    <span className="mr-1.5 text-green-500">{index + 1}</span>
                    {update}
                  </li>
                )
              )}
            </ol>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
