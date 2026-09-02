// @vitest-environment node
// llm.ts and model-server.ts are coverage-excluded native/spawn/IPC shells; the selection logic is
// behaviorally tested in free-port.test.ts. These source guards lock the WIRING so it can't silently
// regress: (1) a port conflict falls back to a free port instead of throwing; (2) the gateway proxies
// to the LIVE engine port, never a fixed constant.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('llm.ts — port conflict falls back to a free port', () => {
  const src = read('llm.ts')

  it('scans for a free port with pickFreePort when another app owns the preferred one', () => {
    expect(src).toMatch(/pickFreePort\(this\.port/)
    // The chosen free port becomes the live port.
    expect(src).toMatch(/this\.port = free/)
  })

  it('only surfaces the hard conflict when NO free port is found (not on first collision)', () => {
    // The throw is gated behind `free === null`, not fired unconditionally on liveOwners.
    expect(src).toMatch(/if \(free === null\)[\s\S]*?throw new Error/)
  })

  it('falls back on ANY occupancy (isPortFree), not only a recognized live llama owner', () => {
    // The decision keys on whether the port is free — so a NON-llama blocker (LM Studio, any app)
    // triggers the fallback too, instead of dead-ending on bind. Guards against regressing to the
    // old `liveOwners.length > 0` gate, which only caught recognized llama-server holders.
    expect(src).toMatch(/if \(await isPortFree\(this\.port\)\)\s*{\s*return/)
    expect(src).not.toMatch(/if \(ownership\.liveOwners\.length > 0\)/)
  })

  it('exposes the live port via getPort()', () => {
    expect(src).toMatch(/getPort\(\): number\s*{\s*return this\.port/)
  })
})

describe('model-server.ts — gateway proxies to the LIVE engine port', () => {
  const src = read('model-server.ts')

  it('reads llm.getPort() for the upstream, not a fixed constant', () => {
    expect(src).toMatch(/upstreamPortResolver = \(\): number => llm\.getPort\(\)/)
    expect(src).toMatch(/upstreamPort = \(\): number => upstreamPortResolver\(\)/)
    expect(src).toMatch(/options\.upstreamPort \?\? \(\(\) => llm\.getPort\(\)\)/)
    // No lingering fixed-constant upstream.
    expect(src).not.toMatch(/const UPSTREAM_PORT = LLAMA_SERVER_PORT/)
  })

  it('every upstream request targets upstreamPort(), never a stale UPSTREAM_PORT', () => {
    expect(src).not.toMatch(/\bUPSTREAM_PORT\b/)
    expect(src).toMatch(/port: upstreamPort\(\)/)
  })
})

describe('model-server.ts — the gateway itself falls back off a held port', () => {
  const src = read('model-server.ts')

  it('scans for a free gateway port with pickFreePort before listening', () => {
    expect(src).toMatch(/boundGatewayPort = \(await pickFreePort\(port\)\)/)
    // It binds the LIVE chosen port, not the fixed GATEWAY_PORT constant.
    expect(src).toMatch(/\.listen\(boundGatewayPort/)
  })

  it('exposes the live gateway port via getGatewayPort()', () => {
    expect(src).toMatch(/getGatewayPort\(\): number\s*{\s*return boundGatewayPort/)
  })

  it('startup resolves only after bind and rejects (clearing state) on a bind error', () => {
    // A bind failure must reject and drop the dead server, not resolve a false success that leaves
    // `server` set forever. Guard the await-the-listen shape: reject on error, null the server.
    expect(src).toMatch(/await new Promise<void>\(\(resolve, reject\)/)
    expect(src).toMatch(/once\('listening'/)
    expect(src).toMatch(/catch[\s\S]*?server = null[\s\S]*?throw e/)
  })

  it('self-report routes advertise the LIVE bound port, never the preferred param', () => {
    // After a fallback, /, /health, /openapi.json, /docs, /v1 must point clients at the port the
    // gateway actually bound (boundGatewayPort), not the stale preferred `port` it may have moved off.
    expect(src).toMatch(/base_url: `http:\/\/\$\{GATEWAY_HOST\}:\$\{boundGatewayPort\}\/v1`/)
    expect(src).toMatch(/openApiSpec\(boundGatewayPort/)
    expect(src).toMatch(/docsHtml\(boundGatewayPort\)/)
    expect(src).toMatch(/docsText\(boundGatewayPort\)/)
    // No self-description route interpolates the bare preferred `port` param anymore.
    expect(src).not.toMatch(/\$\{GATEWAY_HOST\}:\$\{port\}/)
  })
})

describe('setup.ts — health pings read the LIVE ports, never fixed constants', () => {
  const src = read('setup.ts')

  it('pings the live llama engine port via llm.getPort()', () => {
    expect(src).toMatch(/pingJson\(llm\.getPort\(\)\)/)
  })

  it('pings the live gateway port via getGatewayPort(), not a GATEWAY_PORT constant', () => {
    expect(src).toMatch(/pingJson\(getGatewayPort\(\)\)/)
    // Guard the actual regression this describes: setup must not reach for the fixed gateway-port
    // constant again (it reads the live getGatewayPort()); LLAMA_PORT was never the concern here.
    expect(src).not.toMatch(/\bGATEWAY_PORT\b/)
  })
})
