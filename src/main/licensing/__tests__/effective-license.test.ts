import { describe, expect, it } from 'vitest'
import { effectiveProLicenseInfo } from '../effective-license'

const inactive = {
  isPro: false,
  tier: null,
  expiry: null,
  verifiedAt: 0
} as const

describe('effectiveProLicenseInfo', () => {
  it('projects an active development override without inventing provider metadata', () => {
    expect(effectiveProLicenseInfo(inactive, true)).toEqual({ ...inactive, isPro: true })
  })

  it('preserves an unchanged provider result by reference', () => {
    expect(effectiveProLicenseInfo(inactive, false)).toBe(inactive)
  })
})
