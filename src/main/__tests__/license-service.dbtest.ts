// In the DB suite because license-service.ts is a Keychain/IPC shell excluded from unit coverage
// (vitest.config.ts); the provider is the only boundary and is faked at its contract.
import { afterEach, describe, expect, it } from 'vitest'
import {
  listProDevices,
  registerProEntitlementProvider,
  revalidateProEntitlement,
  type ProEntitlementProvider,
  type ProLicenseInfo
} from '../licensing/license-service'

const INFO: ProLicenseInfo = { isPro: true, tier: 'annual', expiry: null, verifiedAt: 0 }

/** The paid provider is the external boundary; this fake answers revalidation when released. */
function fakeProvider(): {
  provider: ProEntitlementProvider
  started(): number
  finish(): void
  fail(error: Error): void
} {
  let started = 0
  let settle: { resolve: () => void; reject: (error: Error) => void } | null = null
  const provider: ProEntitlementProvider = {
    initialize: () => undefined,
    refreshCachedState: () => undefined,
    revalidate: () => {
      started += 1
      return new Promise<void>((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    isEntitled: () => true,
    getInfo: () => INFO,
    activate: async () => ({ ok: false, reason: 'invalid_credential' }),
    listDevices: async () => [],
    deactivateDevice: async () => true,
    resetCurrentDevice: async () => true,
    clear: () => undefined,
    setChangeNotifier: () => undefined
  }
  return {
    provider,
    started: () => started,
    finish: () => settle?.resolve(),
    fail: (error) => settle?.reject(error)
  }
}

let unregister: (() => void) | undefined

afterEach(() => {
  unregister?.()
  unregister = undefined
})

describe('entitlement revalidation', () => {
  it('shares one in-flight check between overlapping triggers', async () => {
    const boundary = fakeProvider()
    unregister = registerProEntitlementProvider(boundary.provider)

    const launch = revalidateProEntitlement('launch')
    const focus = revalidateProEntitlement('foreground')

    expect(boundary.started()).toBe(1)
    boundary.finish()
    await expect(Promise.all([launch, focus])).resolves.toEqual([undefined, undefined])
  })

  it('starts a new check once the previous one has settled', async () => {
    const boundary = fakeProvider()
    unregister = registerProEntitlementProvider(boundary.provider)

    const first = revalidateProEntitlement('launch')
    boundary.finish()
    await first
    const second = revalidateProEntitlement('foreground')

    expect(boundary.started()).toBe(2)
    boundary.finish()
    await second
  })

  it('reports a failed check to every waiting caller and does not keep it in flight', async () => {
    const boundary = fakeProvider()
    unregister = registerProEntitlementProvider(boundary.provider)

    const launch = revalidateProEntitlement('launch')
    const focus = revalidateProEntitlement('foreground')
    boundary.fail(new Error('license server unreachable'))

    await expect(launch).rejects.toThrow('license server unreachable')
    await expect(focus).rejects.toThrow('license server unreachable')
    const retry = revalidateProEntitlement('foreground')
    expect(boundary.started()).toBe(2)
    boundary.finish()
    await retry
  })

  it('resolves without work when no provider is registered', async () => {
    await expect(revalidateProEntitlement('launch')).resolves.toBeUndefined()
  })
})

describe('licensed device list', () => {
  it('reports an unavailable license service instead of an empty list', async () => {
    await expect(listProDevices()).rejects.toThrow('License service unavailable')
  })

  it('returns the provider answer when the service is available', async () => {
    const boundary = fakeProvider()
    unregister = registerProEntitlementProvider(boundary.provider)

    await expect(listProDevices()).resolves.toEqual([])
  })
})
