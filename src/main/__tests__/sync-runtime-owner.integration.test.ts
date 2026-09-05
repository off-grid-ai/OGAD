import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('Desktop Sync runtime ownership', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('holds one application lease and permits a new lease only after release', async () => {
    const { claimDesktopSyncRuntime, desktopSyncRuntimeOwner } =
      await import('../sync-runtime-owner')

    expect(desktopSyncRuntimeOwner()).toBeNull()

    const release = claimDesktopSyncRuntime('application')
    expect(desktopSyncRuntimeOwner()).toBe('application')
    expect(() => claimDesktopSyncRuntime('application')).toThrow(
      'Desktop Sync is already owned by the application runtime.'
    )

    release()
    expect(desktopSyncRuntimeOwner()).toBeNull()
    release()
    expect(desktopSyncRuntimeOwner()).toBeNull()

    const releaseNext = claimDesktopSyncRuntime('application')
    expect(desktopSyncRuntimeOwner()).toBe('application')
    releaseNext()
    expect(desktopSyncRuntimeOwner()).toBeNull()
  })
})
