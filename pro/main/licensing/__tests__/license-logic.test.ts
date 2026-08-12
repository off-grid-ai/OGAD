/**
 * Pro-gate licensing logic — the pure entitlement decisions that drive the whole
 * app's pro gate (isProEntitled → isProActive) and the Settings status UI (toInfo).
 *
 * High blast radius: a wrong `isProActive` either locks out a paying user or hands
 * Pro to a lapsed/revoked one. These exercise the real exported functions against
 * hand-built license shapes — no Electron, no disk, no network. Time-relative cases
 * are computed from Date.now() so they stay correct regardless of when they run.
 *
 * The revoked/needs-activation code lists are imported from the source (single
 * source of truth) rather than re-hardcoded here.
 */
import { describe, it, expect } from 'vitest'
import { PRO_PURCHASE_URL } from '@offgrid/core/shared/product-links'
import {
  isProActive,
  toInfo,
  REVOKED_CODES,
  NEEDS_ACTIVATION,
  PRO_PAY_PAGE_URL,
  type ProLicense
} from '../license-service'

const HOUR = 3600_000

function lic(over: Partial<ProLicense> = {}): ProLicense {
  return { isPro: true, key: 'K', licenseId: 'L', expiry: null, verifiedAt: 123, ...over }
}

describe('isProActive', () => {
  it('grants Pro for a lifetime key (isPro, null expiry)', () => {
    expect(isProActive(lic({ expiry: null }))).toBe(true)
  })

  it('grants Pro for an active monthly key (expiry in the future)', () => {
    const future = new Date(Date.now() + 24 * HOUR).toISOString()
    expect(isProActive(lic({ expiry: future }))).toBe(true)
  })

  it('denies Pro for an expired monthly key (expiry in the past)', () => {
    const past = new Date(Date.now() - HOUR).toISOString()
    expect(isProActive(lic({ expiry: past }))).toBe(false)
  })

  it('denies Pro when the expiry is exactly now (<= boundary)', () => {
    // isProActive uses `<= Date.now()`, so an instant that has just passed is denied.
    const past = new Date(Date.now() - 1).toISOString()
    expect(isProActive(lic({ expiry: past }))).toBe(false)
  })

  it('denies Pro when isPro is false even with a future expiry', () => {
    const future = new Date(Date.now() + 24 * HOUR).toISOString()
    expect(isProActive(lic({ isPro: false, expiry: future }))).toBe(false)
  })

  it('denies Pro when isPro is false and expiry is null', () => {
    expect(isProActive(lic({ isPro: false, expiry: null }))).toBe(false)
  })

  it('denies Pro for the EMPTY-style license (no key, not pro)', () => {
    const empty: ProLicense = {
      isPro: false,
      key: null,
      licenseId: null,
      expiry: null,
      verifiedAt: 0
    }
    expect(isProActive(empty)).toBe(false)
  })

  it('denies Pro for a revoked license the service marks isPro=false but keeps expiry', () => {
    // Mirrors revalidatePro's REVOKED branch: isPro flipped false, stale future expiry left in place.
    const future = new Date(Date.now() + 30 * 24 * HOUR).toISOString()
    expect(isProActive(lic({ isPro: false, expiry: future }))).toBe(false)
  })

  it('denies Pro when the cached expiry is unparseable', () => {
    expect(isProActive(lic({ expiry: 'not-a-date' }))).toBe(false)
  })

  it('denies a claimed entitlement without a key and license id', () => {
    expect(isProActive(lic({ key: null }))).toBe(false)
    expect(isProActive(lic({ licenseId: null }))).toBe(false)
  })
})

describe('toInfo', () => {
  it('reports tier=lifetime for an active key with null expiry', () => {
    expect(toInfo(lic({ expiry: null }))).toEqual({
      isPro: true,
      tier: 'lifetime',
      expiry: null,
      verifiedAt: 123
    })
  })

  it('reports tier=monthly for an active key with a future expiry', () => {
    const future = new Date(Date.now() + 24 * HOUR).toISOString()
    expect(toInfo(lic({ expiry: future }))).toEqual({
      isPro: true,
      tier: 'monthly',
      expiry: future,
      verifiedAt: 123
    })
  })

  it('reports isPro=false and tier=null for an expired key (still echoes the expiry)', () => {
    const past = new Date(Date.now() - HOUR).toISOString()
    expect(toInfo(lic({ expiry: past }))).toEqual({
      isPro: false,
      tier: null,
      expiry: past,
      verifiedAt: 123
    })
  })

  it('reports isPro=false and tier=null when not entitled', () => {
    const info = toInfo(lic({ isPro: false }))
    expect(info.isPro).toBe(false)
    expect(info.tier).toBeNull()
  })

  it('carries verifiedAt through unchanged', () => {
    expect(toInfo(lic({ verifiedAt: 987654 })).verifiedAt).toBe(987654)
  })
})

describe('validation-code classifiers (single source of truth)', () => {
  it('REVOKED_CODES cover the lock-out states', () => {
    expect(REVOKED_CODES).toEqual(['EXPIRED', 'SUSPENDED', 'BANNED', 'OVERDUE', 'NOT_FOUND'])
  })

  it('NEEDS_ACTIVATION cover the reclaim-slot states', () => {
    expect(NEEDS_ACTIVATION).toEqual(['NO_MACHINE', 'NO_MACHINES', 'FINGERPRINT_SCOPE_MISMATCH'])
  })

  it('the two lists are disjoint — no code both revokes and reactivates', () => {
    const overlap = REVOKED_CODES.filter((c) => NEEDS_ACTIVATION.includes(c))
    expect(overlap).toEqual([])
  })
})

describe('purchase destination', () => {
  it('uses the canonical shared Pro purchase URL', () => {
    expect(PRO_PAY_PAGE_URL).toBe(PRO_PURCHASE_URL)
  })
})
