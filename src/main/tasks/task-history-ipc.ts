/** Composition root for task history, guidance, and retry IPC. */
import { ipcMain } from 'electron'
import { initializeTaskHistory, listTaskRuns, removeTaskRuns } from './task-history'
import { registerTaskRetryIpc } from './task-retry-ipc'
import { registerTaskGuideIpc } from './task-guide-ipc'
import { configureTaskRetryRunner, type TaskRetryRunResult } from './task-retry'
import { runInRemoteScreenGate } from '../actions/remote-screen-gate'
import { withTaskModelMemory } from '../model-memory'
import type { ScreenTaskKind } from '../../shared/remote-screen-privacy'
import { forgetVisionStopBeforeStart, hasActiveVisionSession } from '../vision/vision-controller'

/** A retry runs in the same task context as a new run of its kind: the privacy gate, that task
 *  kind's own model settings and the task's model memory. */
function runRetryInTaskContext(
  taskKind: ScreenTaskKind,
  taskId: string,
  goal: string,
  run: () => Promise<TaskRetryRunResult>
): Promise<TaskRetryRunResult> {
  return runInRemoteScreenGate(taskKind, { id: taskId, goal }, () => withTaskModelMemory(run), {
    outcome: (result) =>
      result.ok
        ? { ok: true, detail: result.summary, effectId: taskId }
        : { ok: false, detail: result.summary },
    refused: (detail) => ({ ok: false, summary: detail ?? '' })
  })
}

export function registerTaskHistoryIpc(): void {
  initializeTaskHistory()
  configureTaskRetryRunner({
    isActive: hasActiveVisionSession,
    async web(task, taskId, checkpoint) {
      // A retry runs with the model-facing goal; the title is only the name a person reads.
      const goal = task.goal ?? task.title
      // Continue is a new run: a Stop sent to an earlier, never-started one does not apply.
      forgetVisionStopBeforeStart(taskId)
      // The same choice as a new task: Tasks > Web Use decides which browser a retry runs in.
      const { getWebUseRailHost } = await import('../browser/web-use-host')
      return runRetryInTaskContext('web_use', taskId, goal, () =>
        getWebUseRailHost().runTask({
          goal,
          url: task.lastUrl,
          taskId,
          journeyId: task.journeyId,
          checkpoint
        })
      )
    },
    async computer(task, taskId, checkpoint) {
      const goal = task.goal ?? task.title
      forgetVisionStopBeforeStart(taskId)
      const [{ getVisionRailHost }, { getAxRailHost }, { axRailViable }] = await Promise.all([
        import('../vision/vision-host'),
        import('../accessibility/ax-host'),
        import('../accessibility/ax-router')
      ])
      const runVision = async (
        recoveryCheckpoint = checkpoint,
        continuation?: import('../vision/vision-agent').VisionTaskContinuation,
        targetLabel?: string
      ): Promise<import('../vision/vision-agent').VisionTaskResult> => {
        return getVisionRailHost().runTask(
          goal,
          taskId,
          task.journeyId,
          recoveryCheckpoint,
          continuation,
          targetLabel
        )
      }
      return runRetryInTaskContext('computer_use', taskId, goal, async () => {
        const axHost = getAxRailHost()
        const routing = await axHost.routingSnapshot(goal)
        if (routing && axRailViable(routing.snapshot)) {
          return axHost.runTask(goal, taskId, routing.app, routing.snapshot, {
            journeyId: task.journeyId,
            checkpoint,
            recoverWithVision: async (recoveryCheckpoint, continuation) => {
              const result = await runVision(recoveryCheckpoint, continuation, routing.app)
              return result.ok
                ? {
                    ok: true,
                    effectId: taskId,
                    ...(result.performedActions?.length
                      ? { performedActions: result.performedActions }
                      : {})
                  }
                : { ok: false, detail: result.summary }
            }
          })
        }
        return runVision()
      })
    }
  })
  ipcMain.handle('tasks:list', (_event, limit: unknown) =>
    listTaskRuns(typeof limit === 'number' ? limit : undefined)
  )
  ipcMain.handle('tasks:remove', (_event, taskIds: unknown) =>
    removeTaskRuns(
      Array.isArray(taskIds)
        ? taskIds.filter((taskId): taskId is string => typeof taskId === 'string')
        : []
    )
  )
  registerTaskRetryIpc(ipcMain, {
    availability: async (taskId) => {
      const { getTaskRetryAvailability } = await import('./task-retry')
      return getTaskRetryAvailability(taskId)
    },
    retry: async (taskId, phaseIndex) => {
      const { retryTask } = await import('./task-retry')
      return retryTask(taskId, phaseIndex)
    }
  })
  registerTaskGuideIpc(ipcMain, {
    availability: async (taskId) => {
      const { taskGuideAvailability } = await import('./task-guide')
      return taskGuideAvailability(taskId)
    },
    guide: async (taskId, input) => {
      const { guideTask } = await import('./task-guide')
      return guideTask(taskId, input)
    }
  })
}
