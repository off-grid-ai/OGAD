/** Composition root for task history, guidance, and retry IPC. */
import { ipcMain } from 'electron'
import { initializeTaskHistory, listTaskRuns, removeTaskRuns } from './task-history'
import { registerTaskRetryIpc } from './task-retry-ipc'
import { registerTaskGuideIpc } from './task-guide-ipc'
import { configureTaskRetryRunner } from './task-retry'

export function registerTaskHistoryIpc(): void {
  initializeTaskHistory()
  configureTaskRetryRunner({
    async web(task, taskId, checkpoint) {
      const { getBrowserRailHost } = await import('../browser/browser-host')
      return getBrowserRailHost().runTask({
        goal: task.title,
        url: task.lastUrl,
        taskId,
        journeyId: task.journeyId,
        checkpoint
      })
    },
    async computer(task, taskId, checkpoint) {
      const [{ getVisionRailHost }, { getAxRailHost }, { axRailViable }] = await Promise.all([
        import('../vision/vision-host'),
        import('../accessibility/ax-host'),
        import('../accessibility/ax-router')
      ])
      const runVision = async (
        recoveryCheckpoint = checkpoint,
        continuation?: import('../vision/vision-agent').VisionTaskContinuation,
        targetLabel?: string
      ) => {
        return getVisionRailHost().runTask(
          task.title,
          taskId,
          task.journeyId,
          recoveryCheckpoint,
          continuation,
          targetLabel
        )
      }
      const axHost = getAxRailHost()
      const routing = await axHost.routingSnapshot(task.title)
      if (routing && axRailViable(routing.snapshot)) {
        return axHost.runTask(task.title, taskId, routing.app, routing.snapshot, {
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
