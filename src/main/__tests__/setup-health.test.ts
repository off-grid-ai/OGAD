import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'

// The engines are device boundaries; the aggregation over them is what this test owns.
const engine = vi.hoisted(() => ({
  ready: false,
  starting: false,
  modelsExist: true,
  lastError: null as string | null,
  port: 1,
  route: null as null | { source: 'local' | 'remote'; name: string },
  gatewayPort: 1,
  image: { available: false, reason: 'No image model installed' } as {
    available: boolean
    reason?: string
  }
}))
vi.mock('../llm', () => ({
  llm: {
    modelsExist: () => engine.modelsExist,
    getPort: () => engine.port,
    isReady: () => engine.ready,
    isStarting: () => engine.starting,
    lastError: () => engine.lastError
  }
}))
vi.mock('../models-manager', () => ({
  getActiveModel: () => 'qwen-small',
  downloadModel: vi.fn(),
  listInstalled: () => [],
  setActiveModel: vi.fn(),
  setActiveModalChoice: vi.fn()
}))
vi.mock('../model-server', () => ({ getGatewayPort: () => engine.gatewayPort }))
vi.mock('../native-helper-health', () => ({
  getNativeHelperHealth: () => [{ id: 'helper', label: 'Native helper', status: 'ready' }]
}))
vi.mock('../imagegen', () => ({ imageGenStatus: () => engine.image }))

import { getChatHealth, getSystemHealth } from '../setup'

const healthDependencies = { activeRoute: () => engine.route }

let server: http.Server
let servedGateway: unknown = {
  modalities: { vision_understanding: 'ready', embeddings: 'not_installed' }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(servedGateway))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  engine.gatewayPort = (server.address() as AddressInfo).port
  engine.port = engine.gatewayPort
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('system health snapshot', () => {
  it('reads a healthy engine only when the socket answers AND the engine owns it', async () => {
    engine.ready = false
    engine.starting = true
    const loading = await getChatHealth(healthDependencies)
    expect(loading).toMatchObject({
      id: 'chat',
      status: 'starting',
      port: engine.port,
      canRestart: true
    })

    engine.ready = true
    engine.starting = false
    const ready = await getChatHealth(healthDependencies)
    expect(ready.status).toBe('ready')
  })

  it('reports a remote chat route as ready rather than as a stopped local engine', async () => {
    engine.ready = false
    engine.route = { source: 'remote', name: 'Mac mini' }
    const health = await getChatHealth(healthDependencies)
    expect(health.status).toBe('ready')
    expect(health.detail).toContain('Mac mini')
    engine.route = null
  })

  it('aggregates gateway modalities, in-process image status, and native helpers into one record', async () => {
    engine.ready = true
    const health = await getSystemHealth(healthDependencies)
    expect(health.activeModel).toBe('qwen-small')
    expect(health.ramGb).toBeGreaterThan(0)
    const byId = Object.fromEntries(health.components.map((c) => [c.id, c]))
    expect(byId.gateway).toMatchObject({
      status: 'ready',
      detail: 'OpenAI-compatible API',
      canRestart: true
    })
    expect(byId.vision?.status).toBe('ready')
    expect(byId.embeddings?.status).toBe('not_installed')
    expect(byId.transcription?.status).toBe('down')
    expect(byId.image).toMatchObject({
      status: 'not_installed',
      detail: 'No image model installed'
    })
    expect(byId.helper?.status).toBe('ready')

    engine.image = { available: true }
    servedGateway = { modalities: { speech: 'ready' } }
    const next = await getSystemHealth(healthDependencies)
    const nextById = Object.fromEntries(next.components.map((c) => [c.id, c]))
    expect(nextById.image).toMatchObject({ status: 'ready' })
    expect(nextById.speech?.status).toBe('ready')
    expect(nextById.vision?.status).toBe('down')
  })

  it('marks the gateway and every gateway-owned modality down when nothing answers', async () => {
    const closed = engine.gatewayPort
    engine.gatewayPort = 1
    const health = await getSystemHealth(healthDependencies)
    const byId = Object.fromEntries(health.components.map((c) => [c.id, c]))
    expect(byId.gateway).toMatchObject({ status: 'down', detail: 'Not responding' })
    expect(byId.speech?.status).toBe('down')
    engine.gatewayPort = closed
  })
})
