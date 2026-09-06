/**
 * Backup cancellation through the production Desktop IPC composition and real Shared portable
 * backup engine. Electron's file dialogs and profile are the only external process fakes.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown) => unknown

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-backup-ipc-cancel-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = profile

const handlers = new Map<string, IpcHandler>()
const saveDialogs: unknown[] = []
const openDialogs: unknown[] = []

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
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {
    showSaveDialog: async (options: unknown) => {
      saveDialogs.push(options)
      return { canceled: true }
    },
    showOpenDialog: async (options: unknown) => {
      openDialogs.push(options)
      return { canceled: true, filePaths: [] }
    }
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler)
  }
}))

const { getDB } = await import('../database')
const { setupDesktopBackupIPC } = await import('../backup/ipc')
const { BACKUP_EXPORT_ALL_CHANNEL, BACKUP_IMPORT_CHANNEL } =
  await import('../../shared/backup-contracts')

beforeAll(() => {
  setupDesktopBackupIPC()
})

afterAll(() => {
  if (getDB().open) getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(profile, { recursive: true, force: true })
})

function invoke(channel: string): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`IPC handler ${channel} was not registered.`)
  return Promise.resolve(handler({}))
}

describe('Desktop backup IPC cancellation through the Shared engine', () => {
  it('returns cancellation without retaining a staged export or applying an import', async () => {
    await expect(invoke(BACKUP_EXPORT_ALL_CHANNEL)).resolves.toEqual({ canceled: true })
    await expect(invoke(BACKUP_IMPORT_CHANNEL)).resolves.toBeNull()

    expect(saveDialogs).toHaveLength(1)
    expect(saveDialogs[0]).toMatchObject({
      title: 'Export Off Grid AI backup',
      filters: [{ extensions: ['zip'] }]
    })
    expect(openDialogs).toHaveLength(1)
    expect(openDialogs[0]).toMatchObject({
      title: 'Import Off Grid AI backup',
      properties: ['openFile']
    })
  })
})
