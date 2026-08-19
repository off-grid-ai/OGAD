import { describe, expect, it } from 'vitest'
import { authorizeBearer } from '../mcp-auth-logic'

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
