/**
 * First-run setup status through the real Desktop model application and Shared readiness policy.
 * The temporary Electron profile is the only fake boundary; model inventory, remote-server
 * persistence, application status, and readiness projection stay production-real.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-setup-readiness-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

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
  ipcMain: {
    on: () => undefined,
    removeListener: () => undefined,
    handle: () => undefined,
    removeHandler: () => undefined
  }
}))

const { getDB } = await import('../database')
const { registerDesktopApplication } = await import('../composition/application-access')
const { readDesktopSetupReadiness } = await import('../setup-readiness')
const { setRemoteVisionServerSettings } = await import('../vision/remote-vision-server')

let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services')
  ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  releaseApplication = registerDesktopApplication(application)
  await application.start()
})

afterAll(async () => {
  if (application.snapshot().status !== 'stopped') await application.stop()
  releaseApplication()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop setup readiness through production composition', () => {
  it('moves from first-run setup to configured after the user saves a remote route', async () => {
    expect(readDesktopSetupReadiness(false, path.join(profile, 'models'))).toEqual({
      downloaded: false,
      modelsDir: path.join(profile, 'models'),
      configured: false,
      status: 'needs-setup'
    })

    await setRemoteVisionServerSettings({
      provider: 'custom',
      endpoint: 'http://127.0.0.1:11434',
      model: 'private-text-model'
    })

    expect(readDesktopSetupReadiness(false, path.join(profile, 'models'))).toMatchObject({
      configured: true,
      status: 'configured'
    })
  })

  it('refuses to report stale setup after the application stops', async () => {
    await application.stop()
    expect(() => readDesktopSetupReadiness(false, path.join(profile, 'models'))).toThrow(
      'The application is stopped. Restart it to check your saved setup.'
    )
  })
})
