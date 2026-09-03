/**
 * Electron binding of `AutomationApplication` (`@offgrid/automation`), the one owner of task-run
 * state. This module supplies the ports (SQLite rows, the execution-device fact, the retry runner,
 * Chat guidance, attachment reading, the live task controller) and forwards the application's
 * events to the renderer (IPC), to the Chat that started the task, and to screenshot files on disk.
 * It decides nothing about a task; Shared owns the Automation-to-Sync workflow.
 *
 * It keeps the function API its forty importers use during coexistence; construction moves into
 * the composition root when Agent A wires `AutomationFacade` (WIRING_C.md section 4).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, BrowserWindow } from 'electron'
import {
  isLocalTaskRunMutation,
  retryGuidanceFromMessages,
  type AutomationEvent,
  type AutomationTaskControlIntent,
  type ComputerUseStepDetail,
  type LiveTaskRunField,
  type TaskExecutionDevice,
  type TaskRetryRunner,
  type TaskRunSnapshot,
  type TaskRunUpdate
} from '@offgrid/automation'
import type { AutomationPlatformPorts } from '@offgrid/application'
import { getDB, getRagMessages } from '../database'
import { TaskHistoryStore } from './task-history-store'
import { persistTaskResultInChat } from './task-result-chat'
import { notifyRagConversationChanged } from '../rag-conversation-events'
import { callHook, HOOKS } from '../bootstrap/hookRegistry'
import { desktopAutomation } from '../composition/application-access'

let configuredRunner: TaskRetryRunner | null = null
let configuredControl: TaskControlPort | null = null

/** Sends a control intent to a task's live owner; false when nothing here owns the task. */
export type TaskControlPort = (taskId: string, intent: AutomationTaskControlIntent) => boolean

/** Bind the execution surfaces a retry resumes on at the process composition root. */
export function configureTaskRetryRunner(runner: TaskRetryRunner): void {
  configuredRunner = runner
}

/** Bind the live task controller at the process composition root. */
export function configureTaskControl(control: TaskControlPort): void {
  configuredControl = control
}

const lateBoundRunner: TaskRetryRunner = {
  web: (task, taskId, checkpoint) => requireRunner().web(task, taskId, checkpoint),
  computer: (task, taskId, checkpoint) => requireRunner().computer(task, taskId, checkpoint)
}

function requireRunner(): TaskRetryRunner {
  if (!configuredRunner) throw new Error('Task retry runner is not configured.')
  return configuredRunner
}

async function readGuidanceAttachment(
  name: string,
  bytes: Uint8Array
): Promise<{ kind: string; text: string }> {
  const { processUpload } = await import('../files')
  const processed = await processUpload(name, bytes, { persistPreview: false, captionImage: true })
  return { kind: processed.kind, text: processed.text }
}

/** Desktop I/O for the one Automation application constructed by the Shared root. */
export function createDesktopAutomationPorts(): AutomationPlatformPorts {
  const store = new TaskHistoryStore(getDB())
  store.migrate()
  return {
    history: store,
    device: {
      id: `desktop:${os.hostname()}`,
      name: os.hostname() || 'This computer'
    },
    retryRunner: lateBoundRunner,
    guidanceForTask: (task) =>
      retryGuidanceFromMessages(task.taskId, getRagMessages(task.journeyId)),
    attachments: { read: readGuidanceAttachment },
    control: (taskId, intent) => configuredControl?.(taskId, intent) ?? false
  }
}

/** Pro sync configures this with its stable mesh identity during activation. */
export function configureTaskExecutionDevice(device: TaskExecutionDevice): void {
  const id = device.id.trim()
  const name = device.name.trim()
  if (!id || !name) return
  desktopAutomation.execution.configureDevice({ id, name })
}

export function getTaskExecutionDevice(): Readonly<TaskExecutionDevice> {
  return desktopAutomation.execution.device()
}

export function getTaskRun(taskId: string): TaskRunSnapshot | undefined {
  return desktopAutomation.get(taskId)
}

export function listTaskRuns(limit?: number): TaskRunSnapshot[] {
  return [...desktopAutomation.list(limit)]
}

/** Stop one persisted local Web Use task when its in-memory browser owner is absent, such as
 * after a process restart. False for remote, terminal, native, and unknown tasks. */
export function stopOrphanedLocalWebTask(taskId: string): boolean {
  return desktopAutomation.execution.stopOrphanedLocalWebTask(taskId)
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
  return desktopAutomation.execution.materializeSyncedVisualStep(taskId, detail)
}

/** Remove remote visual evidence after its immutable sync entity is tombstoned. */
export function removeSyncedTaskVisualStep(
  taskId: string,
  stepId: string
): TaskRunSnapshot | undefined {
  const removedPath = desktopAutomation
    .get(taskId)
    ?.stepDetails?.find((detail) => detail.stepId === stepId)?.screenshot?.path
  const snapshot = desktopAutomation.execution.removeSyncedVisualStep(taskId, stepId)
  if (removedPath) fs.rmSync(removedPath, { force: true })
  return snapshot
}

/** Delete screenshot files no stored task references any more. */
function pruneSnapshots(tasks: readonly TaskRunSnapshot[]): void {
  const dir = snapshotsDir()
  if (!fs.existsSync(dir)) return
  const keep = new Set(
    tasks
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

export function forwardDesktopAutomationEvent(event: AutomationEvent): void {
  if (event.type === 'execution_device_changed') return
  if (event.type === 'task_run_live' || !isLocalTaskRunMutation(event)) {
    broadcast(event.snapshot)
    return
  }
  const snapshot = event.snapshot
  if (persistTaskResultInChat(getDB(), snapshot) && snapshot.journeyId) {
    notifyRagConversationChanged({ conversationId: snapshot.journeyId })
  }
  callHook(HOOKS.actionsObserveTaskResult, snapshot)
  pruneSnapshots(desktopAutomation.list())
  broadcast(snapshot)
}

export function recordTaskRun(update: TaskRunUpdate): TaskRunSnapshot {
  return desktopAutomation.execution.record(update)
}

/** Publish streaming progress; the application decides what is durable and what is display. */
export function reportTaskProgress(
  update: TaskRunUpdate & Partial<Pick<TaskRunSnapshot, LiveTaskRunField>>
): void {
  desktopAutomation.execution.reportProgress(update)
}

export function appendTaskStep(
  taskId: string,
  kind: TaskRunUpdate['kind'],
  title: string,
  step: string
): TaskRunSnapshot {
  return desktopAutomation.execution.appendStep(taskId, kind, title, step)
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
  return desktopAutomation.execution.appendStepDetail(taskId, kind, title, detail)
}

/** Hydrate the history and close every task this device can no longer own. */
export function initializeTaskHistory(): void {
  desktopAutomation.snapshot()
}

/** Compatibility seam. The Shared application root owns process lifecycle. */
export function resetTaskHistoryForTests(): void {
  void desktopAutomation.stop()
}
