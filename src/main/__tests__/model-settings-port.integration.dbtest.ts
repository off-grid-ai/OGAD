/**
 * Model settings from the real Shared facade through Desktop's production persistence port. The
 * Electron profile is the only external process fake; validation, commit planning, publication,
 * and the LLM settings owner remain real.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-model-settings-port-'))
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

let application: OffGridApplication
let releaseApplication: () => void

beforeAll(async () => {
  const [
    { createOffGridApplication },
    { desktopModelWorkspacePorts },
    { createDesktopModelSettingsPort }
  ] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services'),
    import('../models/model-settings-port')
  ])
  application = createOffGridApplication({
    models: { ...desktopModelWorkspacePorts, settings: createDesktopModelSettingsPort() }
  })
  releaseApplication = registerDesktopApplication(application)
  await application.start()
})

afterAll(async () => {
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

describe('Desktop model settings port through the Shared application', () => {
  it('commits one local settings intent and returns the durable projection', async () => {
    const outcome = await application.models.settings.save({
      operationId: 'settings-save-1',
      origin: 'local',
      patch: { temperature: 0.37, topP: 0.81 }
    })

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    expect(outcome).toMatchObject({
      ok: true,
      value: {
        operationId: 'settings-save-1',
        settings: { temperature: 0.37, topP: 0.81 },
        changed: expect.arrayContaining(['temperature', 'topP']),
        launch: null,
        syncFailure: null
      }
    })
    expect(application.models.settings.current()).toMatchObject({
      temperature: 0.37,
      topP: 0.81
    })

    const stored = JSON.parse(
      fs.readFileSync(path.join(profile, 'models', 'llm-settings.json'), 'utf8')
    ) as Record<string, unknown>
    expect(stored).toMatchObject({ temperature: 0.37, topP: 0.81 })
  })
})
