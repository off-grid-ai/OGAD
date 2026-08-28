import { stopBrowserTask } from '../browser/browser-host'
import { controlVisionTask } from '../vision/vision-controller'
import type { TaskRunKind } from './task-history-store'

export type RemoteTaskControlKind = 'pause' | 'resume' | 'stop' | 'take_over'

export interface TaskControlRuntime {
  stopWebTask(taskId: string): boolean
  controlVisionTask(
    command: 'stop' | 'pause' | 'takeover' | 'resume',
    taskId: string
  ): boolean
}

const productionRuntime: TaskControlRuntime = {
  stopWebTask: stopBrowserTask,
  controlVisionTask
}

/**
 * Send a remote control intent to the task's existing local owner.
 *
 * Web Use and Computer Use both register their guard with VisionController. Web Stop keeps its
 * stronger BrowserHost path because that owner also resolves the current browser run lease.
 */
export function applyRemoteTaskControl(
  taskId: string,
  taskKind: TaskRunKind,
  control: RemoteTaskControlKind,
  runtime: TaskControlRuntime = productionRuntime
): boolean {
  if (taskKind === 'web_use' && control === 'stop') return runtime.stopWebTask(taskId)
  const command = control === 'take_over' ? 'takeover' : control
  return runtime.controlVisionTask(command, taskId)
}
