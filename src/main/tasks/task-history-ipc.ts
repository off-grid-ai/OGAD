/** Composition root for task history, guidance, and retry IPC. */
import { ipcMain } from 'electron'
import {
  configureTaskControl,
  configureTaskRetryRunner,
  initializeTaskHistory,
  listTaskRuns
} from './task-history'
import { registerTaskRetryIpc } from './task-retry-ipc'
import { registerTaskGuideIpc } from './task-guide-ipc'
import { controlVisionTask } from '../vision/vision-controller'

export function registerTaskHistoryIpc(): void {
  initializeTaskHistory()
  configureTaskControl((taskId, intent) => controlVisionTask(intent, taskId))
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
      const [{ withGrounder }, { getVisionRailHost }] = await Promise.all([
        import('../vision/grounder-loader'),
        import('../vision/vision-host')
      ])
      const { result } = await withGrounder(() =>
        getVisionRailHost().runTask(task.title, taskId, task.journeyId, checkpoint)
      )
      return result
    }
  })
  ipcMain.handle('tasks:list', (_event, limit: unknown) =>
    listTaskRuns(typeof limit === 'number' ? limit : undefined)
  )
  registerTaskRetryIpc(ipcMain, {
    availability: async (taskId) => {
      const { getTaskRetryAvailability } = await import('./task-retry')
      return getTaskRetryAvailability(taskId)
    },
    retry: async (taskId) => {
      const { retryTask } = await import('./task-retry')
      return retryTask(taskId)
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
