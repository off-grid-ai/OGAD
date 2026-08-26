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
  status: 'running' | 'paused' | 'done' | 'failed' | 'stopped'
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
  private readonly sessions = new Map<string, { guard: VisionGuard; request: AbortController }>()
  private readonly runs = new Map<string, { state: VisionTaskState; steps: string[] }>()
  private currentTaskId: string | null = null

  constructor(private readonly persistence: VisionControllerPersistence) {}

  registerSession(taskId: string, guard: VisionGuard, request: AbortController): () => void {
    const previous = this.sessions.get(taskId)
    if (previous) {
      previous.guard.halt('replaced by a newer run for this task')
      previous.request.abort('replaced by a newer run for this task')
    }
    const session = { guard, request }
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
    const { guard, request } = session
    if (command === 'stop') {
      guard.halt('stopped from the supervisor')
      request.abort('stopped from the supervisor')
      this.transition(taskId, 'stopped', 'stopped', 'Stopped from the supervisor')
      return true
    }
    if (command === 'pause' || command === 'takeover') {
      guard.pauseForUser(
        command === 'takeover' ? 'you took over from the supervisor' : 'paused from the supervisor'
      )
      this.transition(
        taskId,
        'paused',
        'paused',
        command === 'takeover' ? 'You have control of this computer' : 'Paused by you'
      )
      return true
    }
    if (!guard.isPaused) return false
    guard.resume()
    this.transition(taskId, 'running', 'observing', 'Reading the current screen')
    return true
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
  request: AbortController
): () => void {
  return controller.registerSession(taskId, guard, request)
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
