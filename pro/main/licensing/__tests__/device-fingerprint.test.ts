/**
 * Device fingerprint — the stable per-install id used to claim a Keygen machine
 * slot, and the platform tag stored on that machine.
 *
 * Electron's app.getPath is mocked to a real temp dir (like vault-service.test.ts)
 * so persistence is exercised against actual files; node:crypto runs for real.
 * process.platform is stubbed per-case for getPlatformTag. The module is reset
 * between cases so its in-memory cache doesn't leak across tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let fakeUserData = ''
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData) }
}))

async function freshModule(): Promise<typeof import('../device-fingerprint')> {
  vi.resetModules()
  return import('../device-fingerprint')
}

beforeEach(() => {
  fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-'))
})

afterEach(() => {
  fs.rmSync(fakeUserData, { recursive: true, force: true })
})

describe('getPlatformTag', () => {
  const realPlatform = process.platform

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('returns "macos" on darwin', async () => {
    setPlatform('darwin')
    const { getPlatformTag } = await freshModule()
    expect(getPlatformTag()).toBe('macos')
  })

  it('returns "windows" on win32', async () => {
    setPlatform('win32')
    const { getPlatformTag } = await freshModule()
    expect(getPlatformTag()).toBe('windows')
  })

  it('returns "linux" on linux', async () => {
    setPlatform('linux')
    const { getPlatformTag } = await freshModule()
    expect(getPlatformTag()).toBe('linux')
  })

  it('passes an unknown platform through unchanged', async () => {
    setPlatform('freebsd' as NodeJS.Platform)
    const { getPlatformTag } = await freshModule()
    expect(getPlatformTag()).toBe('freebsd')
  })
})

describe('getDeviceFingerprint', () => {
  it('generates a 32-hex-char fingerprint (16 random bytes)', async () => {
    const { getDeviceFingerprint } = await freshModule()
    const fp = await getDeviceFingerprint()
    expect(fp).toMatch(/^[0-9a-f]{32}$/)
  })

  it('is stable across two calls within one process (in-memory cache)', async () => {
    const { getDeviceFingerprint } = await freshModule()
    const a = await getDeviceFingerprint()
    const b = await getDeviceFingerprint()
    expect(b).toBe(a)
  })

  it('persists to userData so a reinstall/reboot reuses the same id', async () => {
    const first = await freshModule()
    const fp1 = await first.getDeviceFingerprint()

    // Simulate a fresh process: reset the module (clears the in-memory cache) but
    // keep the same userData dir. The persisted file must be read back verbatim.
    const second = await freshModule()
    const fp2 = await second.getDeviceFingerprint()
    expect(fp2).toBe(fp1)

    const onDisk = fs.readFileSync(path.join(fakeUserData, 'device-fingerprint'), 'utf8').trim()
    expect(onDisk).toBe(fp1)
  })

  it('regenerates a different fingerprint for a different install (new userData dir)', async () => {
    const first = await freshModule()
    const fp1 = await first.getDeviceFingerprint()

    // New "install": different userData dir + cleared module cache.
    fakeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-test-2-'))
    const second = await freshModule()
    const fp2 = await second.getDeviceFingerprint()
    expect(fp2).not.toBe(fp1)
    fs.rmSync(fakeUserData, { recursive: true, force: true })
  })

  it('ignores an empty persisted file and generates a fresh id', async () => {
    fs.writeFileSync(path.join(fakeUserData, 'device-fingerprint'), '   ')
    const { getDeviceFingerprint } = await freshModule()
    const fp = await getDeviceFingerprint()
    expect(fp).toMatch(/^[0-9a-f]{32}$/)
  })

  it('writes the fingerprint file with 0600 perms', async () => {
    const { getDeviceFingerprint } = await freshModule()
    await getDeviceFingerprint()
    const mode = fs.statSync(path.join(fakeUserData, 'device-fingerprint')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
