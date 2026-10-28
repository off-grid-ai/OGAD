// @vitest-environment node
import { describe, it, expect } from 'vitest'
import net from 'node:net'
import { portCandidates, isPortFree, isPortFreeOnAll, pickFreePort } from '../free-port'

describe('portCandidates — gradual +1 increments', () => {
  it('starts at the preferred port and steps up by 1', () => {
    expect(portCandidates(7878, 3)).toEqual([7878, 7879, 7880])
  })
  it('clamps at the top of the TCP range', () => {
    expect(portCandidates(65534, 10)).toEqual([65534, 65535])
  })
  it('always yields at least the preferred port', () => {
    expect(portCandidates(8439, 0)).toEqual([8439])
  })
})

describe('pickFreePort — first free at/after preferred (fake probe)', () => {
  it('returns the preferred port when it is free', async () => {
    expect(await pickFreePort(8439, async () => true)).toBe(8439)
  })
  it('increments past busy ports to the first free one', async () => {
    const busy = new Set([8439, 8440])
    const tried: number[] = []
    const got = await pickFreePort(8439, async (p) => {
      tried.push(p)
      return !busy.has(p)
    })
    expect(got).toBe(8441)
    expect(tried).toEqual([8439, 8440, 8441]) // scanned upward in single steps
  })
  it('returns null when the whole window is busy', async () => {
    expect(await pickFreePort(7878, async () => false, 5)).toBeNull()
  })
})

describe('isPortFree — real socket probe', () => {
  it('reports a port occupied by a real listener as NOT free, and a free one as free', async () => {
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const taken = (srv.address() as net.AddressInfo).port
    try {
      expect(await isPortFree(taken)).toBe(false)
      // The next port up is almost certainly free on a test host; scan a small window to be safe.
      const free = await pickFreePort(taken + 1, (p) => isPortFree(p), 50)
      expect(free).not.toBeNull()
      expect(await isPortFree(free as number)).toBe(true)
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })

  it('starting AT a genuinely occupied port, moves to a different free port (any occupant)', async () => {
    // This is the behaviour prepareModelPort relies on after the fix: when the preferred port is
    // held by ANYTHING (not just a recognized llama-server), scanning from that port returns a
    // different, free port rather than dead-ending on the occupied one. The listener here is a plain
    // socket — exactly the NON-llama blocker the old liveOwners-only gate missed.
    const srv = net.createServer()
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const taken = (srv.address() as net.AddressInfo).port
    try {
      const chosen = await pickFreePort(taken, (p) => isPortFree(p), 50)
      expect(chosen).not.toBeNull()
      expect(chosen).not.toBe(taken)
      expect(await isPortFree(chosen as number)).toBe(true)
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })
})

describe('isPortFreeOnAll — a gateway on every interface never takes a port held on loopback', () => {
  it('counts a port held on 127.0.0.1 as taken, though 0.0.0.0 could still bind it', async () => {
    const loopbackOnly = net.createServer()
    await new Promise<void>((r) => loopbackOnly.listen(0, '127.0.0.1', r))
    const held = (loopbackOnly.address() as net.AddressInfo).port
    try {
      expect(await isPortFreeOnAll(held, ['0.0.0.0', '127.0.0.1'])).toBe(false)
      const picked = await pickFreePort(held, (p) => isPortFreeOnAll(p, ['0.0.0.0', '127.0.0.1']))
      expect(picked).not.toBe(held)
      expect(picked).not.toBeNull()
    } finally {
      await new Promise<void>((r) => loopbackOnly.close(() => r()))
    }
  })
})
