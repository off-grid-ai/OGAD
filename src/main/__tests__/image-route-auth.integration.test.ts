// The gateway's image routes against the REAL server: opportunistic auth
// (no credentials = today's open posture; presented credentials are verified
// against the live per-device tokens), and the unavailable-runtime 501.
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startModelServer, stopModelServer } from '../model-server'
import { registerActiveActionTokens } from '../mcp-auth'

let port = 0
const DEVICE_TOKEN = 'f'.repeat(64)

async function freeLoopbackPort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const found = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()))
  })
  return found
}

const postImage = (headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(port)}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ prompt: 'a lighthouse' })
  })

beforeAll(async () => {
  port = await freeLoopbackPort()
  registerActiveActionTokens(() => [DEVICE_TOKEN])
  startModelServer(port)
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/health`)
      break
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
})

afterAll(async () => {
  registerActiveActionTokens(null)
  await stopModelServer()
})

describe('gateway image routes', () => {
  it('without credentials keeps the open posture (reaches the 501, not a 401)', async () => {
    const res = await postImage()
    expect(res.status).toBe(501) // no image runtime in the test environment
  })

  it('a valid per-device token is accepted (past auth, same 501)', async () => {
    const res = await postImage({ authorization: `Bearer ${DEVICE_TOKEN}` })
    expect(res.status).toBe(501)
  })

  it('an invalid presented credential is a hard 401, before any work', async () => {
    const res = await postImage({ authorization: `Bearer ${'0'.repeat(64)}` })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('unauthorized')
  })

  it('guards the unified /v1/images route the same way', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/images`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token-of-decent-length'
      },
      body: JSON.stringify({ prompt: 'x' })
    })
    expect(res.status).toBe(401)
  })
})
