/**
 * RELEASE_TEST_CHECKLIST #134 at the owning main-process seam. Electron's cache
 * store is the only controlled boundary; the production cleanup receives no path
 * to any durable Off Grid AI store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
import { CATALOG } from '@offgrid/models'

const originalDataDir = process.env.OFFGRID_DATA_DIR
let temporaryDataDir: string

beforeEach(() => {
  temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-cache-cleanup-'))
  process.env.OFFGRID_DATA_DIR = temporaryDataDir
  boundary.cacheBytes = 8_192
  boundary.measurementFails = false
  boundary.cleanupFails = false
  boundary.clearCalls.length = 0
})

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(temporaryDataDir, { recursive: true, force: true })
})

describe('ephemeral cache cleanup', () => {
  it('allowlists only Electron cache data and reports reclaimed bytes (#134)', async () => {
    const model = CATALOG.find((entry) => entry.files.length > 0)!
    const modelsDir = path.join(temporaryDataDir, 'models')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.writeFileSync(
      path.join(modelsDir, 'downloads.json'),
      JSON.stringify([{ modelId: model.id, status: 'failed' }])
    )
    const partial = path.join(modelsDir, `${model.files[0]!.name}.part`)
    const installed = path.join(modelsDir, 'installed.gguf')
    fs.mkdirSync(path.dirname(partial), { recursive: true })
    fs.writeFileSync(partial, Buffer.alloc(1_024))
    fs.writeFileSync(installed, 'keep')

    await expect(clearEphemeralCache()).resolves.toEqual({ success: true, freedBytes: 9_216 })
    expect(fs.existsSync(partial)).toBe(false)
    expect(fs.existsSync(path.join(modelsDir, 'downloads.json'))).toBe(false)
    expect(fs.readFileSync(installed, 'utf8')).toBe('keep')
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
