// @vitest-environment jsdom

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// The DB Vitest config uses the classic JSX transform, which reads this binding at runtime.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ActionRecord, ExecuteResult } from '@offgrid/use'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-computer-use-vision-recovery-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

afterAll(async () => {
  cleanup()
  const { getDB } = await import('../src/main/database')
  if (getDB().open) getDB().close()
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

const action = (taskId: string, goal: string): ActionRecord =>
  ({
    id: taskId,
    sourceRef: 'journey-vision-recovery',
    intent: goal,
    args: { goal }
  }) as ActionRecord

describe('Computer Use vision recovery', () => {
  it.each([
    {
      visionResult: { ok: true, effectId: 'task-vision-recovery' } as ExecuteResult,
      status: 'done'
    },
    {
      visionResult: { ok: false, detail: 'The vision model is not installed.' } as ExecuteResult,
      status: 'failed'
    }
  ])('keeps one task visible when vision ends as $status', async ({ visionResult, status }) => {
    const taskId = `task-vision-recovery-${status}`
    const goal = 'Open the requested document in Notes'
    const taskHistory = await import('../src/main/tasks/task-history')
    const { makeComputerTaskExecutor } = await import('../src/main/accessibility/ax-rail')
    const { VisionGuard } = await import('../src/main/vision/vision-guard')
    const { TaskHistoryList } =
      await import('../pro/renderer/components/browser/tasks/TaskHistoryList')

    taskHistory.recordTaskRun({
      taskId,
      journeyId: 'journey-vision-recovery',
      kind: 'computer_use',
      title: goal,
      status: 'running',
      steps: ['Opened Notes', 'The action model returned an invalid reply 3 times in a row.']
    })

    const makeRecoveryExecutor = (tiers: Parameters<typeof makeComputerTaskExecutor>[0]) =>
      makeComputerTaskExecutor(tiers, { enabledRails: ['ax', 'vision'] })
    const execute = makeRecoveryExecutor({
      routingSnapshot: async () => ({
        app: 'Notes',
        snapshot: {
          windowTitle: 'Notes',
          elements: Array.from({ length: 4 }, (_, index) => ({
            index: index + 1,
            role: 'AXButton',
            name: `Control ${index + 1}`,
            value: '',
            cx: index * 20,
            cy: index * 20,
            actionable: true,
            enabled: true
          }))
        }
      }),
      runAx: async (_goal, id, journeyId, _app, runRequest) => {
        const guard = new VisionGuard({ taskId: id, kind: 'computer_use' })
        const request = new AbortController()
        const outcome = await runRequest.recoverWithVision!(
          {
            taskId: id,
            steps: taskHistory.getTaskRun(id)!.steps,
            guidance: ['Use the document that is already open.'],
            currentStep: 3,
            currentAction: 'The action model returned an invalid reply 3 times in a row.'
          },
          { guard, request, queuedGuidance: ['Use the document that is already open.'] }
        )
        const summary = outcome.ok
          ? 'The document is open in Notes.'
          : `Computer Use stopped after repeated invalid action replies. Vision recovery could not continue: ${outcome.detail}`
        taskHistory.recordTaskRun({
          taskId: id,
          journeyId,
          kind: 'computer_use',
          title: goal,
          status: outcome.ok ? 'done' : 'failed',
          summary,
          currentAction: summary
        })
        return { ok: outcome.ok, summary, steps: taskHistory.getTaskRun(id)!.steps }
      },
      visionExecute: async (_action, checkpoint, continuation) => {
        expect(checkpoint).toMatchObject({ taskId, currentStep: 3 })
        expect(checkpoint?.steps).toContain('Opened Notes')
        expect(continuation?.guard.taskId).toBe(taskId)
        expect(continuation?.request.signal.aborted).toBe(false)
        expect(continuation?.queuedGuidance).toContain('Use the document that is already open.')
        return visionResult
      }
    })

    const outcome = await execute(action(taskId, goal))
    const task = taskHistory.getTaskRun(taskId)!
    expect(outcome.ok).toBe(visionResult.ok)

    render(
      <TaskHistoryList
        tasks={[task]}
        active={task}
        expandedTaskId={null}
        onOpenDetails={() => undefined}
        onCloseDetails={() => undefined}
        onRetryStarted={() => undefined}
      />
    )
    expect(screen.getByTestId(`task-tab-${taskId}`).textContent).toContain(status)
    if (!visionResult.ok) {
      expect(task.summary).toContain('Vision recovery could not continue')
      expect(task.summary).toContain('The vision model is not installed.')
    }
    cleanup()
  })
})
