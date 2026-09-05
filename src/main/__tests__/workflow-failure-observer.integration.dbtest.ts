/**
 * Standing workflow failure reporting through the real Shared application event stream. Desktop
 * persistence and diagnostics stay real. Electron is replaced only at its process/profile boundary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OffGridApplication } from '@offgrid/application'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-workflow-failure-'))
const logPath = path.join(profile, 'workflow-diagnostics.log')
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
const { createDesktopAutomationPorts, recordTaskRun } = await import('../tasks/task-history')
const { observeWorkflowFailures, WORKFLOW_DEGRADATION_SOURCE } =
  await import('../workflow-failure-observer')

let application: OffGridApplication
let releaseApplication: () => void
let releaseObserver: () => void

beforeAll(async () => {
  const [{ createOffGridApplication }, { desktopModelWorkspacePorts }] = await Promise.all([
    import('@offgrid/application'),
    import('../model-services')
  ])
  application = createOffGridApplication({
    models: desktopModelWorkspacePorts,
    automation: createDesktopAutomationPorts()
  })
  releaseApplication = registerDesktopApplication(application)
  releaseObserver = observeWorkflowFailures(application)
  await application.start()
})

afterAll(async () => {
  releaseObserver()
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

describe('Desktop workflow failure observer over real Shared events', () => {
  it('retains a failed standing bridge as degraded state', async () => {
    recordTaskRun({
      taskId: 'workflow-bridge-task',
      kind: 'web_use',
      title: 'Sync this task',
      status: 'running'
    })

    await vi.waitFor(() =>
      expect(application.snapshot().degraded).toContainEqual(
        expect.objectContaining({
          domain: 'sync',
          source: WORKFLOW_DEGRADATION_SOURCE,
          reason: expect.stringContaining('task_run_replication')
        })
      )
    )
  })

  it('logs a caller-visible workflow failure without adding false degraded state', async () => {
    const outcome = await application.workflows.deleteProject('missing-project')
    expect(outcome.ok).toBe(false)
    expect(application.snapshot().degraded).not.toContainEqual(
      expect.objectContaining({ domain: 'rag', source: WORKFLOW_DEGRADATION_SOURCE })
    )

    await flushDiagnosticLog()
    const diagnostics = fs.readFileSync(logPath, 'utf8')
    expect(diagnostics).toContain('[workflows] bridge.failed')
    expect(diagnostics).toContain('bridge="task_run_replication"')
    expect(diagnostics).toContain('[workflows] workflow.failed')
    expect(diagnostics).toContain('workflow="delete_project"')
  })
})
