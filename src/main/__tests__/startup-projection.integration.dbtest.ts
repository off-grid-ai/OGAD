/**
 * Startup state through a real Shared application lifecycle. The Desktop projection observes the
 * production application snapshot and subscription; only Electron's profile process boundary is
 * replaced because Vitest does not run inside Electron main.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-startup-projection-'))
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
const { createStartupProjection } = await import('../startup-projection')

let application: OffGridApplication
let releaseApplicationRegistration: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services')
  ])
  application = createOffGridApplication({ models: desktopModelWorkspacePorts })
  releaseApplicationRegistration = registerDesktopApplication(application)
})

afterAll(async () => {
  if (application.snapshot().status !== 'stopped') await application.stop()
  releaseApplicationRegistration()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop startup projection over the real Shared lifecycle', () => {
  it('moves from pending to settled and projects retained application degradation', async () => {
    const projection = createStartupProjection()
    const observed: string[] = []
    const releaseListener = projection.subscribe((snapshot) => observed.push(snapshot.phase))
    const releaseApplication = projection.observe(application)

    projection.stageStarted({ name: 'application', required: true })
    expect(projection.snapshot()).toMatchObject({
      phase: 'pending',
      applicationStatus: 'created',
      running: ['application']
    })

    await application.start()
    projection.stageSettled({ name: 'application', required: true, status: 'completed' })
    expect(projection.snapshot()).toMatchObject({
      phase: 'degraded',
      applicationStatus: 'running',
      running: []
    })

    application.reportDegraded({
      domain: 'models',
      source: 'startup.models',
      reason: 'The local model is not ready.'
    })
    expect(projection.snapshot()).toMatchObject({
      phase: 'degraded',
      degraded: expect.arrayContaining([
        expect.objectContaining({ domain: 'models', source: 'startup.models' })
      ])
    })

    application.reportDegraded({ domain: 'models', source: 'startup.models', reason: null })
    expect(projection.snapshot().phase).toBe('degraded')
    expect(projection.snapshot().degraded).not.toContainEqual(
      expect.objectContaining({ source: 'startup.models' })
    )
    expect(observed).toContain('pending')
    expect(observed).toContain('degraded')

    releaseApplication()
    releaseListener()
  })

  it('keeps pending work above optional degradation and required failure above all other state', () => {
    const projection = createStartupProjection()
    const releaseApplication = projection.observe(application)

    projection.stageSettled({ name: 'optional-sync', required: false, status: 'timeout' })
    expect(projection.snapshot().phase).toBe('degraded')

    projection.stageStarted({ name: 'required-shell', required: true })
    expect(projection.snapshot().phase).toBe('pending')

    projection.stageSettled({ name: 'required-shell', required: true, status: 'failed' })
    expect(projection.snapshot().phase).toBe('failed')

    releaseApplication()
  })
})
