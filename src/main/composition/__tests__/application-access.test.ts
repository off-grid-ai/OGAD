import { describe, expect, it, vi } from 'vitest'

// The registry's own lifecycle, proved through the real proxy rather than through a fake registry:
// `desktopModels` resolves `current()` on every access, so whether the registration is live is
// observable as whether that access throws.
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), isPackaged: false, getAppPath: () => process.cwd() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

describe('desktop application registration', () => {
  it('disposing the registration makes every accessor refuse rather than serve a dead application', async () => {
    const access = await import('../application-access')
    const { desktopApplication } = await import('../application')
    const release = access.registerDesktopApplication(desktopApplication)
    expect(() => access.desktopModels.snapshot()).not.toThrow()
    release()
    expect(() => access.desktopModels.snapshot()).toThrow('Desktop application is not initialized.')
    // Re-register so the module-level state does not leak into the next case.
    access.registerDesktopApplication(desktopApplication)
  })

  it('an old disposer cannot clear a newer registration', async () => {
    const access = await import('../application-access')
    const { desktopApplication } = await import('../application')
    const stale = access.registerDesktopApplication(desktopApplication)
    // A NEWER registration of the same value supersedes the old disposer's authority only if the
    // registry tracks identity per registration rather than per value - so use a distinct value.
    const newer = { ...desktopApplication }
    const releaseNewer = access.registerDesktopApplication(newer)
    stale()
    expect(() => access.desktopModels.snapshot()).not.toThrow()
    releaseNewer()
    expect(() => access.desktopModels.snapshot()).toThrow('Desktop application is not initialized.')
    access.registerDesktopApplication(desktopApplication)
  })
})
