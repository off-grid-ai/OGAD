/**
 * Keygen JSON:API response parsers — the pure functions that turn Keygen's
 * validate-key / machine-activate / list-machines wire bodies into our internal
 * shapes. The fetch/transport layer is untested shell; these feed it real
 * JSON:API fixture objects (no network) and assert the mapping + the branch that
 * detects the device-cap (422 MACHINE_LIMIT_EXCEEDED).
 */
import { describe, it, expect } from 'vitest'
import {
  toLicense,
  parseValidateResult,
  parseActivateResult,
  parseMachines
} from '../keygen-client'

describe('toLicense', () => {
  it('maps a JSON:API license resource to our KeygenLicense', () => {
    const data = {
      id: 'lic-1',
      attributes: { expiry: '2030-01-01T00:00:00Z', metadata: { plan: 'monthly' }, name: 'Ada' }
    }
    expect(toLicense(data)).toEqual({
      id: 'lic-1',
      expiry: '2030-01-01T00:00:00Z',
      metadata: { plan: 'monthly' },
      name: 'Ada'
    })
  })

  it('defaults a lifetime (null-expiry) license and missing fields', () => {
    expect(toLicense({ id: 'lic-2' })).toEqual({
      id: 'lic-2',
      expiry: null,
      metadata: {},
      name: null
    })
  })

  it('returns null for missing data or a resource without an id', () => {
    expect(toLicense(undefined)).toBeNull()
    expect(toLicense(null)).toBeNull()
    expect(toLicense({ attributes: {} })).toBeNull()
  })
})

describe('parseValidateResult', () => {
  it('parses a VALID validate response (valid=true, license present)', () => {
    const body = {
      meta: { valid: true, code: 'VALID' },
      data: { id: 'lic-9', attributes: { expiry: null } }
    }
    const r = parseValidateResult(body)
    expect(r.valid).toBe(true)
    expect(r.code).toBe('VALID')
    expect(r.license?.id).toBe('lic-9')
    expect(r.license?.expiry).toBeNull()
  })

  it('parses an EXPIRED response (valid=false, code carried, license still present)', () => {
    const body = {
      meta: { valid: false, code: 'EXPIRED' },
      data: { id: 'lic-9', attributes: { expiry: '2020-01-01T00:00:00Z' } }
    }
    const r = parseValidateResult(body)
    expect(r.valid).toBe(false)
    expect(r.code).toBe('EXPIRED')
    expect(r.license?.expiry).toBe('2020-01-01T00:00:00Z')
  })

  it('parses a NO_MACHINE (needs-activation) response with a license to reclaim', () => {
    const body = {
      meta: { valid: false, code: 'NO_MACHINE' },
      data: { id: 'lic-3', attributes: {} }
    }
    const r = parseValidateResult(body)
    expect(r.code).toBe('NO_MACHINE')
    expect(r.license?.id).toBe('lic-3')
  })

  it('falls back to UNKNOWN code, valid=false, null license on a malformed/empty body', () => {
    expect(parseValidateResult({})).toEqual({ valid: false, code: 'UNKNOWN', license: null })
    expect(parseValidateResult(undefined)).toEqual({ valid: false, code: 'UNKNOWN', license: null })
  })
})

describe('parseActivateResult', () => {
  it('reports ok on a 201 Created', () => {
    expect(parseActivateResult(201, {})).toEqual({ ok: true, limitReached: false })
  })

  it('detects the device cap: 422 with an errors[].code containing LIMIT', () => {
    const body = { errors: [{ title: 'Unprocessable', code: 'MACHINE_LIMIT_EXCEEDED' }] }
    expect(parseActivateResult(422, body)).toEqual({ ok: false, limitReached: true })
  })

  it('detects the device cap: 422 with a "machine limit" detail (case-insensitive)', () => {
    const body = { errors: [{ detail: 'machine LIMIT has been exceeded for this license' }] }
    expect(parseActivateResult(422, body)).toEqual({ ok: false, limitReached: true })
  })

  it('a 422 that is NOT a limit error is a plain failure, not limitReached', () => {
    const body = { errors: [{ code: 'FINGERPRINT_TAKEN', detail: 'already taken' }] }
    expect(parseActivateResult(422, body)).toEqual({ ok: false, limitReached: false })
  })

  it('a non-201 non-422 (e.g. 403) is a plain failure', () => {
    expect(parseActivateResult(403, { errors: [{ code: 'FORBIDDEN' }] })).toEqual({
      ok: false,
      limitReached: false
    })
  })

  it('handles a 422 with no errors array without throwing', () => {
    expect(parseActivateResult(422, {})).toEqual({ ok: false, limitReached: false })
  })
})

describe('parseMachines', () => {
  it('maps a machines list, preferring lastHeartbeat for lastSeen', () => {
    const body = {
      data: [
        {
          id: 'm1',
          attributes: {
            fingerprint: 'fp-1',
            platform: 'macos',
            name: 'Ada MBP',
            lastHeartbeat: '2026-01-01T00:00:00Z',
            created: '2025-01-01T00:00:00Z'
          }
        }
      ]
    }
    // The raw machine, not a UI projection: the licensed-devices list does its own mapping, including
    // the heartbeat-then-created fallback for last seen (license-service.listLicensedDevicesForUi).
    expect(parseMachines(body)).toEqual([
      {
        id: 'm1',
        fingerprint: 'fp-1',
        hostname: null,
        platform: 'macos',
        name: 'Ada MBP',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: null,
        lastActiveAt: '2026-01-01T00:00:00Z'
      }
    ])
  })

  it('drops a machine with no fingerprint, because nothing can be matched to a device', () => {
    const body = { data: [{ id: 'm2', attributes: { created: '2025-06-01T00:00:00Z' } }] }
    expect(parseMachines(body)).toEqual([])
  })

  it('returns [] for an empty or malformed body', () => {
    expect(parseMachines({})).toEqual([])
    expect(parseMachines(undefined)).toEqual([])
    expect(parseMachines({ data: [] })).toEqual([])
  })
})
