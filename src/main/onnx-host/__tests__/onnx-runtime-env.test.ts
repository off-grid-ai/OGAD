// The environment a voice or search helper starts with, over a performance pack installed on disk
// the way the installer leaves it. The operating system is the controlled boundary: the platform
// and architecture are set per test, everything else (manifest, pack folder, check records) is real.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureRuntime } from '../../runtime-env'
import { installedOnnxCudaDir, onnxHelperEnv } from '../onnx-runtime-env'
import { onnxCudaVerified } from '../onnx-cuda-verified'
import { probeOnnxCuda } from '../onnx-cuda-probe'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-onnx-env-'))
const SHA = 'ab'.repeat(32)
const VERSION = 'test-v1'
const original = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform')!,
  arch: Object.getOwnPropertyDescriptor(process, 'arch')!,
  ldPath: process.env.LD_LIBRARY_PATH,
  localAppData: process.env.LOCALAPPDATA
}

function runOn(platform: 'linux' | 'win32' | 'darwin', arch = 'x64'): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  Object.defineProperty(process, 'arch', { value: arch, configurable: true })
}

/** The bundled manifest naming this platform's pack. */
function manifest(platform: 'linux' | 'win32'): void {
  fs.writeFileSync(
    path.join(ROOT, 'performance-packs.json'),
    JSON.stringify({
      schemaVersion: 1,
      cuda: {
        [platform]: {
          url: `https://runtime.getoffgridai.co/desktop/cuda/${platform}/${VERSION}.tar.gz`,
          sha256: SHA,
          bytes: 1024,
          version: VERSION
        }
      }
    })
  )
}

/** A verified pack with its ONNX CUDA libraries, as the installer leaves it. */
function installPack(platform: 'linux' | 'win32'): string {
  const pack = path.join(ROOT, 'performance-packs', `cuda-${VERSION}-${SHA.slice(0, 12)}`)
  const libraries = path.join(pack, 'bin', 'onnx-cuda')
  fs.mkdirSync(libraries, { recursive: true })
  fs.writeFileSync(path.join(pack, 'verified.sha256'), `${SHA}\n`)
  fs.writeFileSync(
    path.join(libraries, platform === 'win32' ? 'onnxruntime.dll' : 'libcublasLt.so.13'),
    'test'
  )
  return pack
}

beforeAll(() => {
  delete process.env.LOCALAPPDATA
  configureRuntime({ dataDir: ROOT, resourceDirs: [ROOT] })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', original.platform)
  Object.defineProperty(process, 'arch', original.arch)
  fs.rmSync(path.join(ROOT, 'performance-packs'), { recursive: true, force: true })
  fs.rmSync(path.join(ROOT, 'performance-packs.json'), { force: true })
})

afterAll(() => {
  if (original.ldPath === undefined) delete process.env.LD_LIBRARY_PATH
  else process.env.LD_LIBRARY_PATH = original.ldPath
  if (original.localAppData !== undefined) process.env.LOCALAPPDATA = original.localAppData
  configureRuntime({ dataDir: undefined, resourceDirs: undefined })
  fs.rmSync(ROOT, { recursive: true, force: true })
})

describe('helper environment', () => {
  it('starts a helper with the plain environment when no pack is installed', () => {
    runOn('linux')
    manifest('linux')
    expect(installedOnnxCudaDir()).toBeNull()
    const env = onnxHelperEnv()
    expect(env.LD_LIBRARY_PATH).toBe(process.env.LD_LIBRARY_PATH)
    expect(env.OFFGRID_ONNX_CUDA_VERIFIED).toBeUndefined()
  })

  it('puts the pack’s CUDA libraries first on Linux, once', () => {
    runOn('linux')
    manifest('linux')
    const pack = installPack('linux')
    const libraries = path.join(pack, 'bin', 'onnx-cuda')
    expect(installedOnnxCudaDir()).toBe(libraries)

    process.env.LD_LIBRARY_PATH = '/usr/lib/existing'
    expect(onnxHelperEnv().LD_LIBRARY_PATH).toBe(`${libraries}:/usr/lib/existing`)
    // Already on the path: not added again.
    process.env.LD_LIBRARY_PATH = `${libraries}:/usr/lib/existing`
    expect(onnxHelperEnv().LD_LIBRARY_PATH).toBe(`${libraries}:/usr/lib/existing`)
  })

  it('does not offer the pack on an architecture it has no engines for', () => {
    runOn('linux', 'arm64')
    manifest('linux')
    installPack('linux')
    expect(installedOnnxCudaDir()).toBeNull()
  })

  it('loads the Windows CUDA addon only after the CUDA check passed (or for the check itself)', () => {
    runOn('win32')
    manifest('win32')
    const pack = installPack('win32')
    const libraries = path.join(pack, 'bin', 'onnx-cuda')

    expect(onnxCudaVerified()).toEqual({ usable: false, reason: { code: 'not-verified' } })
    expect(onnxHelperEnv().OFFGRID_ONNX_CUDA_VERIFIED).toBeUndefined()

    // The check itself runs with the addon.
    const forced = onnxHelperEnv('force')
    expect(forced.OFFGRID_ONNX_CUDA_VERIFIED).toBe('1')
    expect(forced.OFFGRID_PERFORMANCE_PACK_BIN).toBe(path.join(pack, 'bin'))
    expect(forced.PATH!.startsWith(`${libraries}${path.win32.delimiter}`)).toBe(true)

    // The check passed for this pack and driver: every helper gets the addon.
    fs.writeFileSync(
      path.join(pack, 'onnx-cuda-verified.json'),
      JSON.stringify({
        packRoot: pack,
        driver: null,
        at: new Date().toISOString()
      })
    )
    expect(onnxCudaVerified()).toEqual({ usable: true })
    expect(onnxHelperEnv().OFFGRID_ONNX_CUDA_VERIFIED).toBe('1')

    // A record for another pack does not count.
    fs.writeFileSync(
      path.join(pack, 'onnx-cuda-verified.json'),
      JSON.stringify({ packRoot: '/elsewhere', driver: null, at: new Date().toISOString() })
    )
    expect(onnxCudaVerified().usable).toBe(false)
  })

  it('says why CUDA voice and search are unavailable', async () => {
    runOn('darwin', 'arm64')
    expect(onnxCudaVerified()).toEqual({ usable: false, reason: { code: 'no-device' } })
    expect(await probeOnnxCuda()).toBe(false)

    runOn('win32')
    manifest('win32')
    expect(onnxCudaVerified()).toEqual({ usable: false, reason: { code: 'needs-pack' } })
    // No pack, nothing to check.
    expect(await probeOnnxCuda()).toBe(false)

    // A pack but no search model on disk yet: the check waits rather than marking CUDA failed.
    const pack = installPack('win32')
    expect(await probeOnnxCuda()).toBe(false)
    expect(fs.existsSync(path.join(pack, 'onnx-cuda-failed.json'))).toBe(false)
  })
})
