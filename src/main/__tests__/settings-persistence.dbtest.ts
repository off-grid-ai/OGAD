/**
 * Software-update preferences through the real IPC owner and encrypted SQLite.
 *
 * The test controls only Electron and electron-updater, which are process/OS/network
 * boundaries. Production update handlers write through the real database module,
 * the database is closed, every Off Grid AI module is reloaded, and the production
 * read handler must restore the same values from disk.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-settings-relaunch-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    getAppPath: () => process.cwd()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      state.handlers.set(channel, handler)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, '')
  }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: 'latest',
    allowPrerelease: false,
    allowDowngrade: false,
    isUpdateSupported: async () => true,
    checkForUpdatesAndNotify: vi.fn(async () => undefined),
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn()
  }
}))

beforeEach(() => {
  vi.useFakeTimers()
  state.handlers.clear()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('software-update settings survive a full process relaunch', () => {
  it('restores automatic-update and channel choices through fresh production modules', async () => {
    const updater = await import('../updater')
    const database = await import('../database')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()

    const setAuto = state.handlers.get('update:set-auto')
    const setChannel = state.handlers.get('update:set-channel')
    const skipVersion = state.handlers.get('update:skip-version')
    expect(setAuto).toBeTypeOf('function')
    expect(setChannel).toBeTypeOf('function')
    expect(skipVersion).toBeTypeOf('function')
    expect(await setAuto?.({}, false)).toBe(false)
    expect(await setChannel?.({}, 'beta')).toBe('beta')
    expect(await skipVersion?.({}, '0.0.39')).toBe('0.0.39')

    database.getDB().close()
    vi.resetModules()
    state.handlers.clear()

    const relaunchedUpdater = await import('../updater')
    const relaunchedDatabase = await import('../database')
    relaunchedUpdater.registerUpdateIpc()
    relaunchedUpdater.startAutoUpdates()

    const getPreferences = state.handlers.get('update:get-prefs')
    expect(getPreferences).toBeTypeOf('function')
    expect(await getPreferences?.({})).toEqual({
      currentVersion: '0.0.0-test',
      auto: false,
      channel: 'beta',
      skippedVersion: '0.0.39'
    })
    relaunchedDatabase.getDB().close()
  })
})
