import { controlVisionTask } from '../vision/vision-controller'
import type { TaskRunKind } from './task-history-store'

export type RemoteTaskControlKind = 'pause' | 'resume' | 'stop' | 'takeover'

export interface TaskControlRuntime {
  controlVisionTask(command: 'stop' | 'pause' | 'takeover' | 'resume', taskId: string): boolean
}

const productionRuntime: TaskControlRuntime = {
  controlVisionTask
}

/**
 * Send a remote control intent to the task's existing local owner.
 *
 * Web Use and Computer Use both register their shared guard with VisionController. All surfaces
 * send the same control intent to that owner.
 */
export function applyRemoteTaskControl(
  taskId: string,
  _taskKind: TaskRunKind,
  control: RemoteTaskControlKind,
  runtime: TaskControlRuntime = productionRuntime
): boolean {
  return runtime.controlVisionTask(control, taskId)
}
