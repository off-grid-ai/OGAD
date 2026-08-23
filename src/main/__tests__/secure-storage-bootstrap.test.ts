import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { repairMissingDefaultKeychainAtBootstrap } from '../secure-storage-bootstrap'

afterEach(() => vi.restoreAllMocks())

describe('secure storage bootstrap', () => {
  it('does nothing outside macOS and reports a missing native bridge', () => {
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(repairMissingDefaultKeychainAtBootstrap('linux', false)).toBeNull()
    expect(exists).not.toHaveBeenCalled()
    expect(repairMissingDefaultKeychainAtBootstrap('darwin', false)).toBeNull()
    expect(error).toHaveBeenCalledWith('[secure-storage] Keychain recovery bridge is missing')
  })

  it.each([
    [0, 'healthy', 'The user default Keychain is available.'],
    [1, 'repaired', 'The existing login Keychain was restored for Off Grid secure storage.'],
    [2, 'unavailable', 'The login Keychain is unavailable and was not changed.'],
    [3, 'failed', 'macOS refused to restore the existing login Keychain.']
  ] as const)('maps native status %s to %s', (nativeStatus, status, detail) => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    vi.spyOn(process, 'dlopen').mockImplementation((nativeModule) => {
      ;(nativeModule as NodeModule).exports = { status: nativeStatus, osStatus: -25300 }
    })

    expect(repairMissingDefaultKeychainAtBootstrap('darwin', false)).toEqual({
      status,
      detail,
      osStatus: -25300
    })
  })

  it('uses the packaged helper and rejects an invalid native response', () => {
    const originalResourcesPath = process.resourcesPath
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/private/tmp/offgrid-packaged'
    })
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'dlopen').mockImplementation((nativeModule) => {
      ;(nativeModule as NodeModule).exports = { status: 99, osStatus: 'not-a-number' }
    })

    expect(repairMissingDefaultKeychainAtBootstrap('darwin', true)).toBeNull()
    expect(exists).toHaveBeenCalledWith(expect.stringContaining('/bin/keychain-bootstrap.node'))
    expect(error).toHaveBeenCalledWith(
      '[secure-storage] Keychain recovery returned an invalid response'
    )
    if (originalResourcesPath === undefined) Reflect.deleteProperty(process, 'resourcesPath')
    else Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath })
  })

  it('contains a native bridge failure and keeps bootstrap available', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const failure = new Error('native bridge unavailable')
    vi.spyOn(process, 'dlopen').mockImplementation(() => {
      throw failure
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(repairMissingDefaultKeychainAtBootstrap('darwin', false)).toBeNull()
    expect(error).toHaveBeenCalledWith('[secure-storage] Keychain recovery failed', failure)
  })
})
