/** Electron binding for the durable task-run projection. */
import fs from 'fs'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { getDB } from '../database'
import { TaskHistoryStore, type TaskRunSnapshot, type TaskRunUpdate } from './task-history-store'

let store: TaskHistoryStore | null = null

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

function broadcast(snapshot: TaskRunSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tasks:changed', snapshot)
  }
}

function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'task-run-snapshots')
}

export function taskScreenshotPath(taskId: string): string {
  const dir = snapshotsDir()
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`)
}

function pruneSnapshots(): void {
  const dir = snapshotsDir()
  if (!fs.existsSync(dir)) return
  const keep = new Set(
    taskHistoryStore()
      .list()
      .map((task) => task.screenshotPath)
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
  pruneSnapshots()
  broadcast(snapshot)
  return snapshot
}

export function appendTaskStep(
  taskId: string,
  kind: TaskRunUpdate['kind'],
  title: string,
  step: string
): TaskRunSnapshot {
  const snapshot = taskHistoryStore().appendStep(taskId, kind, title, step)
  pruneSnapshots()
  broadcast(snapshot)
  return snapshot
}

export function registerTaskHistoryIpc(): void {
  taskHistoryStore().recoverInterrupted()
  ipcMain.handle('tasks:list', (_event, limit: unknown) =>
    taskHistoryStore().list(typeof limit === 'number' ? limit : undefined)
  )
}

/** Test seam for a simulated process restart. */
export function resetTaskHistoryForTests(): void {
  store = null
}
