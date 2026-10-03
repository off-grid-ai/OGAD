import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startModelServer, stopModelServer } from '../model-server'
import { flushDiagnosticLog } from '../diagnostics-log'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-diagnostics-'))
const logPath = path.join(root, 'desktop.log')
const originalLogPath = process.env.OFFGRID_DIAGNOSTIC_LOG
let port = 0

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

async function fetchGateway(): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${port}/v1`)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

beforeAll(async () => {
  process.env.OFFGRID_DIAGNOSTIC_LOG = logPath
  port = await freePort()
  startModelServer(port)
})

afterAll(() => {
  stopModelServer()
  if (originalLogPath === undefined) delete process.env.OFFGRID_DIAGNOSTIC_LOG
  else process.env.OFFGRID_DIAGNOSTIC_LOG = originalLogPath
  fs.rmSync(root, { recursive: true, force: true })
})

describe('gateway diagnostic lifecycle', () => {
  it('persists correlated start and completion events without logging the request body', async () => {
    const response = await fetchGateway()
    expect(response.status).toBe(200)
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toBeTruthy()

    // The log is written off the main thread; wait for it to land before reading.
    await flushDiagnosticLog()
    const log = fs.readFileSync(logPath, 'utf8')
    expect(log).toContain(
      `INFO [gateway] request.started requestId=${JSON.stringify(requestId)} method="GET" path="/v1"`
    )
    expect(log).toContain(
      `INFO [gateway] request.completed requestId=${JSON.stringify(requestId)} method="GET" path="/v1" status=200`
    )
    expect(log).not.toContain('messages')
    expect(log).not.toContain('prompt')
  })
})
