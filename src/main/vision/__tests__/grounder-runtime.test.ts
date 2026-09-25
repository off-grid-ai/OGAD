import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  artifact: vi.fn(),
  exists: vi.fn(),
  pickPort: vi.fn(),
  reap: vi.fn(),
  spawn: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ default: { existsSync: mocks.exists } }))
vi.mock('../../llm/settings-math', () => ({ buildLaunchArgs: vi.fn(() => ['--ground']) }))
vi.mock('../../llm/spawn-env', () => ({ engineSpawnEnv: vi.fn(() => ({ TEST_ENGINE: '1' })) }))
vi.mock('../../runtime-env', () => ({ binRoots: () => ['/bundle'], exe: (name: string) => name }))
vi.mock('../../free-port', () => ({ isPortFree: vi.fn(), pickFreePort: mocks.pickPort }))
vi.mock('../../kill-orphan-port', () => ({ reapOrphanProcessesOnPort: mocks.reap }))
vi.mock('../../models-manager', () => ({ resolveComputerUseModelArtifact: mocks.artifact }))

import { GrounderRuntime } from '../grounder-runtime'

class FakeProcess extends EventEmitter {
  exitCode: number | null = null
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
  mocks.artifact.mockResolvedValue({
    primaryPath: '/models/grounder.gguf',
    projectorPath: '/models/mmproj.gguf'
  })
  mocks.exists.mockReturnValue(true)
  mocks.pickPort.mockResolvedValue(8490)
  mocks.spawn.mockImplementation(() => new FakeProcess())
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true }))
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('GrounderRuntime', () => {
  it('starts one dedicated server, reuses it, and returns an OpenAI-compatible connection', async () => {
    const runtime = new GrounderRuntime()
    await expect(runtime.connection('offgrid/grounder')).resolves.toEqual({
      id: 'local-grounder:offgrid/grounder',
      name: 'Local grounding specialist',
      provider: 'custom',
      endpoint: 'http://127.0.0.1:8490/v1',
      model: 'offgrid/grounder',
      apiKey: ''
    })
    expect(runtime.running).toBe(true)
    expect(mocks.reap).toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/bundle/llama/llama-server',
      ['--ground'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    )

    await runtime.connection('offgrid/grounder')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    const child = mocks.spawn.mock.results[0]?.value as FakeProcess
    await runtime.shutdown()
    expect(child.killed).toEqual(['SIGTERM'])
    expect(runtime.running).toBe(false)
  })

  it('rejects missing models, exhausted ports, and missing engines', async () => {
    const runtime = new GrounderRuntime()
    mocks.artifact.mockResolvedValueOnce(null)
    await expect(runtime.connection('missing')).rejects.toThrow('not installed')

    mocks.pickPort.mockResolvedValueOnce(null)
    await expect(runtime.connection('no-port')).rejects.toThrow('No private port')

    mocks.exists.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false)
    await expect(runtime.connection('no-engine')).rejects.toThrow('engine is missing')
  })

  it('adds memory guidance when the server exits during startup', async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeProcess()
      queueMicrotask(() => {
        child.stderr.emit('data', 'Metal allocation failed: out of memory')
        child.exitCode = 1
        child.emit('close', 1)
      })
      return child
    })
    vi.mocked(fetch).mockRejectedValue(new Error('not ready'))

    await expect(new GrounderRuntime().connection('offgrid/grounder')).rejects.toThrow(
      'does not have enough free memory'
    )
  })
})
