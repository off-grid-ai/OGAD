import { getRagMessages, type RagMessage } from '../database'
import { getTaskExecutionDevice, getTaskRun, listTaskRuns, recordTaskRun } from './task-history'
import type { TaskRunSnapshot } from './task-history-store'
import type { ComputerUseStepDetail } from './task-step-details'
import { decodeTaskExecutionPlan, type TaskExecutionPlan } from '../../shared/task-execution-plan'

const LIVE_STATUSES = new Set(['running', 'paused', 'waiting', 'reconnecting'])

export interface TaskRetryAvailability {
  available: boolean
  reason?: string
  executionDeviceId?: string
  executionDeviceName?: string
}

export interface TaskRetryResult extends TaskRetryAvailability {
  taskId?: string
  journeyId?: string
}

export interface TaskRetryCheckpoint {
  taskId: string
  steps: readonly string[]
  stepDetails?: readonly ComputerUseStepDetail[]
  plan?: TaskExecutionPlan
  guidance?: readonly string[]
  summary?: string
  currentStep?: number
  currentAction?: string
}

export function retryPlanningGoal(goal: string, checkpoint?: TaskRetryCheckpoint): string {
  const guidance = checkpoint?.guidance?.map((item) => item.trim()).filter(Boolean) ?? []
  if (!guidance.length) return goal
  return `${goal}\n\nAuthoritative task requirements:\n${guidance.map((item) => `- ${item}`).join('\n')}`
}

export interface TaskRetryRunner {
  web(
    task: TaskRunSnapshot,
    taskId: string,
    checkpoint: TaskRetryCheckpoint
  ): Promise<TaskRetryRunResult>
  computer(
    task: TaskRunSnapshot,
    taskId: string,
    checkpoint: TaskRetryCheckpoint
  ): Promise<TaskRetryRunResult>
}

export interface TaskRetryRunResult {
  ok: boolean
  summary: string
}

interface TaskRetryServiceOptions {
  device: () => Readonly<{ id: string; name: string }>
  guidanceForTask?: (task: TaskRunSnapshot) => readonly string[]
}

export const TASK_RETRY_TRACE = 'RETRY · Resumed from the failed checkpoint.'

function taskPlan(steps: readonly string[]): TaskExecutionPlan | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const plan = decodeTaskExecutionPlan(steps[index] ?? '')
    if (plan) return plan
  }
  return undefined
}

function taskGuidanceId(context: string | null): string | undefined {
  if (!context) return undefined
  try {
    const parsed = JSON.parse(context) as { taskGuidance?: { taskId?: unknown } }
    return typeof parsed.taskGuidance?.taskId === 'string' ? parsed.taskGuidance.taskId : undefined
  } catch {
    return undefined
  }
}

export function retryGuidanceFromMessages(
  taskId: string,
  messages: readonly Pick<RagMessage, 'content' | 'context'>[]
): string[] {
  return messages
    .filter((message) => taskGuidanceId(message.context) === taskId)
    .map((message) => message.content.trim())
    .filter(Boolean)
}

function sameJourneyAttemptRunning(
  task: TaskRunSnapshot,
  all: readonly TaskRunSnapshot[]
): boolean {
  return all.some(
    (candidate) =>
      candidate.taskId !== task.taskId &&
      candidate.journeyId === task.journeyId &&
      LIVE_STATUSES.has(candidate.status)
  )
}

export function taskRetryAvailability(
  task: TaskRunSnapshot | undefined,
  all: readonly TaskRunSnapshot[],
  device: Readonly<{ id: string; name: string }>
): TaskRetryAvailability {
  if (!task) return { available: false, reason: 'This task is no longer in history.' }
  if (task.status !== 'failed') {
    return { available: false, reason: 'Only failed tasks can be retried.' }
  }
  if (sameJourneyAttemptRunning(task, all)) {
    return { available: false, reason: 'Another attempt is already running.' }
  }
  if (task.executionDeviceId && task.executionDeviceId !== device.id) {
    return {
      available: false,
      reason: `Retry this task on ${task.executionDeviceName || 'its original device'}.`,
      executionDeviceId: task.executionDeviceId,
      executionDeviceName: task.executionDeviceName
    }
  }
  return {
    available: true,
    executionDeviceId: device.id,
    executionDeviceName: device.name
  }
}

let configuredRunner: TaskRetryRunner | null = null

/** Bind runtime hosts at the process composition root, not inside retry policy. */
export function configureTaskRetryRunner(runner: TaskRetryRunner): void {
  configuredRunner = runner
}

const liveRunner: TaskRetryRunner = {
  web: (task, taskId, checkpoint) => {
    if (!configuredRunner) throw new Error('Task retry runner is not configured.')
    return configuredRunner.web(task, taskId, checkpoint)
  },
  computer: (task, taskId, checkpoint) => {
    if (!configuredRunner) throw new Error('Task retry runner is not configured.')
    return configuredRunner.computer(task, taskId, checkpoint)
  }
}

export class TaskRetryService {
  constructor(
    private readonly history: {
      get(taskId: string): TaskRunSnapshot | undefined
      list(): TaskRunSnapshot[]
      record(update: Parameters<typeof recordTaskRun>[0]): TaskRunSnapshot
    },
    private readonly runner: TaskRetryRunner,
    private readonly options: TaskRetryServiceOptions
  ) {}

  availability(taskId: string): TaskRetryAvailability {
    return taskRetryAvailability(
      this.history.get(taskId),
      this.history.list(),
      this.options.device()
    )
  }

  retry(taskId: string): TaskRetryResult {
    const task = this.history.get(taskId)
    const availability = taskRetryAvailability(task, this.history.list(), this.options.device())
    if (!availability.available || !task) return availability

    const guidance = this.options.guidanceForTask?.(task) ?? []
    const plan = taskPlan(task.steps)
    const checkpoint: TaskRetryCheckpoint = {
      taskId: task.taskId,
      steps: [...task.steps],
      ...(task.stepDetails?.length ? { stepDetails: [...task.stepDetails] } : {}),
      ...(plan ? { plan } : {}),
      ...(guidance.length ? { guidance } : {}),
      ...(task.summary ? { summary: task.summary } : {}),
      ...(task.currentStep !== undefined ? { currentStep: task.currentStep } : {}),
      ...(task.currentAction ? { currentAction: task.currentAction } : {})
    }
    const device = this.options.device()
    this.history.record({
      taskId: task.taskId,
      journeyId: task.journeyId,
      kind: task.kind,
      title: task.title,
      status: 'running',
      summary: 'Resuming from the failed checkpoint.',
      steps: [...task.steps, TASK_RETRY_TRACE],
      executionDeviceId: device.id,
      executionDeviceName: device.name,
      currentStep: task.currentStep,
      currentAction: 'Taking a fresh observation'
    })

    const run = task.kind === 'web_use' ? this.runner.web : this.runner.computer
    void run(task, task.taskId, checkpoint)
      .then((result) => {
        const latest = this.history.get(task.taskId)
        if (!latest || !LIVE_STATUSES.has(latest.status)) return
        this.history.record({
          taskId: task.taskId,
          journeyId: task.journeyId,
          kind: task.kind,
          title: task.title,
          status: result.ok ? 'done' : 'failed',
          summary: result.summary,
          currentAction: result.summary,
          executionDeviceId: device.id,
          executionDeviceName: device.name
        })
      })
      .catch(() => {
        this.history.record({
          taskId: task.taskId,
          journeyId: task.journeyId,
          kind: task.kind,
          title: task.title,
          status: 'failed',
          summary: 'The task could not resume. Open the task details and try again.',
          executionDeviceId: device.id,
          executionDeviceName: device.name
        })
      })
    return { ...availability, taskId: task.taskId, journeyId: task.journeyId }
  }
}

const retryService = new TaskRetryService(
  { get: getTaskRun, list: listTaskRuns, record: recordTaskRun },
  liveRunner,
  {
    device: getTaskExecutionDevice,
    guidanceForTask: (task) =>
      retryGuidanceFromMessages(task.taskId, getRagMessages(task.journeyId))
  }
)

export function getTaskRetryAvailability(taskId: string): TaskRetryAvailability {
  return retryService.availability(taskId)
}

export function retryTask(taskId: string): TaskRetryResult {
  return retryService.retry(taskId)
}
