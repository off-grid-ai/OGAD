// What a paired browser sees of a web task it started: the plan, the phase it is on, the last
// few steps and the action in flight, as the desktop's own task view shows them. Pure.
//
// tasks.latest used to send only status and summary, so the browser could show nothing until
// the end. These fields are additive: an older browser reads status and summary as before.

import { isTaskPlanControlStep, taskExecutionPlanProgress } from '../../shared/task-execution-plan'
import type { TaskRunSnapshot } from '../tasks/task-history-store'

/** Steps sent, newest last: enough to follow along, never the whole trace. */
export const PROGRESS_STEPS = 6
const MAX_LINE = 200

export interface BrowserTaskProgress {
  readonly taskId: string
  readonly status: string
  readonly summary: string
  /** Phase titles in order; empty before the plan is made. */
  readonly plan: readonly string[]
  /** Index into `plan` of the phase in progress, or -1 with no plan. */
  readonly phase: number
  readonly steps: readonly string[]
  readonly action: string
}

const line = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 3)}...` : flat
}

export function browserTaskProgress(
  run: Pick<TaskRunSnapshot, 'taskId' | 'status' | 'summary' | 'steps' | 'currentAction'>
): BrowserTaskProgress {
  const progress = taskExecutionPlanProgress(run.steps)
  return {
    taskId: run.taskId,
    status: run.status,
    summary: run.summary ?? '',
    plan: progress?.plan.phases.map((p) => p.title) ?? [],
    phase: progress ? progress.activePhaseIndex : -1,
    steps: run.steps
      .filter((s) => !isTaskPlanControlStep(s))
      .map(line)
      .filter(Boolean)
      .slice(-PROGRESS_STEPS),
    action: line(run.currentAction ?? '')
  }
}
