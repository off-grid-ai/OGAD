import type { TaskGuideAvailability, TaskGuideResult } from './task-guide'
import type { TaskGuideInput } from '@offgrid/automation'

type GuideIpcHandler = (_event: unknown, ...args: unknown[]) => Promise<unknown> | unknown

export interface TaskGuideIpcBoundary {
  handle(channel: string, handler: GuideIpcHandler): void
}

export interface TaskGuideCommands {
  availability(taskId: string): Promise<TaskGuideAvailability> | TaskGuideAvailability
  guide(taskId: string, input: TaskGuideInput): Promise<TaskGuideResult>
}

const invalidTask = (): TaskGuideAvailability => ({
  available: false,
  reason: 'This task is no longer available.'
})

export function registerTaskGuideIpc(ipc: TaskGuideIpcBoundary, commands: TaskGuideCommands): void {
  ipc.handle('tasks:guide-availability', (_event, taskId) =>
    typeof taskId === 'string' ? commands.availability(taskId) : invalidTask()
  )
  ipc.handle('tasks:guide', (_event, taskId, input) =>
    typeof taskId === 'string' && input !== null && typeof input === 'object'
      ? commands.guide(taskId, input as TaskGuideInput)
      : invalidTask()
  )
}
