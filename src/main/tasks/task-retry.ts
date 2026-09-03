/**
 * Task retry commands for the IPC root. Availability (only failed, no live attempt in the journey,
 * only on the execution device), the checkpoint, the planning goal, and the resume orchestration
 * are `@offgrid/automation`'s (`TaskRetryService` inside `AutomationApplication`).
 */
import type { TaskRetryAvailability, TaskRetryResult } from '@offgrid/automation'
import { taskAutomation } from './task-history'

export {
  retryPlanningGoal,
  TASK_RETRY_TRACE,
  type TaskRetryAvailability,
  type TaskRetryCheckpoint,
  type TaskRetryResult,
  type TaskRetryRunner
} from '@offgrid/automation'
export { configureTaskRetryRunner } from './task-history'

export function getTaskRetryAvailability(taskId: string): TaskRetryAvailability {
  return taskAutomation().retryAvailability(taskId)
}

export function retryTask(taskId: string): TaskRetryResult {
  return taskAutomation().retry(taskId)
}
