/**
 * Startup status through the production renderer IPC boundary and a real Shared application
 * lifecycle. Electron IPC and window objects are the only external process fakes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (_event: unknown, ...args: unknown[]) => unknown

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-startup-ipc-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

const handlers = new Map<string, IpcHandler>()
const delivered: Array<{ channel: string; snapshot: unknown }> = []
const windows = [
  {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, snapshot: unknown) => delivered.push({ channel, snapshot })
    }
  },
  {
    isDestroyed: () => true,
    webContents: {
      send: () => {
        throw new Error('A destroyed window must not receive startup state.')
      }
    }
  }
]

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
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    on: () => undefined,
    removeListener: () => undefined,
    removeHandler: () => undefined
  }
}))

const { getDB } = await import('../database')
const { registerDesktopApplication } = await import('../composition/application-access')
const { startupProjection } = await import('../startup-projection')
const { registerStartupStatusIpc, STARTUP_STATUS_CHANGED_CHANNEL, STARTUP_STATUS_CHANNEL } =
  await import('../startup-ipc')

let application: OffGridApplication
let releaseApplication: () => void
let releaseObservation: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services')
  ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  releaseApplication = registerDesktopApplication(application)
  releaseObservation = startupProjection.observe(application)
  await application.start()
})

afterAll(async () => {
  releaseObservation()
  await application.stop()
  releaseApplication()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop startup status IPC over real application state', () => {
  it('serves the current snapshot and pushes changes only to live windows', () => {
    const releaseIpc = registerStartupStatusIpc()
    const read = handlers.get(STARTUP_STATUS_CHANNEL)
    if (!read) throw new Error('Startup status IPC was not registered.')

    expect(read({})).toMatchObject({ applicationStatus: 'running', phase: 'degraded' })

    startupProjection.stageStarted({ name: 'renderer.bootstrap', required: true })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      channel: STARTUP_STATUS_CHANGED_CHANNEL,
      snapshot: {
        applicationStatus: 'running',
        phase: 'pending',
        running: ['renderer.bootstrap']
      }
    })

    releaseIpc()
    startupProjection.stageSettled({
      name: 'renderer.bootstrap',
      required: true,
      status: 'completed',
      durationMs: 1
    })
    expect(delivered).toHaveLength(1)
  })
})
