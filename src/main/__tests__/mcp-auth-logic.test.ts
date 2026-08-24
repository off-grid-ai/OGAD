import { describe, expect, it } from 'vitest'
import { authorizeBearer, authorizeBearerAny } from '../mcp-auth-logic'

const TOKEN = 'a'.repeat(64)

describe('authorizeBearer', () => {
  it('accepts the exact Bearer token (case-insensitive scheme)', () => {
    expect(authorizeBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(authorizeBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(authorizeBearer(`  Bearer   ${TOKEN}  `, TOKEN)).toBe(true)
  })

  it('rejects a wrong, missing, or malformed token (fail closed)', () => {
    expect(authorizeBearer(`Bearer ${'b'.repeat(64)}`, TOKEN)).toBe(false) // wrong value
    expect(authorizeBearer(`Bearer ${TOKEN}x`, TOKEN)).toBe(false) // wrong length
    expect(authorizeBearer(undefined, TOKEN)).toBe(false) // no header
    expect(authorizeBearer(TOKEN, TOKEN)).toBe(false) // missing "Bearer " scheme
    expect(authorizeBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false) // wrong scheme
  })

  it('never authorizes against a blank / too-short configured token', () => {
    expect(authorizeBearer('Bearer ', '')).toBe(false)
    expect(authorizeBearer('Bearer short', 'short')).toBe(false)
  })
})

describe('authorizeBearerAny (per-device: match ANY live token)', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('authorizes a bearer that matches any token in the live set', () => {
    expect(authorizeBearerAny(`Bearer ${A}`, [A, B])).toBe(true)
    expect(authorizeBearerAny(`Bearer ${B}`, [A, B])).toBe(true)
  })

  it('rejects a bearer that matches NONE of the live tokens', () => {
    expect(authorizeBearerAny(`Bearer ${'c'.repeat(64)}`, [A, B])).toBe(false)
  })

  it('fails closed on an empty set - THIS is the un-paired case', () => {
    // When a device is un-paired its token leaves the live set; with nothing left it can never
    // authorize. An empty set is exactly what a Mac with no tools-allowed peers reports.
    expect(authorizeBearerAny(`Bearer ${A}`, [])).toBe(false)
  })

  it('still rejects a missing / malformed bearer even with tokens present', () => {
    expect(authorizeBearerAny(undefined, [A, B])).toBe(false)
    expect(authorizeBearerAny(A, [A, B])).toBe(false) // no "Bearer " scheme
  })
})
