import { describe, expect, it } from 'vitest'
import { decodeLicenseCache, encodeLicenseCache, type ProLicense } from '../license-cache'

const LICENSE: ProLicense = {
  isPro: true,
  key: 'KEY',
  licenseId: 'license-id',
  expiry: null,
  verifiedAt: 123
}

const plaintext = (): string => JSON.stringify({ enc: false, data: JSON.stringify(LICENSE) })

describe('license cache trust policy', () => {
  it('rejects an unsigned plaintext entitlement in a packaged build', () => {
    expect(() =>
      decodeLicenseCache(plaintext(), {
        packaged: true,
        decrypt: () => {
          throw new Error('must not decrypt plaintext')
        }
      })
    ).toThrow('packaged builds reject plaintext license caches')
  })

  it('allows the development-only plaintext fallback outside a packaged build', () => {
    expect(
      decodeLicenseCache(plaintext(), {
        packaged: false,
        decrypt: () => {
          throw new Error('must not decrypt plaintext')
        }
      })
    ).toEqual(LICENSE)
  })

  it('round-trips an encrypted cache without trusting the wrapper as entitlement', () => {
    const wrapper = encodeLicenseCache(LICENSE, {
      packaged: true,
      encryptionAvailable: true,
      encrypt: (value) => Buffer.from(`sealed:${value}`)
    })
    expect(wrapper?.enc).toBe(true)
    expect(
      decodeLicenseCache(JSON.stringify(wrapper), {
        packaged: true,
        decrypt: (value) => value.toString().replace(/^sealed:/, '')
      })
    ).toEqual(LICENSE)
  })

  it('refuses to persist packaged entitlement when OS encryption is unavailable', () => {
    expect(
      encodeLicenseCache(LICENSE, {
        packaged: true,
        encryptionAvailable: false,
        encrypt: () => {
          throw new Error('must not encrypt')
        }
      })
    ).toBeNull()
  })

  it('rejects malformed entitlement fields instead of coercing them', () => {
    const malformed = JSON.stringify({
      enc: false,
      data: JSON.stringify({ ...LICENSE, isPro: 'true' })
    })
    expect(() => decodeLicenseCache(malformed, { packaged: false, decrypt: () => '' })).toThrow(
      'license cache isPro is malformed'
    )
  })
})
