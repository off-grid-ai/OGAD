/** Electron binding for the durable task-run projection. */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { getDB } from '../database'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import { TaskHistoryStore, type TaskRunSnapshot, type TaskRunUpdate } from './task-history-store'
import { sanitizeComputerUseStepDetail, type ComputerUseStepDetail } from './task-step-details'
import { registerTaskRetryIpc } from './task-retry-ipc'
import { registerTaskGuideIpc } from './task-guide-ipc'
import { persistTaskResultInChat } from './task-result-chat'
import { notifyRagConversationChanged } from '../rag-conversation-events'

let store: TaskHistoryStore | null = null
let executionDevice = {
  id: `desktop:${os.hostname()}`,
  name: os.hostname() || 'This computer'
}

/** Pro sync configures this with its stable mesh identity during activation. */
export function configureTaskExecutionDevice(device: { id: string; name: string }): void {
  const id = device.id.trim()
  const name = device.name.trim()
  if (!id || !name) return
  executionDevice = { id, name }
  if (store) recoverInterruptedTasks(id)
}

export function getTaskExecutionDevice(): Readonly<{ id: string; name: string }> {
  return executionDevice
}

function taskHistoryStore(): TaskHistoryStore {
  if (!store) {
    store = new TaskHistoryStore(getDB())
    store.migrate()
  }
  return store
}

export function getTaskRun(taskId: string): TaskRunSnapshot | undefined {
  return taskHistoryStore().get(taskId)
}

export function listTaskRuns(limit?: number): TaskRunSnapshot[] {
  return taskHistoryStore().list(limit)
}

/** Stop one persisted local Web Use task when its in-memory browser owner is
 * absent, such as after a process restart. Returns false for remote, terminal,
 * native, and unknown tasks. */
export function stopOrphanedLocalWebTask(taskId: string): boolean {
  const stopped = taskHistoryStore().stopOrphanedLocalWebTask(taskId, executionDevice.id)
  if (!stopped) return false
  publishTaskRun(stopped)
  return true
}

function broadcast(snapshot: TaskRunSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tasks:changed', snapshot)
  }
}

function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'task-run-snapshots')
}

export function taskScreenshotPath(taskId: string, stepId?: string | number): string {
  const dir = snapshotsDir()
  fs.mkdirSync(dir, { recursive: true })
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeStepId =
    stepId === undefined ? '' : `-${String(stepId).replace(/[^a-zA-Z0-9_-]/g, '_')}`
  return path.join(dir, `${safeTaskId}${safeStepId}.png`)
}

function pruneSnapshots(): void {
  const dir = snapshotsDir()
  if (!fs.existsSync(dir)) return
  const keep = new Set(
    taskHistoryStore()
      .list()
      .flatMap((task) => [
        task.screenshotPath,
        ...(task.stepDetails ?? []).map((detail) => detail.screenshot?.path)
      ])
      .filter((value): value is string => typeof value === 'string')
      .map((value) => path.resolve(value))
  )
  for (const entry of fs.readdirSync(dir)) {
    const target = path.resolve(dir, entry)
    if (!keep.has(target)) fs.rmSync(target, { force: true })
  }
}

export function recordTaskRun(update: TaskRunUpdate): TaskRunSnapshot {
  const snapshot = taskHistoryStore().upsert(update)
  if (persistTaskResultInChat(getDB(), snapshot) && snapshot.journeyId) {
    notifyRagConversationChanged({ conversationId: snapshot.journeyId })
  }
  publishTaskRun(snapshot)
  return snapshot
}

function publishTaskRun(snapshot: TaskRunSnapshot): void {
  pruneSnapshots()
  broadcast(snapshot)
  emitSyncMutation({
    entity: CORE_SYNC_ENTITIES.taskRun,
    entityId: snapshot.taskId,
    kind: 'put'
  })
}

function recoverInterruptedTasks(executionDeviceId: string): void {
  const history = taskHistoryStore()
  const interruptedIds = history
    .list()
    .filter(
      (task) =>
        ['running', 'paused', 'waiting', 'reconnecting'].includes(task.status) &&
        (!task.executionDeviceId || task.executionDeviceId === executionDeviceId)
    )
    .map((task) => task.taskId)
  history.recoverInterrupted(executionDeviceId)
  for (const taskId of interruptedIds) {
    const recovered = history.get(taskId)
    if (recovered) publishTaskRun(recovered)
  }
}

export function appendTaskStep(
  taskId: string,
  kind: TaskRunUpdate['kind'],
  title: string,
  step: string
): TaskRunSnapshot {
  const snapshot = taskHistoryStore().appendStep(taskId, kind, title, step)
  publishTaskRun(snapshot)
  return snapshot
}

/** Persist one redacted, bounded planning-step record without changing orchestration state. */
export function appendComputerUseStepDetail(
  taskId: string,
  title: string,
  detail: ComputerUseStepDetail
): TaskRunSnapshot {
  return appendTaskStepDetail(taskId, 'computer_use', title, detail)
}

/** Persist one bounded operator decision for either visual surface. */
export function appendTaskStepDetail(
  taskId: string,
  kind: TaskRunUpdate['kind'],
  title: string,
  detail: ComputerUseStepDetail
): TaskRunSnapshot {
  const previous = taskHistoryStore().get(taskId)
  return recordTaskRun({
    taskId,
    kind,
    title,
    stepDetails: [...(previous?.stepDetails ?? []), sanitizeComputerUseStepDetail(detail)]
  })
}

export function registerTaskHistoryIpc(): void {
  recoverInterruptedTasks(executionDevice.id)
  ipcMain.handle('tasks:list', (_event, limit: unknown) =>
    taskHistoryStore().list(typeof limit === 'number' ? limit : undefined)
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

/** Test seam for a simulated process restart. */
export function resetTaskHistoryForTests(): void {
  store = null
}
