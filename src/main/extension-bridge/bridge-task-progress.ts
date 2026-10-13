// What a paired browser sees of a web task it started (tasks.latest): the task's id, so it can
// stop it, and the plan, phase, steps and action the desktop's own task row shows. Pure.

import { isTaskPlanControlStep, taskExecutionPlanProgress } from '../../shared/task-execution-plan'
import type { TaskRunSnapshot } from '../tasks/task-history-store'
import type { BrowserTaskProgress } from './bridge-service'

type TaskRow = Pick<
  TaskRunSnapshot,
  'taskId' | 'status' | 'summary' | 'steps' | 'currentAction' | 'journeyId' | 'startedAt'
>

export function browserTaskProgress(run: TaskRow): BrowserTaskProgress {
  const progress = taskExecutionPlanProgress(run.steps)
  return {
    taskId: run.taskId,
    status: run.status,
    summary: run.summary ?? '',
    plan: progress?.plan.phases.map((phase) => phase.title) ?? [],
    phase: progress ? progress.activePhaseIndex : -1,
    steps: run.steps.filter((step) => !isTaskPlanControlStep(step)),
    action: run.status === 'running' ? (run.currentAction ?? '') : ''
  }
}

/** The newest task of this browser's journey started at or after `since`, as it sees it; with
 *  `taskId`, that one task, so a chat follows its own task while another chat starts one. */
export function latestBrowserTask(
  runs: readonly TaskRow[],
  journeyId: string,
  since: number,
  taskId?: string
): BrowserTaskProgress | null {
  // Rows come newest-updated first; the browser asks for the task it started last.
  const run = runs
    .filter((task) => task.journeyId === journeyId && task.startedAt >= since)
    .filter((task) => taskId === undefined || task.taskId === taskId)
    .reduce<TaskRow | null>((a, b) => (a && a.startedAt >= b.startedAt ? a : b), null)
  return run ? browserTaskProgress(run) : null
}

/** A task this browser's chat was given an id for, that has not started yet: queued behind
 *  another task, or waiting for approval. Its own id, so the chat follows and stops only it. */
export function queuedBrowserTask(taskId: string): BrowserTaskProgress {
  return {
    taskId,
    status: 'queued',
    summary: '',
    plan: [],
    phase: -1,
    steps: [],
    action: 'Waiting to start'
  }
}

/** The task ids each paired browser was given, by id: a chat follows and stops its own task by
 *  that id before task history has a row for it. Bounded: the oldest are forgotten first. */
export interface AcceptedTasks {
  remember(taskId: string, journeyId: string): void
  /** Whether `taskId` was given to this browser's journey. */
  owns(taskId: string, journeyId: string): boolean
}

export function createAcceptedTasks(limit = 200): AcceptedTasks {
  const byId = new Map<string, string>()
  return {
    remember(taskId, journeyId) {
      byId.delete(taskId)
      byId.set(taskId, journeyId)
      while (byId.size > limit) {
        const oldest = byId.keys().next().value
        if (oldest === undefined) break
        byId.delete(oldest)
      }
    },
    owns: (taskId, journeyId) => byId.get(taskId) === journeyId
  }
}

/** One browser task by its id: its history row when it has started, queued when it was given to
 *  this browser and has not, and nothing for anyone else's task. */
export function browserTaskById(
  run: TaskRow | null,
  accepted: AcceptedTasks,
  journeyId: string,
  since: number,
  taskId: string
): BrowserTaskProgress | null {
  if (run) return latestBrowserTask([run], journeyId, since, taskId)
  return accepted.owns(taskId, journeyId) ? queuedBrowserTask(taskId) : null
}

/** How Stop reaches a browser's task: through its running session, before it starts, or not at
 *  all (another browser's task, or one this browser was never given). */
export function stopRoute(
  run: Pick<TaskRow, 'journeyId'> | null,
  accepted: AcceptedTasks,
  journeyId: string,
  taskId: string
): 'running' | 'before-start' | null {
  if (run) return run.journeyId === journeyId ? 'running' : null
  return accepted.owns(taskId, journeyId) ? 'before-start' : null
}
