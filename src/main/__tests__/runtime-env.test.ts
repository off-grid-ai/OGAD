// Unit tests for the host-agnostic path/resource resolver (runtime-env.ts).
//
// These exercise the resolution order documented in the module:
//   explicit configure() -> env vars -> Electron app -> cwd fallback.
// In vitest there is no Electron `app`, so the lazy `require('electron')` probe
// returns null and the tests observe the configure()/env/cwd branches directly.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'path'
import {
  configureRuntime,
  dataDir,
  modelsDir,
  binRoots,
  resourceDirs,
  resourceFile,
  resolveApplicationCodeFile,
  isPackaged
} from '../runtime-env'

// The module holds a private `cfg` that persists across calls. Reset it before
// each test so cases don't leak into one another.
function resetConfig(): void {
  configureRuntime({ dataDir: undefined, modelsDir: undefined, binRoots: undefined, resourceDirs: undefined })
}

const ENV_KEYS = [
  'OFFGRID_DATA_DIR',
  'OFFGRID_BIN_DIR',
  'OFFGRID_RESOURCE_DIR',
  'OFFGRID_PACKAGED'
] as const

describe('runtime-env', () => {
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    resetConfig()
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]!
    }
    resetConfig()
  })

  describe('dataDir', () => {
    it('prefers an explicit configure() value over everything else', () => {
      process.env.OFFGRID_DATA_DIR = '/env/data'
      configureRuntime({ dataDir: '/explicit/data' })
      expect(dataDir()).toBe('/explicit/data')
    })

    it('falls back to the OFFGRID_DATA_DIR env var when unconfigured', () => {
      process.env.OFFGRID_DATA_DIR = '/env/data'
      expect(dataDir()).toBe('/env/data')
    })

    it('falls back to a .offgrid dir under cwd when nothing is set (no Electron)', () => {
      expect(dataDir()).toBe(path.join(process.cwd(), '.offgrid'))
    })
  })

  describe('modelsDir', () => {
    it('is the models subdir of dataDir()', () => {
      configureRuntime({ dataDir: '/explicit/data' })
      expect(modelsDir()).toBe(path.join('/explicit/data', 'models'))
    })

    it('tracks the cwd fallback when unconfigured', () => {
      expect(modelsDir()).toBe(path.join(process.cwd(), '.offgrid', 'models'))
    })

    it('uses a host-selected model directory', () => {
      configureRuntime({ dataDir: '/explicit/data', modelsDir: '/external/models' })
      expect(modelsDir()).toBe('/external/models')
      expect(dataDir()).toBe('/explicit/data')
    })
  })

  describe('binRoots', () => {
    it('prefers a non-empty configured list', () => {
      configureRuntime({ binRoots: ['/a', '/b'] })
      expect(binRoots()).toEqual(['/a', '/b'])
    })

    it('ignores an empty configured list and uses the env var', () => {
      configureRuntime({ binRoots: [] })
      process.env.OFFGRID_BIN_DIR = '/env/bin'
      expect(binRoots()).toEqual(['/env/bin'])
    })

    it('uses development binary roots for the current platform', () => {
      const root = process.cwd()
      expect(binRoots()).toEqual(
        process.platform === 'linux'
          ? [path.join(root, 'build', 'linux-bin'), path.join(root, 'resources', 'bin')]
          : [path.join(root, 'resources', 'bin')]
      )
    })
  })

  describe('resourceDirs', () => {
    it('prefers a non-empty configured list', () => {
      configureRuntime({ resourceDirs: ['/r1', '/r2'] })
      expect(resourceDirs()).toEqual(['/r1', '/r2'])
    })

    it('ignores an empty configured list and uses the env var', () => {
      configureRuntime({ resourceDirs: [] })
      process.env.OFFGRID_RESOURCE_DIR = '/env/res'
      expect(resourceDirs()).toEqual(['/env/res'])
    })

    it('falls back to resources under cwd when nothing is set', () => {
      expect(resourceDirs()).toEqual([path.join(process.cwd(), 'resources')])
    })
  })

  describe('resourceFile', () => {
    it('returns the path of a file that exists under a resource dir', () => {
      // Point the resource dir at this test directory and look up a file we know exists.
      configureRuntime({ resourceDirs: [__dirname] })
      const found = resourceFile(path.basename(__filename))
      expect(found).toBe(path.join(__dirname, path.basename(__filename)))
    })

    it('returns null when the file exists in no resource dir', () => {
      configureRuntime({ resourceDirs: [__dirname] })
      expect(resourceFile('definitely-not-a-real-file.xyz')).toBeNull()
    })

    it('searches multiple dirs and returns the first hit', () => {
      configureRuntime({ resourceDirs: ['/nonexistent-dir-abc', __dirname] })
      const found = resourceFile(path.basename(__filename))
      expect(found).toBe(path.join(__dirname, path.basename(__filename)))
    })
  })

  describe('resolveApplicationCodeFile', () => {
    it('ignores external development directories for a packaged application', () => {
      const packagedName = path.basename(__filename)
      const appPath = path.resolve(__dirname, '../../..')
      const expected = path.join(appPath, 'out', 'main', packagedName)
      const external = path.join(__dirname, packagedName)

      expect(fs.existsSync(external)).toBe(true)
      expect(
        resolveApplicationCodeFile({
          packagedAppPath: appPath,
          packagedName,
          developmentName: packagedName,
          developmentDirs: [__dirname]
        })
      ).toBe(fs.existsSync(expected) ? expected : null)
    })

    it('uses the configured resource directories for a development host', () => {
      const name = path.basename(__filename)
      expect(
        resolveApplicationCodeFile({
          packagedAppPath: null,
          packagedName: 'ignored.js',
          developmentName: name,
          developmentDirs: [__dirname]
        })
      ).toBe(path.join(__dirname, name))
    })
  })

  describe('isPackaged', () => {
    it('returns true when OFFGRID_PACKAGED is "1"', () => {
      process.env.OFFGRID_PACKAGED = '1'
      expect(isPackaged()).toBe(true)
    })

    it('returns false when OFFGRID_PACKAGED is set to a non-"1" value', () => {
      process.env.OFFGRID_PACKAGED = '0'
      expect(isPackaged()).toBe(false)
    })

    it('returns false when unset and there is no Electron', () => {
      expect(isPackaged()).toBe(false)
    })
  })
})
