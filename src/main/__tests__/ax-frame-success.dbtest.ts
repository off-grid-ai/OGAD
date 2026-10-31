// An AX observation's screen frame: captured, cropped to the target window, and a recovered retry
// reported on the task. The boundaries are the screen: macOS's capture helper executable
// (`computer-use-capture` under the app's bin folder, which writes a PNG of the display) and
// Electron's display geometry and windows. Capture, cropping (sharp), the vision controller's
// step and state broadcasts and the task's screenshot paths are real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ax-frame-'))
const previous = {
  data: process.env.OFFGRID_DATA_DIR,
  bin: process.env.OFFGRID_BIN_DIR,
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!
}
process.env.OFFGRID_DATA_DIR = path.join(root, 'profile')
process.env.OFFGRID_BIN_DIR = path.join(root, 'bin')

const ui = vi.hoisted(() => ({
  display: { id: 1, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
  sent: [] as Array<{ channel: string; payload: unknown }>
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.OFFGRID_DATA_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  safeStorage: { isEncryptionAvailable: () => false },
  screen: {
    getCursorScreenPoint: () => ({ x: 1, y: 1 }),
    getDisplayNearestPoint: () => ui.display
  },
  desktopCapturer: { getSources: async () => [] },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: (channel: string, payload: unknown) => ui.sent.push({ channel, payload })
        }
      }
    ]
  }
}))

import { captureAxObservationFrame } from '../accessibility/ax-frame'

// The capture helper: copies the display image to the output path it is given; when
// `fail-once` exists it fails that one capture, as a busy WindowServer does.
const HELPER = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const failOnce = path.join(__dirname, 'fail-once')
if (fs.existsSync(failOnce)) { fs.rmSync(failOnce); process.stderr.write('busy'); process.exit(1) }
fs.copyFileSync(path.join(__dirname, 'display.png'), process.argv[2])
`

/** The display's pixels at this size. */
async function showDisplay(width: number, height: number): Promise<void> {
  ui.display = { id: 1, bounds: { x: 0, y: 0, width, height } }
  await sharp({ create: { width, height, channels: 4, background: '#336699' } })
    .png()
    .toFile(path.join(root, 'bin', 'display.png'))
}

beforeAll(() => {
  // A Mac: Computer Use captures through the helper.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'computer-use-capture'), HELPER, { mode: 0o755 })
})

beforeEach(() => {
  ui.sent.length = 0
})

afterAll(() => {
  Object.defineProperty(process, 'platform', previous.platform)
  if (previous.data === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previous.data
  if (previous.bin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previous.bin
  fs.rmSync(root, { recursive: true, force: true })
})

describe('AX frame capture success', () => {
  it('crops the display capture to the bound target window', async () => {
    await showDisplay(1000, 800)

    const frame = await captureAxObservationFrame({
      taskId: 'task-frame',
      journeyId: 'journey-frame',
      goal: 'Open the item',
      currentStep: 1,
      captureNumber: 2,
      snapshot: {
        windowTitle: 'App',
        windowBounds: { x: 100, y: 80, width: 500, height: 400 },
        elements: []
      }
    })

    expect(frame.capture).toMatchObject({
      width: 500,
      height: 400,
      displayBounds: { x: 100, y: 80, width: 500, height: 400 }
    })
    // The saved frame holds only the window's pixels.
    expect(await sharp(frame.capture.path).metadata()).toMatchObject({ width: 500, height: 400 })
  })

  it('derives bounds from elements and reports a recovered retry', async () => {
    await showDisplay(200, 100)
    fs.writeFileSync(path.join(root, 'bin', 'fail-once'), '')

    const frame = await captureAxObservationFrame({
      taskId: 'task-retry',
      journeyId: 'journey-retry',
      goal: 'Retry capture',
      currentStep: 2,
      captureNumber: 1,
      snapshot: {
        windowTitle: 'App',
        elements: [
          {
            index: 1,
            role: 'AXButton',
            name: 'Save',
            value: '',
            x: 20,
            y: 10,
            width: 80,
            height: 40,
            cx: 60,
            cy: 30,
            actionable: true,
            enabled: true
          }
        ]
      }
    })

    expect(frame.capture.displayBounds).toEqual({ x: 20, y: 10, width: 80, height: 40 })
    expect(ui.sent).toContainEqual({
      channel: 'vision:step',
      payload: { taskId: 'task-retry', note: expect.stringContaining('recovered') }
    })
    expect(ui.sent).toContainEqual({
      channel: 'vision:task-state',
      payload: expect.objectContaining({ status: 'running', phase: 'checking' })
    })
  })
})
