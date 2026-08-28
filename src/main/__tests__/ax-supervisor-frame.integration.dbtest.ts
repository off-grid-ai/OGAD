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

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))

import { persistAxObservation } from '../accessibility/ax-observation'
import { getDB } from '../database'
import {
  configureTaskExecutionDevice,
  getTaskRun,
  resetTaskHistoryForTests
} from '../tasks/task-history'

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
})
