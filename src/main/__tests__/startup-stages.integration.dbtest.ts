/**
 * Desktop startup stages over the real Shared application health owner. Stage work represents the
 * external initialization boundary supplied by production callers; application state, projection,
 * diagnostics, ownership, and result policy stay real.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StartupStageContext } from '../startup-stages'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-startup-stages-'))
const logPath = path.join(profile, 'startup-diagnostics.log')
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalDiagnosticLog = process.env.OFFGRID_DIAGNOSTIC_LOG
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_DIAGNOSTIC_LOG = logPath
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
const { flushDiagnosticLog } = await import('../diagnostics-log')
const { registerDesktopApplication } = await import('../composition/application-access')
const { runIndependentStartupStages, runStartupStage, STARTUP_DEGRADATION_SOURCE } =
  await import('../startup-stages')

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
  await application.stop()
  releaseApplication()
  await flushDiagnosticLog()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalDiagnosticLog === undefined) delete process.env.OFFGRID_DIAGNOSTIC_LOG
  else process.env.OFFGRID_DIAGNOSTIC_LOG = originalDiagnosticLog
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop startup stages through real application health', () => {
  it('commits only while a successful stage owns its outcome', async () => {
    const changes: string[] = []
    let stageContext: StartupStageContext | undefined
    const result = await runStartupStage({
      name: 'desktop.runtime.activate',
      deadlineMs: 1_000,
      required: true,
      async run(context) {
        stageContext = context
        expect(context.signal.aborted).toBe(false)
        expect(context.isOwner()).toBe(true)
        context.commit('activate runtime', () => changes.push('active'))
        return 'runtime-ready'
      }
    })

    expect(result).toMatchObject({ ok: true, value: 'runtime-ready' })
    expect(changes).toEqual(['active'])
    expect(stageContext?.isOwner()).toBe(false)
    expect(stageContext?.commit('late activation', () => changes.push('late'))).toBeUndefined()
    expect(changes).toEqual(['active'])
  })

  it('returns typed failures, reports domain degradation, and collects independent work', async () => {
    const [successful, failed] = await runIndependentStartupStages([
      {
        name: 'desktop.catalog.read',
        deadlineMs: 1_000,
        run: async () => 'catalog-ready'
      },
      {
        name: 'desktop.sync.activate',
        deadlineMs: 1_000,
        domain: 'sync',
        run: async () => {
          throw 'pairing state unavailable'
        }
      }
    ])

    expect(successful).toMatchObject({ ok: true, value: 'catalog-ready' })
    expect(failed).toMatchObject({
      ok: false,
      reason: 'failed',
      error: 'pairing state unavailable'
    })
    expect(application.snapshot().degraded).toContainEqual({
      domain: 'sync',
      source: STARTUP_DEGRADATION_SOURCE,
      reason: 'desktop.sync.activate: pairing state unavailable'
    })

    await flushDiagnosticLog()
    const diagnostics = fs.readFileSync(logPath, 'utf8')
    expect(diagnostics).toContain('[startup] stage.completed')
    expect(diagnostics).toContain('[startup] stage.failed')
    expect(diagnostics).toContain('[startup] stage.late-commit-refused')
  })
})
