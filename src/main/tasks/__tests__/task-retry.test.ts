import { describe, expect, it, vi } from 'vitest'
import {
  TaskRetryService,
  taskRetryAvailability,
  type TaskRetryCheckpoint,
  type TaskRetryRunner
} from '@offgrid/automation'
import type { TaskRunSnapshot, TaskRunUpdate } from '../task-history-store'
import { registerTaskRetryIpc } from '../task-retry-ipc'
import {
  encodeTaskExecutionPlan,
  fallbackTaskExecutionPlan
} from '../../../shared/task-execution-plan'

const savedPlan = fallbackTaskExecutionPlan('example.com', 'web')

function failed(extra: Partial<TaskRunSnapshot> = {}): TaskRunSnapshot {
  return {
    taskId: 'failed-1',
    journeyId: 'chat-1',
    kind: 'web_use',
    title: 'Find the report',
    status: 'failed',
    summary: 'The report link did not open.',
    steps: [encodeTaskExecutionPlan(savedPlan), 'opened the site', 'click failed on report link'],
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    executionDeviceId: 'mac-1',
    executionDeviceName: 'Office Mac',
    currentStep: 2,
    currentAction: 'click report link',
    lastUrl: 'https://example.com/reports',
    stepDetails: [
      {
        stepId: 'step-2',
        at: 2,
        phase: 'failed',
        decisionSummary: 'The report link did not open.'
      }
    ],
    ...extra
  }
}

function harness(
  seed: TaskRunSnapshot[],
  runner: TaskRetryRunner,
  guidance: readonly string[] = []
): {
  service: TaskRetryService
  rows: TaskRunSnapshot[]
} {
  const rows = [...seed]
  return {
    rows,
    service: new TaskRetryService(
      {
        get: (taskId) => rows.find((task) => task.taskId === taskId),
        list: () => [...rows],
        record: (update: TaskRunUpdate) => {
          const previous = rows.find((task) => task.taskId === update.taskId)
          const snapshot: TaskRunSnapshot = {
            taskId: update.taskId,
            journeyId: update.journeyId ?? update.taskId,
            kind: update.kind,
            title: update.title ?? 'Task',
            status: update.status ?? 'running',
            summary: update.summary,
            steps: update.steps ?? [],
            startedAt: previous?.startedAt ?? update.at ?? 3,
            updatedAt: update.at ?? 3,
            executionDeviceId: update.executionDeviceId,
            executionDeviceName: update.executionDeviceName,
            currentStep: update.currentStep,
            currentAction: update.currentAction
          }
          const index = rows.findIndex((task) => task.taskId === snapshot.taskId)
          const merged = index >= 0 ? { ...rows[index], ...snapshot } : snapshot
          if (['running', 'paused', 'waiting', 'reconnecting'].includes(merged.status)) {
            delete merged.finishedAt
          }
          if (index >= 0) rows[index] = merged
          else rows.push(merged)
          return merged
        }
      },
      runner,
      {
        device: () => ({ id: 'mac-1', name: 'Office Mac' }),
        guidanceForTask: () => guidance
      }
    )
  }
}

describe('task retry policy', () => {
  it('resumes the same task and preserves its complete audit checkpoint and plan', () => {
    const web = vi.fn(
      async (_task: TaskRunSnapshot, _newTaskId: string, _checkpoint: TaskRetryCheckpoint) => ({
        ok: true,
        summary: 'The report is ready.'
      })
    )
    const { service, rows } = harness([failed()], {
      web,
      computer: vi.fn(async () => ({ ok: true, summary: 'Done.' }))
    })

    expect(service.retry('failed-1')).toMatchObject({
      available: true,
      taskId: 'failed-1',
      journeyId: 'chat-1'
    })
    expect(rows.map((task) => task.taskId)).toEqual(['failed-1'])
    expect(rows[0]).toMatchObject({
      journeyId: 'chat-1',
      status: 'running',
      currentAction: 'Taking a fresh observation',
      stepDetails: [
        expect.objectContaining({
          stepId: 'step-2',
          decisionSummary: 'The report link did not open.'
        })
      ]
    })
    expect(rows[0]?.startedAt).toBe(1)
    expect(rows[0]?.finishedAt).toBeUndefined()
    expect(rows[0]?.steps).toEqual([
      ...failed().steps,
      'RETRY · Resumed from the failed checkpoint.'
    ])
    expect(web.mock.calls[0]?.[1]).toBe('failed-1')
    const checkpoint = web.mock.calls[0]?.[2] as TaskRetryCheckpoint
    expect(checkpoint).toMatchObject({
      taskId: 'failed-1',
      currentStep: 2,
      currentAction: 'click report link',
      plan: savedPlan,
      stepDetails: [expect.objectContaining({ stepId: 'step-2' })]
    })
    expect(checkpoint.steps).toEqual(failed().steps)
  })

  it('restores accepted task guidance into a retry checkpoint', () => {
    const web = vi.fn(
      async (_task: TaskRunSnapshot, _newTaskId: string, _checkpoint: TaskRetryCheckpoint) => ({
        ok: true,
        summary: 'Done.'
      })
    )
    const { service } = harness(
      [failed()],
      { web, computer: vi.fn(async () => ({ ok: true, summary: 'Done.' })) },
      ['From San Francisco to Pune on September 1st']
    )

    service.retry('failed-1')

    expect(web.mock.calls[0]?.[2]).toMatchObject({
      guidance: ['From San Francisco to Pune on September 1st']
    })
  })

  it('blocks another live attempt in the same journey', () => {
    const prior = failed()
    const live = failed({ taskId: 'retry-live', status: 'running', finishedAt: undefined })
    expect(
      taskRetryAvailability(prior, [prior, live], { id: 'mac-1', name: 'Office Mac' })
    ).toEqual({ available: false, reason: 'Another attempt is already running.' })
  })

  it('keeps device-local retries on their execution device', () => {
    expect(taskRetryAvailability(failed(), [failed()], { id: 'mac-2', name: 'Laptop' })).toEqual({
      available: false,
      reason: 'Retry this task on Office Mac.',
      executionDeviceId: 'mac-1',
      executionDeviceName: 'Office Mac'
    })
  })

  it('closes an attempt when the execution surface rejects it before a trace starts', async () => {
    const { service, rows } = harness([failed({ kind: 'computer_use' })], {
      web: vi.fn(async () => ({ ok: true, summary: 'Done.' })),
      computer: vi.fn(async () => ({
        ok: false,
        summary: 'Load a computer-use model before you start this task.'
      }))
    })

    expect(service.retry('failed-1')).toMatchObject({ available: true, taskId: 'failed-1' })
    await vi.waitFor(() => expect(rows[0]?.status).toBe('failed'))
    expect(rows[0]?.summary).toBe('Load a computer-use model before you start this task.')
  })

  it('runs the real retry service through the registered IPC channel', async () => {
    let finish: ((result: { ok: boolean; summary: string }) => void) | undefined
    const web = vi.fn(
      () =>
        new Promise<{ ok: boolean; summary: string }>((resolve) => {
          finish = resolve
        })
    )
    const { service, rows } = harness([failed()], {
      web,
      computer: vi.fn(async () => ({ ok: true, summary: 'Done.' }))
    })
    const handlers = new Map<string, (_event: unknown, taskId: unknown) => unknown>()
    registerTaskRetryIpc(
      { handle: (channel, handler) => handlers.set(channel, handler) },
      {
        availability: (taskId) => service.availability(taskId),
        retry: (taskId) => service.retry(taskId)
      }
    )

    const result = handlers.get('tasks:retry')?.({}, 'failed-1')
    expect(result).toMatchObject({ available: true, taskId: 'failed-1', journeyId: 'chat-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ taskId: 'failed-1', status: 'running' })
    expect(web).toHaveBeenCalledOnce()
    finish?.({ ok: true, summary: 'The report is ready.' })
    await vi.waitFor(() => expect(rows[0]?.status).toBe('done'))
  })
})
