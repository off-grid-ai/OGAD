/**
 * The Computer Use supervisor bridge. One controller owns the active guard,
 * live state, and buffered step feed. The task-history port owns durable and
 * synced projections; renderers only receive read-only events.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { appendTaskStep, getTaskExecutionDevice, recordTaskRun } from '../tasks/task-history'
import type { TaskRunUpdate } from '../tasks/task-history-store'
import type { ComputerUsePhase } from '../tasks/task-step-details'
import type { VisionGuard } from './vision-guard'
import {
  automationTaskReadStatus,
  type AutomationTaskReadStatus,
  type AutomationTaskSnapshot
} from '@offgrid/automation'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export interface VisionTaskState {
  taskId: string
  journeyId?: string
  modelId?: string
  modelName?: string
  goal: string
  status: AutomationTaskReadStatus
  phase?: ComputerUsePhase
  currentStep?: number
  currentAction?: string
  executionDeviceId?: string
  executionDeviceName?: string
  summary?: string
  notice?: string
}

export interface VisionControllerPersistence {
  appendStep(taskId: string, title: string, step: string): void
  record(update: TaskRunUpdate): void
  executionDevice(): Readonly<{ id: string; name: string }>
}

const taskHistoryPersistence: VisionControllerPersistence = {
  appendStep: (taskId, title, step) => {
    appendTaskStep(taskId, 'computer_use', title, step)
  },
  record: (update) => {
    recordTaskRun(update)
  },
  executionDevice: getTaskExecutionDevice
}

export class VisionController {
  private readonly sessions = new Map<
    string,
    {
      guard: VisionGuard
      request: AbortController
      project?: (
        snapshot: AutomationTaskSnapshot,
        status: AutomationTaskReadStatus,
        currentAction: string
      ) => void
    }
  >()
  private readonly runs = new Map<string, { state: VisionTaskState; steps: string[] }>()
  private currentTaskId: string | null = null

  constructor(private readonly persistence: VisionControllerPersistence) {}

  registerSession(
    taskId: string,
    guard: VisionGuard,
    request: AbortController,
    project?: (
      snapshot: AutomationTaskSnapshot,
      status: AutomationTaskReadStatus,
      currentAction: string
    ) => void
  ): () => void {
    const previous = this.sessions.get(taskId)
    if (previous) {
      previous.guard.halt('replaced by a newer run for this task')
      previous.request.abort('replaced by a newer run for this task')
    }
    if (guard.taskId !== taskId) throw new Error('VisionGuard task identity does not match session')
    const session = { guard, request, project }
    this.sessions.set(taskId, session)
    return () => {
      if (this.sessions.get(taskId) === session) this.sessions.delete(taskId)
    }
  }

  emitStep(taskId: string, note: string): void {
    const current = this.runs.get(taskId)
    const steps = [...(current?.steps ?? []), note]
    if (current) this.runs.set(taskId, { ...current, steps })
    this.persistence.appendStep(taskId, current?.state.goal ?? 'Computer Use', note)
    broadcast('vision:step', { taskId, note })
  }

  emitState(state: VisionTaskState): void {
    const owner = this.sessions.get(state.taskId)?.guard.snapshot()
    const ownerProjection = owner ? automationTaskReadStatus(owner.status) : undefined
    // Native hosts may finish an in-flight read or model reply after control
    // changed. Shared owns the state, so stale projections cannot reopen or
    // complete the task with a different status.
    if (ownerProjection && ownerProjection !== state.status) return
    const current = this.runs.get(state.taskId)
    const previous = current?.state
    const steps = current?.steps ?? []
    const device = this.persistence.executionDevice()
    const next: VisionTaskState = {
      ...state,
      journeyId: state.journeyId ?? previous?.journeyId ?? state.taskId,
      modelId: state.modelId ?? previous?.modelId,
      modelName: state.modelName ?? previous?.modelName,
      executionDeviceId: state.executionDeviceId ?? previous?.executionDeviceId ?? device.id,
      executionDeviceName:
        state.executionDeviceName ?? previous?.executionDeviceName ?? device.name,
      ...(state.notice === undefined && previous?.notice ? { notice: previous.notice } : {})
    }
    this.runs.set(state.taskId, { state: next, steps })
    this.currentTaskId = state.taskId
    this.persistence.record({
      taskId: next.taskId,
      journeyId: next.journeyId,
      modelId: next.modelId,
      modelName: next.modelName,
      kind: 'computer_use',
      title: next.goal,
      status: next.status,
      summary: next.summary,
      steps: [...steps],
      executionDeviceId: next.executionDeviceId,
      executionDeviceName: next.executionDeviceName,
      phase: next.phase,
      currentStep: next.currentStep,
      currentAction: next.currentAction
    })
    broadcast('vision:task-state', next)
  }

  current(): { state: VisionTaskState | null; steps: string[] } {
    const current = this.currentTaskId ? this.runs.get(this.currentTaskId) : undefined
    return {
      state: current?.state ?? null,
      steps: [...(current?.steps ?? [])]
    }
  }

  control(input: unknown, taskIdInput?: unknown): boolean {
    const command = parseVisionCommand(input)
    const taskId = typeof taskIdInput === 'string' ? taskIdInput : this.currentTaskId
    const session = taskId ? this.sessions.get(taskId) : undefined
    if (!command || !taskId || !session) return false
    const { guard } = session
    if (command === 'stop') {
      return this.stop(taskId, 'stopped from the supervisor', 'Stopped from the supervisor')
    }
    if (command === 'pause' || command === 'takeover') {
      const accepted =
        command === 'takeover'
          ? guard.takeOver('you took over from the supervisor')
          : guard.pause('paused from the supervisor')
      if (!accepted) return false
      this.projectSession(
        taskId,
        command === 'takeover' ? 'You have control of this computer' : 'Paused by you'
      )
      return true
    }
    if (!guard.isPaused) return false
    if (!guard.resume()) return false
    this.projectSession(taskId, 'Reading the current screen')
    return true
  }

  /** Park the active run at a human-only step. The guard is the state owner;
   * the durable task record and every renderer are projections of it. */
  async waitForUser(taskId: string, reason: string, signal?: AbortSignal): Promise<void> {
    const session = this.sessions.get(taskId)
    if (!session) return
    if (!session.guard.requestUser(reason)) return
    this.projectSession(taskId, reason)
    await session.guard.waitUntilRunnable(signal ?? session.request.signal)
  }

  stop(taskId: string, reason: string, currentAction: string): boolean {
    const session = this.sessions.get(taskId)
    if (!session) return false
    if (!session.guard.halt(reason)) return false
    session.request.abort(reason)
    this.projectSession(taskId, currentAction)
    return true
  }

  private projectSession(taskId: string, currentAction: string): void {
    const session = this.sessions.get(taskId)
    if (!session) return
    const snapshot = session.guard.snapshot()
    const status = automationTaskReadStatus(snapshot.status)
    if (session.project) {
      session.project(snapshot, status, currentAction)
      return
    }
    this.transition(
      taskId,
      status,
      status === 'waiting'
        ? 'waiting'
        : status === 'paused'
          ? 'paused'
          : status === 'stopped'
            ? 'stopped'
            : 'observing',
      currentAction
    )
  }

  private transition(
    taskId: string,
    status: VisionTaskState['status'],
    phase: ComputerUsePhase,
    currentAction: string
  ): void {
    const current = this.runs.get(taskId)?.state
    if (!current) return
    this.emitState({ ...current, status, phase, currentAction })
  }
}

const controller = new VisionController(taskHistoryPersistence)

export function registerVisionSession(
  taskId: string,
  guard: VisionGuard,
  request: AbortController,
  project?: (
    snapshot: AutomationTaskSnapshot,
    status: AutomationTaskReadStatus,
    currentAction: string
  ) => void
): () => void {
  return controller.registerSession(taskId, guard, request, project)
}

export function emitVisionStep(taskId: string, note: string): void {
  controller.emitStep(taskId, note)
}

export function emitVisionNotice(notice: string): void {
  broadcast('vision:notice', { notice })
}

export function emitVisionState(state: VisionTaskState): void {
  controller.emitState(state)
}

/** Native kill switches route through the same owner as the renderer Stop button. */
export function stopVisionTask(taskId: string, reason: string, currentAction: string): boolean {
  return controller.stop(taskId, reason, currentAction)
}

/** Agent-requested human handoff uses the same run owner as Pause, Take Over,
 * Continue, Stop, and Esc. */
export function waitForVisionUser(
  taskId: string,
  reason: string,
  signal?: AbortSignal
): Promise<void> {
  return controller.waitForUser(taskId, reason, signal)
}

/** Remote and renderer controls converge on the same active VisionController session. */
export function controlVisionTask(
  command: 'stop' | 'pause' | 'takeover' | 'resume',
  taskId: string
): boolean {
  return controller.control(command, taskId)
}

export function parseVisionCommand(
  input: unknown
): 'stop' | 'pause' | 'takeover' | 'resume' | null {
  return input === 'stop' || input === 'pause' || input === 'takeover' || input === 'resume'
    ? input
    : null
}

export function registerVisionIpc(owner: VisionController = controller): void {
  ipcMain.handle('vision:current', () => owner.current())
  ipcMain.handle('vision:control', (_event, command: unknown, taskId: unknown) =>
    owner.control(command, taskId)
  )
}
