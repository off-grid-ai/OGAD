import net from 'node:net'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { getGatewayPort, startModelServer, stopModelServer } from '../model-server'
import { reserveGatewayPort } from './harness/gateway-port'

vi.mock('electron', () =>
  import('./harness/electron-app-boundary').then((m) => m.electronAppBoundary())
)

let gatewayPort = 0

function nonLoopbackIpv4Address(): string | undefined {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === 'IPv4' && !address.internal)?.address
}

async function waitForLoopbackGateway(): Promise<Response> {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${String(gatewayPort)}/v1`)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

function acceptsTcpConnection(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: gatewayPort })
    const finish = (accepted: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(accepted)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

beforeAll(async () => {
  // Hold the port on the gateway's own bind host, release it only at the moment we hand it over,
  // then read back the port the gateway ACTUALLY bound - it may have scanned past a live sibling.
  const reservation = await reserveGatewayPort()
  await reservation.release()
  await startModelServer(reservation.port)
  gatewayPort = getGatewayPort()
})

afterAll(() => {
  stopModelServer()
})

describe('model gateway network boundary', () => {
  it('serves the production gateway over IPv4 loopback', async () => {
    const response = await waitForLoopbackGateway()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      message: 'Off Grid AI local gateway. OpenAI-compatible API.'
    })
  })

  // The phone finds this Mac by scanning the subnet for :7878, so a loopback-only
  // listener is invisible to it however healthy the gateway is. Binding every
  // interface is the feature, and this asserts it stays that way.
  const lanAddress = nonLoopbackIpv4Address()
  it.skipIf(!lanAddress)('listens on the LAN so a paired phone can reach it', async () => {
    expect(await acceptsTcpConnection(lanAddress!)).toBe(true)
  })

  // Reachable does not mean writable: the gateway does not authenticate, so the routes
  // that change this machine's state check the peer address rather than trusting the bind.
  it.skipIf(!lanAddress)('still refuses settings mutations from off-machine', async () => {
    const response = await fetch(`http://${lanAddress!}:${String(gatewayPort)}/v1/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })

    expect(response.status).toBe(403)
  })
})
