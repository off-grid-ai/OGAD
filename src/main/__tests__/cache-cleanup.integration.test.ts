/**
 * RELEASE_TEST_CHECKLIST #134 at the owning main-process seam. Electron's cache
 * store is the only controlled boundary; the production cleanup receives no path
 * to any durable Off Grid AI store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  cacheBytes: 0,
  measurementFails: false,
  cleanupFails: false,
  clearCalls: [] as Array<{ dataTypes: string[] }>
}))

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      getCacheSize: async () => {
        if (boundary.measurementFails) throw new Error('cache size unavailable')
        return boundary.cacheBytes
      },
      clearData: async (options: { dataTypes: string[] }) => {
        boundary.clearCalls.push(options)
        if (boundary.cleanupFails) throw new Error('cache clear failed')
        boundary.cacheBytes = 0
      }
    }
  }
}))

import { clearEphemeralCache } from '../cache-cleanup'

beforeEach(() => {
  boundary.cacheBytes = 8_192
  boundary.measurementFails = false
  boundary.cleanupFails = false
  boundary.clearCalls.length = 0
})

describe('ephemeral cache cleanup', () => {
  it('allowlists only Electron cache data and reports reclaimed bytes (#134)', async () => {
    await expect(clearEphemeralCache()).resolves.toEqual({ success: true, freedBytes: 8_192 })
    expect(boundary.clearCalls).toEqual([{ dataTypes: ['cache'] }])
  })

  it('still clears when Electron cannot measure the cache size', async () => {
    boundary.measurementFails = true

    await expect(clearEphemeralCache()).resolves.toEqual({ success: true, freedBytes: null })
    expect(boundary.clearCalls).toEqual([{ dataTypes: ['cache'] }])
  })

  it('does not report success when Electron rejects the cleanup', async () => {
    boundary.cleanupFails = true

    await expect(clearEphemeralCache()).rejects.toThrow('cache clear failed')
  })
})
