import { describe, expect, it } from 'vitest'
import type os from 'os'
import { lanAddresses, primaryLanAddress } from '../lan-address'

// Minimal fake of os.networkInterfaces() output.
function ip(address: string, opts: Partial<os.NetworkInterfaceInfo> = {}): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
    ...opts
  } as os.NetworkInterfaceInfo
}

describe('lanAddresses', () => {
  it('keeps only external IPv4 and orders private ranges first (192.168 > 10 > 172.16-31 > other)', () => {
    const ifaces = {
      lo0: [ip('127.0.0.1', { internal: true })],
      en5: [ip('169.254.27.81')], // link-local - dropped
      en0: [ip('192.168.1.18'), ip('fe80::1', { family: 'IPv6' } as any)],
      en1: [ip('10.0.0.4')],
      utun0: [ip('172.16.0.2')],
      eth9: [ip('203.0.113.7')] // routable - last
    }
    expect(lanAddresses(ifaces)).toEqual(['192.168.1.18', '10.0.0.4', '172.16.0.2', '203.0.113.7'])
  })

  it('returns [] when there is no usable address', () => {
    expect(lanAddresses({ lo0: [ip('127.0.0.1', { internal: true })] })).toEqual([])
    expect(lanAddresses({})).toEqual([])
  })
})

describe('primaryLanAddress', () => {
  it('returns the best candidate, or null when none', () => {
    expect(primaryLanAddress({ en0: [ip('10.0.0.4')], en1: [ip('192.168.0.9')] })).toBe('192.168.0.9')
    expect(primaryLanAddress({ lo0: [ip('127.0.0.1', { internal: true })] })).toBeNull()
  })
})
