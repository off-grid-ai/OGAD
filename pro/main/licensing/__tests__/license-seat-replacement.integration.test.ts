/**
 * License activation through the real service and Keygen client. Only the third-party HTTP
 * boundary and Electron's OS storage boundary are replaced.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  userData: `/tmp/offgrid-license-seat-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}`,
  fingerprint: 'current-device-fingerprint'
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userData,
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import {
  activateProByKey,
  getProLicenseInfo,
  setDirectEntitlementActivationOwner
} from '../license-service'
import { installEntitlementActivationFake } from '../../__tests__/helpers/entitlementActivationFake'

const machine = (id: string, fingerprint: string, lastSeen: string): Record<string, unknown> => ({
  type: 'machines',
  id,
  attributes: {
    fingerprint,
    platform: 'macos',
    name: id,
    lastHeartbeat: lastSeen
  }
})

beforeAll(() => {
  fs.mkdirSync(h.userData, { recursive: true })
  fs.writeFileSync(path.join(h.userData, 'device-fingerprint'), h.fingerprint)
})

// Activation goes through the personal-mesh registry owner the sync layer registers in production.
// Without it every activation waits for an owner that never arrives and reports network_unavailable.
let activation: ReturnType<typeof installEntitlementActivationFake>

beforeEach(() => {
  activation = installEntitlementActivationFake(setDirectEntitlementActivationOwner)
})

afterEach(() => {
  activation.stop()
  vi.unstubAllGlobals()
})

afterAll(() => {
  fs.rmSync(h.userData, { recursive: true, force: true })
})

describe('Pro activation at the device limit', () => {
  it('activates through the registry owner when the licence reports its machine cap', async () => {
    const requests: Array<{ method: string; path: string }> = []
    const fetchBoundary = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      requests.push({ method, path: url.pathname })

      if (url.pathname.endsWith('/licenses/actions/validate-key')) {
        return Response.json({
          meta: { valid: false, code: 'TOO_MANY_MACHINES' },
          data: {
            type: 'licenses',
            id: 'license-1',
            attributes: { expiry: null, metadata: {}, name: 'Pro' }
          }
        })
      }
      if (url.pathname.endsWith('/licenses/license-1/machines')) {
        return Response.json({
          data: [
            machine('machine-current', h.fingerprint, '2020-01-01T00:00:00Z'),
            machine('machine-oldest', 'oldest-device', '2024-01-01T00:00:00Z'),
            machine('machine-newer-1', 'newer-1', '2025-01-01T00:00:00Z'),
            machine('machine-newer-2', 'newer-2', '2025-02-01T00:00:00Z'),
            machine('machine-newest', 'newest', '2025-03-01T00:00:00Z')
          ]
        })
      }
      if (url.pathname.endsWith('/machines/machine-oldest') && method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
      if (url.pathname.endsWith('/machines') && method === 'POST') {
        return new Response(null, { status: 201 })
      }
      return new Response(null, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchBoundary)

    await expect(activateProByKey('license-key')).resolves.toEqual({ ok: true })

    // A licence at its cap still activates - and which device gives up its seat is the personal-mesh
    // registry's decision, not a DELETE this service issues. So the licence service asks Keygen one
    // question, then hands the activation to the owner as a transaction.
    expect(
      requests.map(({ method, path: requestPath }) => ({
        method,
        path: requestPath.replace(/^\/v1\/accounts\/[^/]+/, '')
      }))
    ).toEqual([{ method: 'POST', path: '/licenses/actions/validate-key' }])
    expect(activation.prepared).toEqual([
      {
        key: 'license-key',
        licenseId: 'license-1',
        expiresAt: null,
        fingerprint: h.fingerprint,
        platform: expect.any(String)
      }
    ])
    expect(activation.committed).toHaveLength(1)
    expect(getProLicenseInfo()).toMatchObject({ isPro: true, tier: 'lifetime' })
  })
})
