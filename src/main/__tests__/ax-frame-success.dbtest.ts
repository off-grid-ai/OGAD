import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), step: vi.fn(), state: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))
vi.mock('../vision', () => ({ vision: { captureDisplayFrame: mocks.capture } }))
vi.mock('../vision/vision-controller', () => ({
  emitVisionStep: mocks.step,
  emitVisionState: mocks.state
}))
vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    extract: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(async () => Buffer.from('cropped'))
  }))
}))

import { captureAxObservationFrame } from '../accessibility/ax-frame'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ax-frame-'))
const imagePath = path.join(root, 'frame.png')

beforeEach(() => {
  vi.clearAllMocks()
  fs.writeFileSync(imagePath, 'source')
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('AX frame capture success', () => {
  it('crops the display capture to the bound target window', async () => {
    mocks.capture.mockResolvedValue({
      path: imagePath,
      width: 1000,
      height: 800,
      displayBounds: { x: 0, y: 0, width: 1000, height: 800 }
    })

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
    expect(fs.readFileSync(imagePath, 'utf8')).toBe('cropped')
  })

  it('derives bounds from elements and reports a recovered retry', async () => {
    mocks.capture.mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({
      path: imagePath,
      width: 200,
      height: 100,
      displayBounds: { x: 0, y: 0, width: 200, height: 100 }
    })

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
    expect(mocks.step).toHaveBeenCalledWith('task-retry', expect.stringContaining('recovered'))
    expect(mocks.state).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', phase: 'checking' })
    )
  })
})
