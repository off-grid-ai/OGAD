import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, findBinariesMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  findBinariesMock: vi.fn(() => ['/bin/sd-cuda/sd-server', '/bin/sd/sd-server'])
}))
vi.mock('child_process', () => ({ spawn: spawnMock, execSync: vi.fn() }))
vi.mock('fs', () => ({ default: { existsSync: () => true } }))
vi.mock('../runtime-env', () => ({ isPackaged: () => false }))
vi.mock('../backend-preferences', () => ({ getBackendPreference: () => 'auto' }))
vi.mock('../kill-orphan-port', () => ({ killOrphansOnPort: vi.fn() }))
vi.mock('../imagegen/sd-runtime', () => ({
  findSdBinaries: findBinariesMock,
  sdRuntimeLibraryEnv: () => ({})
}))
vi.mock('../runtime-backends', () => ({
  beginRuntimeBackend: () => ({ observe: vi.fn(), stop: vi.fn(), fail: vi.fn(), ready: vi.fn() })
}))
import { sdServer } from '../sd-server'

function processStub(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
  proc.kill.mockImplementation(() => proc.emit('close', 1))
  return proc
}

describe('resident image runtime fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    findBinariesMock.mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    sdServer.stop()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('starts Vulkan when CUDA cannot load and reports the selected binary', async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = processStub()
      queueMicrotask(() => proc.emit('error', new Error('CUDA driver missing')))
      return proc
    }).mockImplementation(() => processStub())
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (spawnMock.mock.calls.length < 2) throw new Error('not ready')
      return { ok: true }
    }))

    const starting = sdServer.ensureUp({ modelPath: '/model.gguf' })
    await vi.advanceTimersByTimeAsync(1000)
    await starting
    expect(spawnMock.mock.calls.map(([binary]) => binary)).toEqual([
      '/bin/sd-cuda/sd-server', '/bin/sd/sd-server'
    ])
    expect(sdServer.getBinaryPath()).toBe('/bin/sd/sd-server')
  })

  it('does not start a fallback after the user stops startup', async () => {
    spawnMock.mockImplementation(() => processStub())
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not ready') }))
    const starting = sdServer.ensureUp({ modelPath: '/model.gguf' })
    const rejected = expect(starting).rejects.toThrow()
    sdServer.stop()
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the loaded CUDA server for the same model and clears it after a crash', async () => {
    const proc = processStub()
    spawnMock.mockReturnValue(proc)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })))

    await sdServer.ensureUp({ modelPath: '/model.gguf' })
    await sdServer.ensureUp({ modelPath: '/model.gguf' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(sdServer.getBinaryPath()).toBe('/bin/sd-cuda/sd-server')

    proc.emit('close', 1)
    expect(sdServer.getBinaryPath()).toBeNull()
    expect(sdServer.isUp()).toBe(false)
  })

  it('reports failure when every image runtime fails to start', async () => {
    spawnMock.mockImplementation(() => {
      const proc = processStub()
      queueMicrotask(() => proc.emit('error', new Error('runtime failed')))
      return proc
    })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('not ready') }))

    const starting = sdServer.ensureUp({ modelPath: '/model.gguf' })
    const rejected = expect(starting).rejects.toThrow('runtime failed')
    await vi.advanceTimersByTimeAsync(1000)
    await rejected
    expect(spawnMock.mock.calls.map(([binary]) => binary)).toEqual([
      '/bin/sd-cuda/sd-server', '/bin/sd/sd-server'
    ])
    expect(sdServer.getBinaryPath()).toBeNull()
  })
})
