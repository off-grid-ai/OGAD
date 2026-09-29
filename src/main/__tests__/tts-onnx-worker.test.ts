import { beforeEach, describe, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({
  on: vi.fn(),
  post: vi.fn(),
  load: vi.fn(),
  generate: vi.fn(),
  write: vi.fn()
}))
vi.mock('node:worker_threads', () => ({
  parentPort: { on: host.on, postMessage: host.post },
  workerData: { modelsDir: '/synthetic/models' }
}))
vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: host.load } }))
vi.mock('node:fs/promises', () => ({ writeFile: host.write }))
vi.mock('../embeddings-env', () => ({ configureTransformersEnv: vi.fn() }))
vi.mock('../onnx-device', () => ({
  onnxDeviceCandidates: () => ['coreml', 'cpu'],
  loadWithOnnxFallback: async (load: (device: string) => Promise<unknown>) => ({
    runtime: await load('coreml'),
    device: 'coreml'
  })
}))
beforeEach(() => {
  vi.resetModules()
  for (const mock of Object.values(host)) mock.mockReset()
  host.load.mockImplementation(async (_id, options) => {
    options.progress_callback({
      status: 'progress',
      progress: 50,
      loaded: 5,
      total: 10,
      file: 'model.onnx'
    })
    return { generate: host.generate }
  })
  host.generate.mockResolvedValue({ data: new Float32Array([-1, 0, 1]), sampling_rate: 24000 })
  host.write.mockResolvedValue(undefined)
})
describe('ONNX speech worker response evidence', () => {
  it('reports the actual provider, emits progress and reuses its loaded runtime', async () => {
    await import('../tts-onnx-worker')
    const receive = host.on.mock.calls[0]![1]
    receive({ id: 1, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 1, type: 'complete', device: 'coreml' })
    )
    expect(host.post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'progress', percentage: 50 })
    )
    receive({
      id: 2,
      type: 'synthesize',
      text: 'Hello',
      voice: 'af_heart',
      outputPath: '/synthetic/out.wav'
    })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 2, type: 'complete', device: 'coreml' })
    )
    expect(host.load).toHaveBeenCalledOnce()
    expect(host.load.mock.calls[0]![1]).toMatchObject({ dtype: 'fp16', device: 'coreml' })
    expect(host.write).toHaveBeenCalledWith('/synthetic/out.wav', expect.any(Buffer))
    const wav = host.write.mock.calls[0]![1] as Buffer
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(34)).toBe(16)
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([
      -32768, 0, 32767
    ])
  })
  it('returns an error for incomplete synthesis without claiming completion', async () => {
    await import('../tts-onnx-worker')
    host.on.mock.calls[0]![1]({ id: 3, type: 'synthesize', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({
        id: 3,
        type: 'error',
        error: 'Speech request is incomplete.'
      })
    )
    expect(host.generate).not.toHaveBeenCalled()
  })

  it('does not write a silent voice reply', async () => {
    host.generate.mockResolvedValue({ data: new Float32Array(2400), sampling_rate: 24000 })
    await import('../tts-onnx-worker')
    host.on.mock.calls[0]![1]({
      id: 6, type: 'synthesize', text: 'Hello', voice: 'af_heart', outputPath: '/synthetic/out.wav'
    })
    await vi.waitFor(() => expect(host.post).toHaveBeenCalledWith(expect.objectContaining({
      id: 6, type: 'error', error: expect.stringContaining('silent audio')
    })))
    expect(host.write).not.toHaveBeenCalled()
  })

  it('retries model loading after a provider failure', async () => {
    host.load.mockRejectedValueOnce(new Error('provider unavailable'))
    await import('../tts-onnx-worker')
    const receive = host.on.mock.calls[0]![1]
    receive({ id: 4, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 4, type: 'error', error: 'provider unavailable' })
    )
    receive({ id: 5, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 5, type: 'complete', device: 'coreml' })
    )
    expect(host.load).toHaveBeenCalledTimes(2)
  })
})
