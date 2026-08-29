/**
 * The native screen compositor is the only fake boundary. The real supervisor window policy,
 * display capture service, file persistence, and model-frame preparation stay connected.
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, describe, expect, it, vi } from 'vitest'

const nativeCapture = vi.hoisted(() => ({
  profile: `/tmp/offgrid-computer-use-exclusion-${process.pid}`,
  protectedWindowSources: new Set<string>(),
  cleanFrame: Buffer.alloc(0),
  obstructedFrame: Buffer.alloc(0)
}))
fs.mkdirSync(nativeCapture.profile, { recursive: true })

vi.mock('electron', () => ({
  app: {
    getPath: () => nativeCapture.profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  screen: {
    getPrimaryDisplay: () => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    }),
    getCursorScreenPoint: () => ({ x: 500, y: 300 }),
    getDisplayNearestPoint: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 }
    })
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class BrowserWindow {
    private readonly sourceId = 'window:73:0'

    setContentProtection(protectedFromCapture: boolean): void {
      if (protectedFromCapture) nativeCapture.protectedWindowSources.add(this.sourceId)
      else nativeCapture.protectedWindowSources.delete(this.sourceId)
    }

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
  },
  desktopCapturer: {
    getSources: vi.fn(async () => {
      const pixels = nativeCapture.protectedWindowSources.has('window:73:0')
        ? nativeCapture.cleanFrame
        : nativeCapture.obstructedFrame
      return [
        {
          display_id: '1',
          thumbnail: {
            isEmpty: () => false,
            getSize: () => ({ width: 320, height: 200 }),
            toPNG: () => pixels
          }
        }
      ]
    })
  }
}))

import { vision } from '../vision'
import { modelScreenshot } from '../vision/vision-policy-runner'
import { showSupervisorWindow } from '../vision/supervisor-window'

afterAll(() => {
  fs.rmSync(nativeCapture.profile, { recursive: true, force: true })
})

describe('Computer Use capture exclusion journey', () => {
  it('excludes the visible PiP before capture and stores the exact clean model frame', async () => {
    nativeCapture.cleanFrame = await sharp({
      create: { width: 320, height: 200, channels: 3, background: '#34d399' }
    })
      .png()
      .toBuffer()
    nativeCapture.obstructedFrame = await sharp({
      create: { width: 320, height: 200, channels: 3, background: '#0a0a0a' }
    })
      .png()
      .toBuffer()
    expect(nativeCapture.cleanFrame).not.toEqual(nativeCapture.obstructedFrame)

    showSupervisorWindow()
    const savedPath = path.join(nativeCapture.profile, 'task-run-snapshots', 'clean-frame.png')
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    const captured = await vision.captureDisplayFrame(undefined, savedPath)

    expect(nativeCapture.protectedWindowSources).toEqual(new Set(['window:73:0']))
    expect(captured?.path).toBe(savedPath)
    expect(fs.readFileSync(savedPath)).toEqual(nativeCapture.cleanFrame)

    const modelFrame = await modelScreenshot({
      image: savedPath,
      goal: 'Use the visible control without covering it.',
      history: [],
      policyHistory: [],
      retrievedFacts: [],
      guidance: [],
      coordinateFrame: {
        encoded: { width: 320, height: 200 },
        source: { width: 1440, height: 900 }
      }
    })
    const modelBytes = Buffer.from(modelFrame.dataUrl.split(',')[1]!, 'base64')
    expect(fs.readFileSync(savedPath)).toEqual(modelBytes)
  })
})
