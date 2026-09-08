/**
 * The real Desktop composition root must exist before the early shell binds adapters to it.
 * The temporary Electron profile is the only boundary replacement; application construction,
 * facade proxies, and all three startup adapters are production code.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-startup-adapters-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalSkipCompatibleGenerationModel = process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
process.env.OFFGRID_DATA_DIR = profile
process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = '1'

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

const composition = await import('../composition/application')
const { desktopApplicationStatus } = await import('../composition/application-access')
const { setupRagIPC } = await import('../rag-ipc')
const { registerActionsIpc } = await import('../actions/actions-ipc')
const { registerTaskHistoryIpc } = await import('../tasks/task-history-ipc')
const { getDB } = await import('../database')

let releaseRag: (() => void) | null = null
let releaseActions: (() => void) | null = null

afterAll(async () => {
  releaseActions?.()
  releaseRag?.()
  await composition.stopDesktopApplication()
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalSkipCompatibleGenerationModel === undefined)
    delete process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL
  else process.env.OFFGRID_SKIP_COMPATIBLE_GENERATION_MODEL = originalSkipCompatibleGenerationModel
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Desktop adapters during early-shell startup', () => {
  it('binds every application-backed adapter before domain startup', () => {
    expect(desktopApplicationStatus()).toBe('created')

    expect(() => {
      releaseRag = setupRagIPC()
      releaseActions = registerActionsIpc()
      registerTaskHistoryIpc()
    }).not.toThrow()
  })
})
