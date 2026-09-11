import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json'
import {
  beginProductIdentityBootstrap,
  SAFE_STORAGE_COMPATIBILITY_NAME
} from '../product-identity-lifecycle'
import { PRODUCT_NAME } from '../../shared/product-identity'

const root = path.resolve(import.meta.dirname, '../../..')

describe('installed product identity', () => {
  it('keeps legacy Safe Storage readable before restoring the canonical visible name', () => {
    const names: string[] = []
    const restoreCanonicalName = beginProductIdentityBootstrap(
      {
        setName: (name) => names.push(name)
      },
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
      {
        setName: (name) => names.push(name)
      },
      'linux'
    )

    restoreCanonicalName()

    expect(names).toEqual([PRODUCT_NAME])
  })

  it('keeps runtime and every packaging path on the canonical desktop name', () => {
    expect(PRODUCT_NAME).toBe('Off Grid AI Desktop')
    expect(pkg.productName).toBe(PRODUCT_NAME)

    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as {
      version: string
      packages: Record<string, { version?: string }>
    }
    expect(lock.version).toBe(pkg.version)
    expect(lock.packages['']?.version).toBe(pkg.version)

    const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
    expect(builder).toMatch(/^productName: Off Grid AI Desktop$/m)

    const renderer = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
    expect(renderer).toContain('<title>Off Grid AI Desktop</title>')

    const localBuild = fs.readFileSync(path.join(root, 'scripts/build-mac-local.sh'), 'utf8')
    expect(localBuild.match(/-c\.productName="Off Grid AI Desktop"/g)).toHaveLength(2)
    expect(localBuild).not.toMatch(/-c\.productName="Off Grid AI(?: Pro)?"/)

    const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
    const userDataBootstrap = fs.readFileSync(
      path.join(root, 'src/main/bootstrap/user-data.ts'),
      'utf8'
    )
    const firstImport = main.indexOf(
      "import { restoreCanonicalProductName } from './bootstrap/user-data'"
    )
    const ready = main.indexOf('app.whenReady().then')
    const restore = main.indexOf('restoreCanonicalProductName()', ready)
    const serverOnly = main.indexOf("process.argv.includes('--server-only')", ready)
    expect(firstImport).toBe(0)
    expect(userDataBootstrap).toContain('beginProductIdentityBootstrap(app, process.platform)')
    expect(userDataBootstrap).toContain("app.setPath('userData', process.env.OFFGRID_USER_DATA)")
    expect(userDataBootstrap).toContain('app.exit(1)')
    expect(userDataBootstrap).toContain('throw error')
    expect(restore).toBeGreaterThan(ready)
    expect(restore).toBeLessThan(serverOnly)
    expect(main).toContain('applicationName: PRODUCT_NAME')
  })
})
