import { useSyncExternalStore } from 'react'
import type { TaskPanelKind } from './task-side-panel'
import type {
  ComputerUsePhase,
  ComputerUseStepDetail
} from '../../../shared/computer-use-step-detail'

export type {
  ComputerUsePhase,
  ComputerUseStepDetail
} from '../../../shared/computer-use-step-detail'

export type TaskSessionStatus =
  | 'running'
  | 'paused'
  | 'waiting'
  | 'reconnecting'
  | 'done'
  | 'failed'
  | 'stopped'

export interface TaskSession {
  taskId: string
  journeyId?: string
  modelId?: string
  modelName?: string
  kind: TaskPanelKind
  title: string
  status: TaskSessionStatus
  summary?: string
  steps: string[]
  startedAt: number
  finishedAt?: number
  updatedAt: number
  executionDeviceId?: string
  executionDeviceName?: string
  phase?: ComputerUsePhase
  currentStep?: number
  currentAction?: string
  currentReasoning?: string
  reasoningLive?: boolean
  lastUrl?: string
  lastTitle?: string
  /** Device-local path. Synced tasks can omit it and still show their trace. */
  screenshotPath?: string
  screenshotDeviceId?: string
  stepDetails?: ComputerUseStepDetail[]
}

interface TaskSessionState {
  tasks: TaskSession[]
  ready: boolean
  lastChangedTaskId: string | null
}

let state: TaskSessionState = { tasks: [], ready: false, lastChangedTaskId: null }
let started = false
const listeners = new Set<() => void>()

function emit(next: TaskSessionState): void {
  state = next
  for (const listener of listeners) listener()
}

function sortTasks(tasks: TaskSession[]): TaskSession[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt || b.taskId.localeCompare(a.taskId))
}

const TERMINAL_TASK_STATUSES = new Set<TaskSessionStatus>(['done', 'failed', 'stopped'])

/** Never let an older live event regress the durable task projection. At the
 * same timestamp, a terminal state wins because it closes the run. */
export function latestTaskSession(current: TaskSession, incoming: TaskSession): TaskSession {
  if (incoming.updatedAt !== current.updatedAt) {
    return incoming.updatedAt > current.updatedAt ? incoming : current
  }
  const currentTerminal = TERMINAL_TASK_STATUSES.has(current.status)
  const incomingTerminal = TERMINAL_TASK_STATUSES.has(incoming.status)
  if (currentTerminal !== incomingTerminal) return incomingTerminal ? incoming : current
  return incoming
}

function upsert(task: TaskSession): void {
  const current = state.tasks.find((item) => item.taskId === task.taskId)
  const nextTask = current ? latestTaskSession(current, task) : task
  // A stale event changes nothing. In particular, it must not publish this task as the latest
  // changed task, because task selection treats that signal as a request for user attention.
  if (current && nextTask === current) return
  emit({
    tasks: sortTasks(
      current
        ? state.tasks.map((item) => (item.taskId === task.taskId ? nextTask : item))
        : [nextTask, ...state.tasks]
    ),
    ready: true,
    lastChangedTaskId: task.taskId
  })
}

function start(): void {
  if (started) return
  started = true
  const api = window.api.tasks
  if (!api || typeof api.list !== 'function' || typeof api.onChanged !== 'function') {
    emit({ ...state, ready: true })
    return
  }
  void api.list(50).then((tasks) => {
    const liveById = new Map(state.tasks.map((task) => [task.taskId, task]))
    for (const persisted of tasks as TaskSession[]) {
      const current = liveById.get(persisted.taskId)
      liveById.set(persisted.taskId, current ? latestTaskSession(current, persisted) : persisted)
    }
    emit({
      tasks: sortTasks([...liveById.values()]),
      ready: true,
      lastChangedTaskId: state.lastChangedTaskId
    })
  })
  api.onChanged((task) => upsert(task as TaskSession))
}

export function subscribeTaskSessions(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getTaskSessionState(): TaskSessionState {
  return state
}

export function useTaskSessions(): TaskSessionState {
  return useSyncExternalStore(subscribeTaskSessions, getTaskSessionState, getTaskSessionState)
}

/** One scope rule for every Chat-owned task surface. A fresh Chat has no owner
 * yet, so it keeps the product rule of showing the global task history. */
export function taskSessionsForJourney<T extends Pick<TaskSession, 'journeyId'>>(
  tasks: readonly T[],
  journeyId: string | null | undefined
): T[] {
  return journeyId ? tasks.filter((task) => task.journeyId === journeyId) : [...tasks]
}

const GUIDABLE_TASK_STATUSES = new Set<TaskSessionStatus>([
  'running',
  'paused',
  'waiting',
  'reconnecting'
])

/** The one live task that owns new user input for a Chat journey. */
export function guidanceTaskForJourney<
  T extends Pick<TaskSession, 'journeyId' | 'status' | 'updatedAt'>
>(tasks: readonly T[], journeyId: string | null | undefined): T | null {
  if (!journeyId) return null
  return (
    tasks
      .filter((task) => task.journeyId === journeyId && GUIDABLE_TASK_STATUSES.has(task.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  )
}

export function taskAttentionCount(tasks: readonly TaskSession[]): number {
  return tasks.filter(
    (task) =>
      task.status === 'running' ||
      task.status === 'paused' ||
      task.status === 'waiting' ||
      task.status === 'reconnecting' ||
      task.status === 'failed' ||
      task.status === 'stopped'
  ).length
}

/** Test-only reset keeps production state private while making behavior tests independent. */
export function resetTaskSessionStoreForTests(): void {
  state = { tasks: [], ready: false, lastChangedTaskId: null }
  started = false
  listeners.clear()
}
