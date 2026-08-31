/** Electron binding for the durable task-run projection. */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import { getDB } from '../database'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from '../sync-mutation'
import { TaskHistoryStore, type TaskRunSnapshot, type TaskRunUpdate } from './task-history-store'
import { sanitizeComputerUseStepDetail, type ComputerUseStepDetail } from './task-step-details'
import { persistTaskResultInChat } from './task-result-chat'
import { notifyRagConversationChanged } from '../rag-conversation-events'
import { callHook, HOOKS } from '../bootstrap/hookRegistry'

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

export function taskScreenshotPath(
  taskId: string,
  stepId?: string | number,
  extension: 'png' | 'jpg' = 'png'
): string {
  const dir = snapshotsDir()
  fs.mkdirSync(dir, { recursive: true })
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeStepId =
    stepId === undefined ? '' : `-${String(stepId).replace(/[^a-zA-Z0-9_-]/g, '_')}`
  return path.join(dir, `${safeTaskId}${safeStepId}.${extension}`)
}

/** Apply a remote execution owner's immutable visual step to the existing task read model. */
export function materializeSyncedTaskVisualStep(
  taskId: string,
  detail: ComputerUseStepDetail
): TaskRunSnapshot | undefined {
  const snapshot = taskHistoryStore().materializeVisualStep(taskId, detail)
  if (!snapshot) return undefined
  latest.set(taskId, snapshot)
  broadcast(snapshot)
  return snapshot
}

/** Remove remote visual evidence after its immutable sync entity is tombstoned. */
export function removeSyncedTaskVisualStep(
  taskId: string,
  stepId: string
): TaskRunSnapshot | undefined {
  const current = taskHistoryStore().get(taskId)
  const removedPath = current?.stepDetails?.find((detail) => detail.stepId === stepId)?.screenshot
    ?.path
  const snapshot = taskHistoryStore().removeVisualStep(taskId, stepId)
  if (removedPath) fs.rmSync(removedPath, { force: true })
  if (!snapshot) return undefined
  latest.set(taskId, snapshot)
  broadcast(snapshot)
  return snapshot
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
  callHook(HOOKS.actionsObserveTaskResult, snapshot)
  // A durable write is the authority again: drop any live overlay it supersedes.
  live.delete(snapshot.taskId)
  latest.set(snapshot.taskId, snapshot)
  publishTaskRun(snapshot)
  return snapshot
}

/**
 * The DISPLAY-ONLY fields a streaming task may change many times per second. Anything outside this
 * set is a durable fact and belongs in recordTaskRun, so the split cannot quietly widen into
 * "sometimes we persist status".
 */
const LIVE_FIELDS = [
  'phase',
  'currentStep',
  'currentAction',
  'currentReasoning',
  'reasoningLive'
] as const
type LiveField = (typeof LIVE_FIELDS)[number]

/** Last snapshot known for a task, durable or live — so the live path never reads the DB. */
const latest = new Map<string, TaskRunSnapshot>()
/** Tasks whose live fields changed since the last broadcast. */
const live = new Map<string, TaskRunSnapshot>()
let liveFlush: ReturnType<typeof setTimeout> | null = null

/** ~10 broadcasts/sec. Fast enough to read as live, slow enough to leave the thread alone. */
const LIVE_BROADCAST_MS = 100

function flushLive(): void {
  liveFlush = null
  for (const [taskId, snapshot] of live) {
    latest.set(taskId, snapshot)
    broadcast(snapshot)
  }
  live.clear()
}

/**
 * Publish streaming progress WITHOUT touching the database.
 *
 * Reasoning tokens and pointer moves arrive ~30x/sec and are on screen for a frame. Routing them
 * through recordTaskRun made each one a durable full-row write plus two full-snapshot broadcasts:
 * a SELECT *, a step-trace JSON.parse, a rewrite of all 24 columns, a broadcast, then a sync op
 * whose rematerialize scanned the whole op log — 2,568 times in a single task from onReasoning
 * alone. Profiled during a live web_use run the main thread was fully saturated, 35% of it in that
 * one parse.
 *
 * So live state is held in memory by this one owner and broadcast on a coalesced timer. The
 * database keeps only durable transitions (step boundaries, status changes, completion), which is
 * what it is for: nothing here is a fact worth surviving a crash, and the next durable write
 * carries the current values with it.
 */
export function reportTaskProgress(
  update: TaskRunUpdate & Partial<Pick<TaskRunSnapshot, LiveField>>
): void {
  const current = latest.get(update.taskId) ?? live.get(update.taskId) ?? getTaskRun(update.taskId)
  // No row yet, or the update carries a fact worth surviving a crash: persist it.
  if (!current || changesDurableFact(update, current)) {
    recordTaskRun(update)
    return
  }
  const next: TaskRunSnapshot = { ...current }
  for (const field of LIVE_FIELDS) {
    const value = (update as unknown as Record<string, unknown>)[field]
    if (value !== undefined) (next as unknown as Record<string, unknown>)[field] = value
  }
  live.set(update.taskId, next)
  liveFlush ??= setTimeout(flushLive, LIVE_BROADCAST_MS)
  // Never hold the process open for a display refresh.
  ;(liveFlush as { unref?: () => void }).unref?.()
}

/**
 * Does this update change anything that is not display state?
 *
 * The decision lives HERE, not at the call sites. A caller reports what it observed; whether that
 * is worth a disk write is this owner's business. Putting it in the callers is how "status" would
 * eventually get streamed 30x/sec again by whoever adds the next progress hook.
 *
 * Identity fields are excluded because every update repeats them unchanged.
 */
const IDENTITY_FIELDS = new Set(['taskId', 'journeyId', 'kind', 'at'])
function changesDurableFact(update: TaskRunUpdate, current: TaskRunSnapshot): boolean {
  const liveFields = new Set<string>(LIVE_FIELDS)
  for (const [key, value] of Object.entries(update)) {
    if (value === undefined || liveFields.has(key) || IDENTITY_FIELDS.has(key)) continue
    // Arrays/objects (steps, stepDetails) are always treated as a change — comparing them deeply
    // here would cost more than the write it saves, and they only arrive on real transitions.
    if (typeof value === 'object') return true
    if ((current as unknown as Record<string, unknown>)[key] !== value) return true
  }
  return false
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

export function initializeTaskHistory(): void {
  recoverInterruptedTasks(executionDevice.id)
}

/** Test seam for a simulated process restart. Live state is memory-only, so it goes too. */
export function resetTaskHistoryForTests(): void {
  store = null
  latest.clear()
  live.clear()
  if (liveFlush) clearTimeout(liveFlush)
  liveFlush = null
}
