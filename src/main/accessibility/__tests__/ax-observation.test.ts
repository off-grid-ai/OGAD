import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// Electron is the boundary: a temp profile, and no OS keychain, so the database opens unencrypted.
const electronProfile = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => electronProfile.dir, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { persistAxFrame, persistAxObservation } from '../ax-observation'
import { configureTaskExecutionDevice, getTaskRun } from '../../tasks/task-history'
import { configureRuntime } from '../../runtime-env'
import { getDB } from '../../database'

// The real task history, in a temp profile, on this device.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ax-observation-'))
electronProfile.dir = profile
configureRuntime({ dataDir: profile })
configureTaskExecutionDevice({ id: 'mac-1', name: 'My Mac' })
afterAll(() => {
  getDB().close()
  configureRuntime({ dataDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('persistAxObservation', () => {
  it('makes a captured frame durable before later task progress can prune it', () => {
    persistAxFrame({
      taskId: 'task-6',
      journeyId: 'chat-6',
      title: 'Send the message',
      frame: {
        capture: {
          path: '/captures/task-6.png',
          width: 1280,
          height: 720,
          displayBounds: { x: 0, y: 0, width: 2560, height: 1440 }
        },
        snapshot: { windowTitle: 'WhatsApp', elements: [] }
      }
    })

    expect(getTaskRun('task-6')).toMatchObject({
      taskId: 'task-6',
      journeyId: 'chat-6',
      kind: 'computer_use',
      title: 'Send the message',
      screenshotPath: '/captures/task-6.png',
      screenshotDeviceId: 'mac-1',
      executionDeviceId: 'mac-1',
      executionDeviceName: 'My Mac'
    })
  })

  it('writes bounded task evidence through the shared history adapter without a screenshot', () => {
    persistAxObservation('task-7', 'Send the message', {
      step: 2,
      prompt: 'exact AX prompt',
      retrievedFacts: ['Earlier task opened Slack'],
      rawResponse: '{"action":"press","index":4}',
      parsedAction: { action: 'press', index: 4 },
      durationMs: 31,
      result: 'actuated'
    })

    const task = getTaskRun('task-7')
    expect(task).toMatchObject({ kind: 'computer_use', title: 'Send the message' })
    expect(task?.stepDetails).toHaveLength(1)
    expect(task?.stepDetails?.[0]).toEqual(
      expect.objectContaining({
        stepId: '2',
        retrievedFacts: ['Earlier task opened Slack'],
        // Stored as the model's output, the same text the model returned.
        modelOutput: '{"action":"press","index":4}',
        mappedAction: '{"action":"press","index":4}',
        execution: {
          status: 'complete',
          durationMs: 31,
          result: 'actuated'
        }
      })
    )
    expect(task?.stepDetails?.[0]).not.toHaveProperty('screenshot')
  })

  it('marks execution errors as failed', () => {
    persistAxObservation('task-8', 'Open settings', {
      step: 1,
      prompt: 'prompt',
      retrievedFacts: [],
      rawResponse: '{"action":"click","index":1}',
      parsedAction: { action: 'click', index: 1 },
      durationMs: 12,
      result: 'error',
      error: 'input driver stopped'
    })

    expect(getTaskRun('task-8')?.stepDetails?.[0]?.execution).toEqual({
      status: 'failed',
      durationMs: 12,
      result: 'error',
      error: 'input driver stopped'
    })
  })
})
