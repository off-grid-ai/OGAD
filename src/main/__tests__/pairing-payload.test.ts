import { describe, expect, it } from 'vitest'
import {
  MCP_PAIR_TYPE,
  MCP_PAIR_VERSION,
  buildPairingPayload,
  encodePairingPayload
} from '../pairing-payload'

describe('buildPairingPayload', () => {
  it('builds the /mcp url from ip+port and carries the token + type/version', () => {
    const p = buildPairingPayload({
      lanIp: '192.168.1.18',
      port: 7878,
      token: 'abc123',
      name: "Sidd's Mac"
    })
    expect(p).toEqual({
      t: MCP_PAIR_TYPE,
      v: MCP_PAIR_VERSION,
      url: 'http://192.168.1.18:7878/mcp',
      token: 'abc123',
      name: "Sidd's Mac"
    })
  })

  it('omits name when not provided', () => {
    const p = buildPairingPayload({ lanIp: '10.0.0.4', port: 8000, token: 't' })
    expect(p.name).toBeUndefined()
    expect(p.url).toBe('http://10.0.0.4:8000/mcp')
  })
})

describe('encodePairingPayload', () => {
  it('round-trips through JSON with the discriminator intact', () => {
    const p = buildPairingPayload({ lanIp: '192.168.1.18', port: 7878, token: 'tok' })
    const decoded = JSON.parse(encodePairingPayload(p))
    expect(decoded.t).toBe('offgrid-mcp-pair')
    expect(decoded.v).toBe(1)
    expect(decoded.url).toBe('http://192.168.1.18:7878/mcp')
    expect(decoded.token).toBe('tok')
  })
})
