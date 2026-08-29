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
const nativeCaptureAttempts = path.join(profile, 'native-capture-attempts.txt')
const originalCaptureAttempts = process.env.OFFGRID_AX_CAPTURE_ATTEMPTS

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  desktopCapturer: { getSources: captureSources },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
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
  BrowserWindow: class BrowserWindow {
    getMediaSourceId(): string {
      return 'window:73:0'
    }
    setContentProtection(): void {}
    isDestroyed(): boolean {
      return false
    }
    isVisible(): boolean {
      return false
    }
    showInactive(): void {}
    setVisibleOnAllWorkspaces(): void {}
    setAlwaysOnTop(): void {}
    on(): void {}
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    static getAllWindows(): unknown[] {
      return []
    }
  },
  ipcMain: { handle: vi.fn() }
}))

import { AxScreenCaptureError, captureAxObservationFrame } from '../accessibility/ax-frame'
import { persistAxObservation } from '../accessibility/ax-observation'
import { getDB } from '../database'
import { configureRuntime } from '../runtime-env'
import {
  configureTaskExecutionDevice,
  getTaskRun,
  resetTaskHistoryForTests
} from '../tasks/task-history'
import { emitVisionState } from '../vision/vision-controller'
import { showSupervisorWindow } from '../vision/supervisor-window'

afterAll(() => {
  resetTaskHistoryForTests()
  configureRuntime({ binRoots: undefined })
  if (originalCaptureAttempts === undefined) delete process.env.OFFGRID_AX_CAPTURE_ATTEMPTS
  else process.env.OFFGRID_AX_CAPTURE_ATTEMPTS = originalCaptureAttempts
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
    captureSources.mockResolvedValue([])
    const binDir = path.join(profile, 'bin')
    const helper = path.join(binDir, 'computer-use-capture')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(
      helper,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        'const file = process.env.OFFGRID_AX_CAPTURE_ATTEMPTS',
        "const count = Number(fs.readFileSync(file, { encoding: 'utf8', flag: 'a+' }) || '0') + 1",
        'fs.writeFileSync(file, String(count))',
        'process.exit(7)'
      ].join('\n'),
      { mode: 0o755 }
    )
    process.env.OFFGRID_AX_CAPTURE_ATTEMPTS = nativeCaptureAttempts
    configureRuntime({ binRoots: [binDir] })
    showSupervisorWindow()
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
    if (process.platform === 'darwin') {
      expect(Number(fs.readFileSync(nativeCaptureAttempts, 'utf8'))).toBe(3)
      expect(captureSources).not.toHaveBeenCalled()
    } else {
      expect(fs.existsSync(nativeCaptureAttempts)).toBe(false)
      expect(captureSources).toHaveBeenCalledTimes(3)
    }
  })
})
