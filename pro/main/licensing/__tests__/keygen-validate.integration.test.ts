import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateKey } from '../keygen-client'

describe('Keygen validation service boundary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps an unknown third-party validation code to UNKNOWN', async () => {
    const fetchBoundary = vi.fn(async () =>
      Response.json({
        meta: { valid: false, code: 'FUTURE_KEYGEN_CODE' },
        data: { id: 'license-1', attributes: { expiry: null } }
      })
    )
    vi.stubGlobal('fetch', fetchBoundary)

    const result = await validateKey('test-license-key', 'test-device-fingerprint')

    expect(fetchBoundary).toHaveBeenCalledOnce()
    expect(result).toEqual({
      valid: false,
      code: 'UNKNOWN',
      license: { id: 'license-1', expiry: null, metadata: {}, name: null }
    })
  })
})
