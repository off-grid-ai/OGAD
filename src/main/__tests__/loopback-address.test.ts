import { describe, it, expect } from 'vitest'
import { isLoopbackAddress } from '../loopback-address'

describe('isLoopbackAddress', () => {
  it('accepts IPv4, IPv6, and IPv4-mapped loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejects LAN addresses and undefined (a remote device must authenticate)', () => {
    expect(isLoopbackAddress('192.168.1.42')).toBe(false)
    expect(isLoopbackAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.42')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})
