// @vitest-environment node
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getGatewayPort, startModelServer, stopModelServer } from '../model-server'
import { freeGatewayPort } from './harness/gateway-port'

vi.mock('electron', () =>
  import('./harness/electron-app-boundary').then((m) => m.electronAppBoundary())
)

async function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return (server.address() as AddressInfo).port
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

function jsonServer(value: object): http.Server {
  return http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(value))
  })
}

afterEach(() => stopModelServer())

describe('model gateway live-port composition', () => {
  it('moves off an occupied preferred port and serves from the live bound port', async () => {
    const blocker = net.createServer()
    // Occupy the exact interface used by the gateway. Port selection must probe the same bind
    // contract as the listener, not infer availability from a different interface.
    const preferredPort = await listen(blocker, '0.0.0.0')
    try {
      await startModelServer(preferredPort)

      const livePort = getGatewayPort()
      expect(livePort).not.toBe(preferredPort)
      const response = await fetch(`http://127.0.0.1:${livePort}/v1`)
      expect(await response.json()).toMatchObject({
        message: 'Off Grid AI local gateway. OpenAI-compatible API.'
      })
    } finally {
      await close(blocker)
    }
  })

  it('resolves the upstream port for every request instead of retaining a stale port', async () => {
    const first = jsonServer({ owner: 'first' })
    const second = jsonServer({ owner: 'second' })
    const firstPort = await listen(first)
    const secondPort = await listen(second)
    const gatewayPort = await freeGatewayPort()
    let liveUpstreamPort = firstPort
    try {
      await startModelServer(gatewayPort, { upstreamPort: () => liveUpstreamPort })
      const gateway = getGatewayPort()

      expect(await (await fetch(`http://127.0.0.1:${gateway}/completion`)).json()).toEqual({
        owner: 'first'
      })
      liveUpstreamPort = secondPort
      expect(await (await fetch(`http://127.0.0.1:${gateway}/completion`)).json()).toEqual({
        owner: 'second'
      })
    } finally {
      await close(first)
      await close(second)
    }
  })
})
