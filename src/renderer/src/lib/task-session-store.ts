import { useSyncExternalStore } from 'react'
import type { TaskPanelKind } from './task-side-panel'

export type TaskSessionStatus = 'running' | 'paused' | 'done' | 'failed' | 'stopped'

export interface TaskSession {
  taskId: string
  kind: TaskPanelKind
  title: string
  status: TaskSessionStatus
  summary?: string
  steps: string[]
  startedAt: number
  finishedAt?: number
  updatedAt: number
  lastUrl?: string
  lastTitle?: string
  screenshotPath?: string
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

function upsert(task: TaskSession): void {
  const exists = state.tasks.some((item) => item.taskId === task.taskId)
  emit({
    tasks: sortTasks(
      exists
        ? state.tasks.map((item) => (item.taskId === task.taskId ? task : item))
        : [task, ...state.tasks]
    ),
    ready: true,
    lastChangedTaskId: task.taskId
  })
}

function start(): void {
  if (started) return
  started = true
  const api = window.api.tasks
  if (!api) {
    emit({ ...state, ready: true })
    return
  }
  void api.list(50).then((tasks) => {
    const liveById = new Map(state.tasks.map((task) => [task.taskId, task]))
    for (const persisted of tasks as TaskSession[]) {
      if (!liveById.has(persisted.taskId)) liveById.set(persisted.taskId, persisted)
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

export function taskAttentionCount(tasks: readonly TaskSession[]): number {
  return tasks.filter(
    (task) =>
      task.status === 'running' ||
      task.status === 'paused' ||
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
