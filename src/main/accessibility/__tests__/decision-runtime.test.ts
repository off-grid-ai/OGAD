import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  artifact: vi.fn(),
  kevArtifact: vi.fn(),
  parse: vi.fn(),
  pickPort: vi.fn(),
  post: vi.fn(),
  reap: vi.fn(),
  spawn: vi.fn(),
  exists: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../../llm/gpu-device-probe', () => ({ gpuDeviceAvailable: vi.fn(async () => true) }))
vi.mock('node:fs', () => ({ default: { existsSync: mocks.exists } }))
vi.mock('../../llm', () => ({
  buildDecisionPrompt: vi.fn(() => 'decision prompt'),
  buildDecisionRequest: vi.fn(() => ({ prompt: 'request' })),
  parseOptionDecision: mocks.parse
}))
vi.mock('../../llm/http-post', () => ({ postCompletionOnce: mocks.post }))
vi.mock('../../llm/settings-math', () => ({ buildLaunchArgs: vi.fn(() => ['--serve']) }))
vi.mock('../../llm/spawn-env', () => ({ engineSpawnEnv: vi.fn(() => ({ TEST_ENGINE: '1' })) }))
vi.mock('../../runtime-env', () => ({ binRoots: () => ['/bundle'], exe: (name: string) => name }))
vi.mock('../../free-port', () => ({ isPortFree: vi.fn(), pickFreePort: mocks.pickPort }))
vi.mock('../../kill-orphan-port', () => ({ reapOrphanProcessesOnPort: mocks.reap }))
vi.mock('../../models-manager', () => ({
  KEV_4B_ID: 'offgrid/kev-4b',
  resolveComputerUseModelArtifact: mocks.artifact,
  resolveKevRuntimeArtifact: mocks.kevArtifact
}))

import { DecisionRuntime, DecisionRuntimeError } from '../decision-runtime'

class FakeProcess extends EventEmitter {
  exitCode: number | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals): boolean {
    this.killed.push(signal)
    this.exitCode = 0
    this.emit('close', 0)
    return true
  }
}

beforeEach(() => {
  mocks.artifact.mockResolvedValue({ primaryPath: '/models/decision.gguf' })
  mocks.kevArtifact.mockReturnValue({
    checkpoint: '/models/kev',
    base: '/models/base',
    python: '/runtime/python',
    script: '/runtime/server.py'
  })
  mocks.exists.mockImplementation((candidate: string) => !candidate.includes('llama-cuda'))
  mocks.pickPort.mockResolvedValue(8460)
  mocks.parse.mockReturnValue({ choice: 1, confidence: 0.8, probabilities: [0.2, 0.8] })
  mocks.post.mockResolvedValue('{"choice":"B"}')
  mocks.spawn.mockImplementation(() => new FakeProcess())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('DecisionRuntime', () => {
  it('starts, reuses, decides with, checks, and stops a local decision server', async () => {
    const runtime = new DecisionRuntime()
    await runtime.start('offgrid/decider')

    expect(runtime.running).toBe(true)
    expect(runtime.activeModelId).toBe('offgrid/decider')
    expect(runtime.activePort).toBe(8460)
    expect(mocks.reap).toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/bundle/llama/llama-server',
      ['--serve'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    )

    await runtime.start('offgrid/decider')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    await expect(runtime.decide('state', 'next?', ['A', 'B'])).resolves.toEqual({
      choice: 1,
      confidence: 0.8,
      probabilities: [0.2, 0.8]
    })
    await expect(runtime.health()).resolves.toBe(true)

    const child = mocks.spawn.mock.results[0]?.value as FakeProcess
    await runtime.shutdown()
    expect(child.killed).toEqual(['SIGTERM'])
    expect(runtime.running).toBe(false)
    expect(runtime.activeModelId).toBeNull()
    await expect(runtime.health()).resolves.toBe(false)
    await expect(runtime.decide('state', 'next?', ['A'])).rejects.toMatchObject({
      code: 'startup'
    })
  })

  it('reports missing models, exhausted ports, and missing engines', async () => {
    const runtime = new DecisionRuntime()
    mocks.artifact.mockResolvedValueOnce(null)
    await expect(runtime.start('missing')).rejects.toEqual(
      expect.objectContaining<Partial<DecisionRuntimeError>>({ code: 'missing' })
    )

    mocks.pickPort.mockResolvedValueOnce(null)
    await expect(runtime.start('no-port')).rejects.toThrow('No private port')

    mocks.exists.mockReturnValue(false)
    await expect(runtime.start('no-engine')).rejects.toThrow('engine is missing')
  })

  it('uses the Kev choice endpoint and normalizes its distribution', async () => {
    const runtime = new DecisionRuntime()
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            decision: {
              choice: 'option_1',
              probabilities: { option_0: 2, option_1: 6, option_2: 2 }
            }
          }
        })
      } as Response)

    await runtime.start('offgrid/kev-4b')
    await expect(runtime.decide('screen', 'next?', ['A', 'B', 'C'])).resolves.toEqual({
      choice: 1,
      confidence: 0.6,
      probabilities: [0.2, 0.6, 0.2]
    })
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/runtime/python',
      ['/runtime/server.py', '--run', '/models/kev', '--port', '8460'],
      expect.objectContaining({ cwd: '/models/kev' })
    )
    await runtime.shutdown()
  })

  it('rejects invalid Kev responses and classifies startup memory failures', async () => {
    const runtime = new DecisionRuntime()
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ answers: { decision: { choice: 'unknown', probabilities: {} } } })
      } as Response)
    await runtime.start('offgrid/kev-4b')
    await expect(runtime.decide('screen', 'next?', ['A'])).rejects.toThrow(
      'invalid Decision response'
    )
    await runtime.shutdown()

    const failing = new DecisionRuntime()
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeProcess()
      queueMicrotask(() => {
        child.stderr.emit('data', 'CUDA out of memory')
        child.exitCode = 1
        child.emit('close', 1)
      })
      return child
    })
    vi.mocked(fetch).mockRejectedValue(new Error('not ready'))
    await expect(failing.start('offgrid/decider')).rejects.toMatchObject({ code: 'out_of_memory' })
  })
})
