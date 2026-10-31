/**
 * Pro-only gateway paths over real HTTP and the real key store. Without Pro the gateway refuses
 * Scribe's /v1/writing with 402 and says why; once Pro registers a route, that route answers instead.
 * The OS keychain (Electron safeStorage) is the only fake: it passes bytes through.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerGatewayRoute } from '../gateway-routes'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-pro-routes-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

let port = 0
let server: typeof import('../model-server')

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') return reject(new Error('no TCP port'))
      probe.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function post(pathname: string): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Their going home.' })
      })
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  server = await import('../model-server')
  port = await freePort()
  server.startModelServer(port)
})

afterAll(() => {
  server.stopModelServer()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})

describe('Scribe gateway paths', () => {
  it('refuses /v1/writing with 402 Pro required when Pro is absent', async () => {
    for (const pathname of ['/v1/writing', '/v1/writing/grammar', '/v1/writing/rewrite']) {
      const response = await post(pathname)
      expect(response.status).toBe(402)
      expect(await response.json()).toEqual({
        error: { message: 'Scribe needs Off Grid AI Pro.', type: 'pro_required' }
      })
    }
  })

  it('leaves paths that only share the prefix alone', async () => {
    expect((await post('/v1/writings')).status).not.toBe(402)
  })

  it("lets Pro's registered route answer instead", async () => {
    const unregister = registerGatewayRoute(({ url, json }) => {
      if (url !== '/v1/writing/grammar') return false
      json(200, { issues: [] })
      return true
    })
    try {
      const response = await post('/v1/writing/grammar')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ issues: [] })
      // Paths Pro did not claim still refuse.
      expect((await post('/v1/writing/tone')).status).toBe(402)
    } finally {
      unregister()
    }
  })
})
