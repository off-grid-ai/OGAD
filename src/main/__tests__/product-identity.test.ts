import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import pkg from '../../../package.json'
import {
  beginProductIdentityBootstrap,
  SAFE_STORAGE_COMPATIBILITY_NAME
} from '../product-identity-lifecycle'
import { PRODUCT_NAME } from '../../shared/product-identity'

const electronBoundary = vi.hoisted(() => ({
  names: [] as string[],
  paths: [] as Array<{ name: string; value: string }>,
  app: {
    isPackaged: false,
    setName(name: string): void {
      electronBoundary.names.push(name)
    },
    setPath(name: string, value: string): void {
      electronBoundary.paths.push({ name, value })
    },
    getPath(): string {
      throw new Error('The explicit test profile must bypass the default appData path.')
    }
  }
}))

vi.mock('electron', () => ({ app: electronBoundary.app }))

describe('installed product identity', () => {
  it('keeps legacy Safe Storage readable before restoring the canonical visible name', () => {
    const names: string[] = []
    const restoreCanonicalName = beginProductIdentityBootstrap(
      { setName: (name) => names.push(name) },
      'darwin'
    )

    expect(names).toEqual([SAFE_STORAGE_COMPATIBILITY_NAME])
    expect(SAFE_STORAGE_COMPATIBILITY_NAME).toBe('Off Grid AI')

    restoreCanonicalName()

    expect(names).toEqual([SAFE_STORAGE_COMPATIBILITY_NAME, PRODUCT_NAME])
  })

  it('keeps non-macOS storage identity canonical throughout bootstrap', () => {
    const names: string[] = []
    const restoreCanonicalName = beginProductIdentityBootstrap(
      { setName: (name) => names.push(name) },
      'linux'
    )

    restoreCanonicalName()

    expect(names).toEqual([PRODUCT_NAME])
  })

  it('has one canonical runtime and package identity', () => {
    expect(PRODUCT_NAME).toBe('Off Grid AI Desktop')
    expect(pkg.productName).toBe(PRODUCT_NAME)
  })

  it.runIf(process.platform === 'darwin')(
    'initializes the real user-data boundary under the compatibility name, then restores the visible name',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-product-identity-'))
      const profile = path.join(root, 'profile')
      const previous = process.env.OFFGRID_USER_DATA
      process.env.OFFGRID_USER_DATA = profile
      try {
        const { initializeUserData, restoreCanonicalProductName } = await import(
          '../bootstrap/user-data'
        )
        initializeUserData()

        expect(electronBoundary.names).toEqual([SAFE_STORAGE_COMPATIBILITY_NAME])
        expect(electronBoundary.paths).toEqual([{ name: 'userData', value: profile }])
        expect(fs.statSync(profile).isDirectory()).toBe(true)

        restoreCanonicalProductName()
        expect(electronBoundary.names).toEqual([SAFE_STORAGE_COMPATIBILITY_NAME, PRODUCT_NAME])
      } finally {
        if (previous === undefined) delete process.env.OFFGRID_USER_DATA
        else process.env.OFFGRID_USER_DATA = previous
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

afterAll(() => {
  vi.restoreAllMocks()
})
