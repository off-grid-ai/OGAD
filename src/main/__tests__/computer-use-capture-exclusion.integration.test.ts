/**
 * The native screen compositor is the only fake boundary. The real supervisor window policy,
 * display capture service, file persistence, and model-frame preparation stay connected.
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const nativeCapture = vi.hoisted(() => ({
  profile: `/tmp/offgrid-computer-use-exclusion-${process.pid}`,
  protectedWindowSources: new Set<string>(),
  electronCaptureCalls: 0
}))
fs.mkdirSync(nativeCapture.profile, { recursive: true })
const originalCaptureArguments = process.env.OFFGRID_CAPTURE_ARGUMENTS
const originalCaptureSource = process.env.OFFGRID_CAPTURE_CLEAN_SOURCE
let platformSpy: ReturnType<typeof vi.spyOn>

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

    getMediaSourceId(): string {
      return this.sourceId
    }

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
      nativeCapture.electronCaptureCalls += 1
      return []
    })
  }
}))

import { configureRuntime } from '../runtime-env'
import { vision } from '../vision'
import { modelScreenshot } from '../vision/vision-policy-runner'
import { showSupervisorWindow } from '../vision/supervisor-window'

beforeAll(() => {
  // The production boundary is macOS-only. Make the CI host exercise that branch too.
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterAll(() => {
  platformSpy.mockRestore()
  configureRuntime({ binRoots: undefined })
  if (originalCaptureArguments === undefined) delete process.env.OFFGRID_CAPTURE_ARGUMENTS
  else process.env.OFFGRID_CAPTURE_ARGUMENTS = originalCaptureArguments
  if (originalCaptureSource === undefined) delete process.env.OFFGRID_CAPTURE_CLEAN_SOURCE
  else process.env.OFFGRID_CAPTURE_CLEAN_SOURCE = originalCaptureSource
  fs.rmSync(nativeCapture.profile, { recursive: true, force: true })
})

describe('Computer Use capture exclusion journey', () => {
  it('excludes the visible PiP before capture and stores the exact clean model frame', async () => {
    const cleanFrame = await sharp({
      create: { width: 320, height: 200, channels: 3, background: '#34d399' }
    })
      .png()
      .toBuffer()
    const obstructedFrame = await sharp({
      create: { width: 320, height: 200, channels: 3, background: '#0a0a0a' }
    })
      .png()
      .toBuffer()
    expect(cleanFrame).not.toEqual(obstructedFrame)
    const binDir = path.join(nativeCapture.profile, 'bin')
    const cleanSource = path.join(nativeCapture.profile, 'clean-source.png')
    const captureArguments = path.join(nativeCapture.profile, 'capture-arguments.json')
    const helper = path.join(binDir, 'computer-use-capture')
    fs.mkdirSync(binDir, { recursive: true })
    fs.writeFileSync(cleanSource, cleanFrame)
    fs.writeFileSync(
      helper,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs')",
        'fs.writeFileSync(process.env.OFFGRID_CAPTURE_ARGUMENTS, JSON.stringify(process.argv.slice(2)))',
        'fs.copyFileSync(process.env.OFFGRID_CAPTURE_CLEAN_SOURCE, process.argv[2])'
      ].join('\n'),
      { mode: 0o755 }
    )
    process.env.OFFGRID_CAPTURE_ARGUMENTS = captureArguments
    process.env.OFFGRID_CAPTURE_CLEAN_SOURCE = cleanSource
    configureRuntime({ binRoots: [binDir] })

    showSupervisorWindow()
    const savedPath = path.join(nativeCapture.profile, 'task-run-snapshots', 'clean-frame.png')
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    const captured = await vision.captureDisplayFrame(undefined, savedPath, {
      excludeComputerUseSupervisor: true
    })

    expect(nativeCapture.protectedWindowSources).toEqual(new Set(['window:73:0']))
    expect(nativeCapture.electronCaptureCalls).toBe(0)
    expect(JSON.parse(fs.readFileSync(captureArguments, 'utf8'))).toEqual([
      expect.stringMatching(/offgrid-computer-use-.*\.png$/),
      '1',
      '73',
      '1728',
      '1080'
    ])
    expect(captured?.path).toBe(savedPath)
    expect(fs.readFileSync(savedPath)).toEqual(cleanFrame)

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
