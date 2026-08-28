/**
 * The real AX observation producer writes the exact frame and mapped pointer into the durable task
 * projection consumed by the Computer Use supervisor. Only Electron storage/window boundaries are
 * replaced; observation mapping, sanitization, SQLite persistence, and hydration remain real.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ax-supervisor-frame-'))
const captureSources = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  desktopCapturer: { getSources: captureSources },
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1280, height: 720 }
    })
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

import { AxScreenCaptureError, captureAxObservationFrame } from '../accessibility/ax-frame'
import { persistAxObservation } from '../accessibility/ax-observation'
import { getDB } from '../database'
import {
  configureTaskExecutionDevice,
  getTaskRun,
  resetTaskHistoryForTests
} from '../tasks/task-history'
import { emitVisionState } from '../vision/vision-controller'

afterAll(() => {
  resetTaskHistoryForTests()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('AX Computer Use live supervisor projection', () => {
  it('persists one observed display frame with the action target in screenshot coordinates', () => {
    configureTaskExecutionDevice({ id: 'desktop:test-mac', name: 'Test Mac' })
    const screenshotPath = path.join(profile, 'task-run-snapshots', 'ax-current.png')

    persistAxObservation('ax-live-task', 'Send the Slack message', {
      step: 3,
      prompt: 'AX element prompt',
      retrievedFacts: [],
      rawResponse: '{"action":"press","index":4}',
      parsedAction: { action: 'press', index: 4 },
      durationMs: 31,
      result: 'actuated',
      frame: {
        capture: {
          path: screenshotPath,
          width: 1280,
          height: 720,
          displayBounds: { x: 100, y: 50, width: 1280, height: 720 }
        },
        snapshot: {
          windowTitle: 'Slack',
          elements: [
            {
              index: 4,
              role: 'AXButton',
              name: 'Send',
              value: '',
              cx: 900,
              cy: 500,
              actionable: true,
              enabled: true
            }
          ]
        }
      }
    })

    const task = getTaskRun('ax-live-task')
    expect(task).toMatchObject({
      kind: 'computer_use',
      screenshotPath,
      screenshotDeviceId: 'desktop:test-mac'
    })
    expect(task?.stepDetails?.at(-1)).toMatchObject({
      screenshot: {
        path: screenshotPath,
        availability: 'device_local',
        executionDeviceId: 'desktop:test-mac',
        executionDeviceName: 'Test Mac',
        originalWidth: 1280,
        originalHeight: 720,
        inferenceWidth: 1280,
        inferenceHeight: 720
      },
      mappedAction: '{"action":"press","index":4,"point":{"x":800,"y":450}}',
      actionCoordinateSpace: 'inference'
    })
  })

  it('turns a bounded screen-capture failure into a visible terminal task state', async () => {
    captureSources.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue([])
    emitVisionState({
      taskId: 'ax-capture-failure',
      journeyId: 'chat-capture-failure',
      goal: 'Send the Slack message',
      status: 'running',
      phase: 'observing',
      currentStep: 1,
      currentAction: 'Reading Slack'
    })

    await expect(
      captureAxObservationFrame({
        taskId: 'ax-capture-failure',
        journeyId: 'chat-capture-failure',
        goal: 'Send the Slack message',
        currentStep: 1,
        captureNumber: 1,
        snapshot: { windowTitle: 'Slack', elements: [] }
      })
    ).rejects.toBeInstanceOf(AxScreenCaptureError)

    const task = getTaskRun('ax-capture-failure')
    expect(task).toMatchObject({
      journeyId: 'chat-capture-failure',
      kind: 'computer_use',
      status: 'failed',
      phase: 'failed',
      currentStep: 1,
      currentAction:
        'Off Grid AI could not capture the screen after 3 attempts. Check screen-recording permission, unlock the screen, then retry Computer Use.',
      summary:
        'Off Grid AI could not capture the screen after 3 attempts. Check screen-recording permission, unlock the screen, then retry Computer Use.'
    })
    expect(task?.steps).toEqual([
      'Screen preview is unavailable. Retrying capture (1/3).',
      'Screen preview is unavailable. Retrying capture (2/3).',
      'Screen preview failed: Off Grid AI could not capture the screen after 3 attempts. Check screen-recording permission, unlock the screen, then retry Computer Use.'
    ])
    expect(captureSources).toHaveBeenCalledTimes(3)
  })
})
