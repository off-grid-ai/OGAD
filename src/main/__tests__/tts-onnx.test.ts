import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
// The process boundary: Electron's utilityProcess. The host, its request map, crash handling and
// the helper's init message are production code.
interface TestWorker extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
}
const host = vi.hoisted(() => ({ workers: [] as TestWorker[] }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: () => true
}))
vi.mock('../backend-preferences', () => ({ getBackendPreference: () => 'auto' }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeUtilityProcess extends EventEmitter {
    postMessage = vi.fn()
    kill = vi.fn(() => {
      this.emit('exit', 0)
      return true
    })
  }
  return {
    utilityProcess: {
      fork: () => {
        const child = new FakeUtilityProcess()
        host.workers.push(child as unknown as TestWorker)
        return child
      }
    }
  }
})
import { OnnxSpeechRuntime } from '../tts-onnx'
beforeEach(() => {
  host.workers.length = 0
})
describe('voice helper process lifecycle', () => {
  it('uses the actual completion device and forwards progress for each request', async () => {
    const runtime = new OnnxSpeechRuntime()
    const progress = vi.fn()
    const first = runtime.prepare('af_heart', progress)
    const worker = host.workers[0]!
    worker.emit('message', {
      id: 1,
      type: 'progress',
      downloadedBytes: 5,
      totalBytes: 10,
      percentage: 50
    })
    expect(progress).toHaveBeenCalledWith({
      voiceId: 'af_heart',
      downloadedBytes: 5,
      totalBytes: 10,
      percentage: 50,
      currentAsset: 'kokoro-onnx'
    })
    worker.emit('message', { id: 1, type: 'complete', device: 'coreml' })
    await expect(first).resolves.toBe('coreml')
    const second = runtime.synthesize({
      voice: 'af_heart',
      text: 'Hello',
      outputPath: '/synthetic/out.wav'
    })
    expect(host.workers).toHaveLength(1)
    expect(worker.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 2, type: 'synthesize', text: 'Hello' })
    )
    worker.emit('message', { id: 2, type: 'complete', device: 'cuda' })
    await expect(second).resolves.toBe('cuda')
    // The helper's first message is its init data; requests follow.
    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: 'init' })
    await runtime.close()
    expect(worker.kill).toHaveBeenCalledOnce()
  })
  it('rejects worker errors and starts a new worker after a crash', async () => {
    const runtime = new OnnxSpeechRuntime()
    const first = runtime.prepare('af_heart')
    const failed = expect(first).rejects.toThrow('provider failed')
    host.workers[0]!.emit('message', { id: 1, type: 'error', error: 'provider failed' })
    await failed
    const second = runtime.prepare('af_heart')
    const crashed = expect(second).rejects.toThrow('exit code 9')
    host.workers[0]!.emit('exit', 9)
    await crashed
    const third = runtime.prepare('af_heart')
    expect(host.workers).toHaveLength(2)
    host.workers[1]!.emit('message', { id: 3, type: 'complete', device: 'cpu' })
    await expect(third).resolves.toBe('cpu')
    await runtime.close()
  })
})
