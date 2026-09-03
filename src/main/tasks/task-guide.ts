/**
 * Task guidance commands for the IPC root and the task hosts. Text and attachment admission,
 * availability, the in-memory guidance rule, and the persisted trace are `@offgrid/automation`'s
 * (`AutomationApplication.guide`); attachments are read through this process's upload port.
 */
import type {
  TaskGuideAvailability,
  TaskGuideHandler,
  TaskGuideInput,
  TaskGuideResult
} from '@offgrid/automation'
import { taskAutomation } from './task-history'

export {
  TASK_GUIDANCE_APPLIED_TRACE,
  TASK_GUIDANCE_TRACE,
  type TaskGuideAvailability,
  type TaskGuideHandler,
  type TaskGuideResult
} from '@offgrid/automation'

export function registerTaskGuideHandler(taskId: string, handler: TaskGuideHandler): () => void {
  return taskAutomation().registerGuideHandler(taskId, handler)
}

export function taskGuideAvailability(taskId: string): TaskGuideAvailability {
  return taskAutomation().guideAvailability(taskId)
}

export function guideTask(taskId: string, input: TaskGuideInput): Promise<TaskGuideResult> {
  return taskAutomation().guide(taskId, input)
}
