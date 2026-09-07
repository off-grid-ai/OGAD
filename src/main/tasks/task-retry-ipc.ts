import type { TaskRetryAvailability, TaskRetryResult } from './task-retry'

type RetryIpcHandler = (_event: unknown, taskId: unknown) => Promise<unknown> | unknown

export interface TaskRetryIpcBoundary {
  handle(channel: string, handler: RetryIpcHandler): void
}

export interface TaskRetryCommands {
  availability(taskId: string): Promise<TaskRetryAvailability> | TaskRetryAvailability
  retry(taskId: string): Promise<TaskRetryResult> | TaskRetryResult
}

const missingTask = (): TaskRetryAvailability => ({
  available: false,
  reason: 'This task is no longer in history.'
})

/** Bind the renderer intent to the retry service without duplicating policy in IPC. */
export function registerTaskRetryIpc(ipc: TaskRetryIpcBoundary, commands: TaskRetryCommands): void {
  ipc.handle('tasks:retry-availability', (_event, taskId) =>
    typeof taskId === 'string' ? commands.availability(taskId) : missingTask()
  )
  ipc.handle('tasks:retry', (_event, taskId) =>
    typeof taskId === 'string' ? commands.retry(taskId) : missingTask()
  )
}
