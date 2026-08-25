// @vitest-environment jsdom
/**
 * Manual update checks through the production updater IPC owner.
 *
 * electron-updater is the remote/native boundary. The updater itself, its
 * listener lifecycle, explicit-download policy, and SQLite-backed preference
 * owner remain real.
 */
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React from 'react'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-manual-update-'))
const updaterEvents = new EventEmitter()
const checkForUpdates = vi.fn<() => Promise<unknown>>(async () => undefined)
const downloadUpdate = vi.fn(async () => undefined)
const quitAndInstall = vi.fn()
const defaultUpdateSupport = vi.fn(async () => true)
const setFeedURL = vi.fn()
const releaseHistory = [
  {
    tag_name: 'v0.0.102',
    draft: false,
    published_at: '2026-07-01T12:00:00Z',
    assets: [
      {
        name: 'latest-mac.yml',
        browser_download_url:
          'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.102/latest-mac.yml'
      }
    ]
  }
]

vi.mock('electron', () => ({
  app: {
    getPath: () => tempProfile,
    getVersion: () => '0.0.103',
    getAppPath: () => process.cwd(),
    isPackaged: true
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
    isUpdateSupported: defaultUpdateSupport,
    checkForUpdatesAndNotify: vi.fn(async () => undefined),
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    setFeedURL,
    on: updaterEvents.on.bind(updaterEvents),
    once: updaterEvents.once.bind(updaterEvents),
    removeListener: updaterEvents.removeListener.bind(updaterEvents)
  }
}))

function handler<T>(channel: string): (...args: unknown[]) => Promise<T> {
  const registered = state.handlers.get(channel)
  expect(registered).toBeTypeOf('function')
  return (...args: unknown[]) => Promise.resolve(registered?.({}, ...args) as T)
}

function installRendererTransport(): void {
  const api = new Proxy(
    {
      isPro: false,
      platform: 'darwin',
      updateGetPrefs: () => handler('update:get-prefs')(),
      updateDownloadProgress: () => handler('update:download-progress')(),
      checkForUpdates: () => handler('update:check')(),
      updateDownload: (version: string) => handler('update:download')(version),
      updateSkipVersion: (version: string) => handler('update:skip-version')(version),
      updateListVersions: () => handler('update:list-versions')(),
      updateDownloadVersion: (version: string) => handler('update:download-version')(version),
      getAppVersion: () => Promise.resolve('0.0.103')
    },
    {
      get: (target, property) => {
        if (property in target) return target[property as keyof typeof target]
        return async () => undefined
      }
    }
  )
  Object.defineProperty(window, 'api', { configurable: true, value: api })
  vi.stubGlobal('__OFFGRID_PRO__', false)
}

async function renderUpdateCard(): Promise<HTMLElement> {
  cleanup()
  const settingsModule = '../../renderer/src/components/Settings'
  const { Settings } = (await import(/* @vite-ignore */ settingsModule)) as {
    Settings: React.ComponentType
  }
  render(React.createElement(Settings))
  const heading = await screen.findByText('Software update')
  const card = heading.parentElement?.parentElement?.parentElement
  expect(card).toBeTruthy()
  await userEvent.click(heading)
  return card as HTMLElement
}

beforeEach(() => {
  state.handlers.clear()
  updaterEvents.removeAllListeners()
  checkForUpdates.mockClear()
  checkForUpdates.mockResolvedValue(undefined)
  downloadUpdate.mockClear()
  quitAndInstall.mockClear()
  defaultUpdateSupport.mockClear()
  setFeedURL.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
})

afterAll(async () => {
  const database = await import('../database')
  database.getDB().close()
  fs.rmSync(tempProfile, { recursive: true, force: true })
})

describe('manual update check', () => {
  it('renders truthful terminal states without changing stable channel or installing (#142)', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()
    installRendererTransport()
    // startAutoUpdates' background cadence is captured by fake timers. Discard it before using
    // userEvent so this test drives only the explicit rendered action.
    vi.useRealTimers()
    const card = await renderUpdateCard()
    const user = userEvent.setup()

    expect(await within(card).findByText('Current: v0.0.103')).toBeTruthy()
    const channelSwitch = within(card).getAllByRole('switch')[1]
    expect(channelSwitch?.getAttribute('aria-checked')).toBe('false')

    await user.click(within(card).getByRole('button', { name: 'Check for updates' }))
    expect(within(card).getByRole('button', { name: 'Checking...' }).hasAttribute('disabled')).toBe(
      true
    )
    updaterEvents.emit('update-not-available', { version: '0.0.103' })
    expect(await within(card).findByText("You're on the latest version (v0.0.103).")).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: 'Check for updates' }))
    updaterEvents.emit('update-available', { version: '0.0.104' })
    expect(
      await within(card).findByText(/Update 0\.0\.104 found\. Downloading in the background/)
    ).toBeTruthy()

    await user.click(within(card).getByRole('button', { name: 'Check for updates' }))
    updaterEvents.emit('error', new Error('release feed unavailable'))
    expect(await within(card).findByText('Could not check: release feed unavailable')).toBeTruthy()
    await waitFor(() =>
      expect(
        within(card).getByRole('button', { name: 'Check for updates' }).hasAttribute('disabled')
      ).toBe(false)
    )

    await expect(handler<{ channel: string }>('update:get-prefs')()).resolves.toMatchObject({
      channel: 'stable'
    })
    expect(quitAndInstall).not.toHaveBeenCalled()
    expect(checkForUpdates).toHaveBeenCalledTimes(3)
  }, 15_000)

  it('restores finite update download progress with bytes, rate and terminal state', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()
    updaterEvents.emit('update-available', { version: '0.0.104' })
    updaterEvents.emit('download-progress', {
      bytesPerSecond: 2 * 1024 * 1024,
      percent: 25,
      total: 100 * 1024 * 1024,
      transferred: 25 * 1024 * 1024,
      delta: 1024
    })
    installRendererTransport()
    vi.useRealTimers()

    const card = await renderUpdateCard()
    expect(await within(card).findByText('Downloading v0.0.104')).toBeTruthy()
    expect(within(card).getByText('25%')).toBeTruthy()
    expect(within(card).getByText(/26 MB \/ 105 MB/)).toBeTruthy()
    expect(within(card).getByText(/2\.0 MB\/s/)).toBeTruthy()

    updaterEvents.emit('update-downloaded', { version: '0.0.104' })
    const restored = await renderUpdateCard()
    expect(await within(restored).findByText('v0.0.104 ready to install')).toBeTruthy()
    expect(within(restored).getByText('100%')).toBeTruthy()
    expect(restored.textContent).not.toContain('NaN')
  })

  it('lets a manual-update user choose when an available version starts downloading', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()
    expect(await handler<boolean>('update:set-auto')(false)).toBe(false)
    installRendererTransport()
    vi.useRealTimers()
    const card = await renderUpdateCard()
    const user = userEvent.setup()

    await user.click(within(card).getByRole('button', { name: 'Check for updates' }))
    updaterEvents.emit('update-available', { version: '0.0.104' })

    expect(await within(card).findByText('Update 0.0.104 is available.')).toBeTruthy()
    expect(downloadUpdate).not.toHaveBeenCalled()
    await user.click(within(card).getByRole('button', { name: 'Download 0.0.104' }))
    expect(await within(card).findByText('Downloading 0.0.104 in the background.')).toBeTruthy()
    expect(downloadUpdate).toHaveBeenCalledOnce()
    expect(checkForUpdates).toHaveBeenCalledOnce()
    expect(updaterEvents.listenerCount('update-available')).toBe(1)
    expect(updaterEvents.listenerCount('update-not-available')).toBe(1)
  })

  it('lets a user skip a version and reports the persisted choice on the next check', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()
    expect(await handler<boolean>('update:set-auto')(false)).toBe(false)
    installRendererTransport()
    vi.useRealTimers()
    const card = await renderUpdateCard()
    const user = userEvent.setup()

    await user.click(within(card).getByRole('button', { name: 'Check for updates' }))
    updaterEvents.emit('update-available', { version: '0.0.104' })
    await user.click(await within(card).findByRole('button', { name: 'Skip 0.0.104' }))

    expect(await within(card).findByText('Skipped v0.0.104.')).toBeTruthy()
    await expect(handler<{ skippedVersion: string }>('update:get-prefs')()).resolves.toMatchObject({
      skippedVersion: '0.0.104'
    })

    await user.click(within(card).getByRole('button', { name: 'Check for updates' }))
    updaterEvents.emit('update-not-available', { version: '0.0.104' })
    expect(await within(card).findByText('Skipped v0.0.104.')).toBeTruthy()
  })

  it('lists compatible history and downloads an explicitly confirmed older version', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(releaseHistory), { status: 200 }))
    )

    await expect(handler('update:list-versions')()).resolves.toEqual([
      {
        version: '0.0.102',
        channel: 'stable',
        publishedAt: '2026-07-01T12:00:00Z'
      }
    ])

    checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.0.102' }
    })
    await expect(handler('update:download-version')('0.0.102')).resolves.toEqual({
      status: 'downloading',
      version: '0.0.102'
    })

    expect(setFeedURL).toHaveBeenNthCalledWith(1, {
      provider: 'generic',
      url: 'https://github.com/off-grid-ai/off-grid-ai-desktop/releases/download/v0.0.102/'
    })
    expect(downloadUpdate).toHaveBeenCalledOnce()
    expect(setFeedURL).toHaveBeenLastCalledWith({
      provider: 'github',
      owner: 'off-grid-ai',
      repo: 'off-grid-ai-desktop'
    })
    await expect(handler<{ auto: boolean }>('update:get-prefs')()).resolves.toMatchObject({
      auto: false
    })
  })

  it('keeps automatic updates on when an older version cannot be verified', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()
    await handler<boolean>('update:set-auto')(true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(releaseHistory), { status: 200 }))
    )
    checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: '0.0.101' }
    })

    await expect(handler('update:download-version')('0.0.102')).rejects.toThrow(
      'The selected version could not be verified for download.'
    )
    await expect(handler<{ auto: boolean }>('update:get-prefs')()).resolves.toMatchObject({
      auto: true
    })
    expect(downloadUpdate).not.toHaveBeenCalled()
  })

  it('reports the installed version when stable is current and releases one-shot listeners', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()

    const result = handler<{ status: string; version: string }>('update:check')()
    updaterEvents.emit('update-not-available', { version: '0.0.103' })

    await expect(result).resolves.toEqual({ status: 'not-available', version: '0.0.103' })
    expect(updaterEvents.listenerCount('update-available')).toBe(1)
    expect(updaterEvents.listenerCount('update-not-available')).toBe(1)
  })

  it('returns a useful boundary failure and remains usable for the next check', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()

    const failed = handler<{ status: string; error: string }>('update:check')()
    updaterEvents.emit('error', new Error('release feed unavailable'))
    await expect(failed).resolves.toEqual({
      status: 'error',
      error: 'release feed unavailable'
    })

    const retry = handler<{ status: string; version: string }>('update:check')()
    updaterEvents.emit('update-not-available', { version: '0.0.103' })
    await expect(retry).resolves.toEqual({ status: 'not-available', version: '0.0.103' })
    expect(checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('times out clearly, cleans up, and allows an immediate retry', async () => {
    const updater = await import('../updater')
    updater.registerUpdateIpc()
    updater.startAutoUpdates()

    const timedOut = updater.checkForUpdates(25)
    await vi.advanceTimersByTimeAsync(25)
    await expect(timedOut).resolves.toEqual({ status: 'error', error: 'Update check timed out' })

    const retry = handler<{ status: string; version: string }>('update:check')()
    updaterEvents.emit('update-not-available', { version: '0.0.103' })
    await expect(retry).resolves.toEqual({ status: 'not-available', version: '0.0.103' })
  })
})
