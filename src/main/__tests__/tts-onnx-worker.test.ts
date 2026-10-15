import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const host = vi.hoisted(() => ({
  on: vi.fn(),
  post: vi.fn(),
  load: vi.fn(),
  generate: vi.fn(),
  modelsDir: '',
  readDirectories: [] as string[],
  device: 'coreml' as string
}))
// The process boundary: a helper process's parent port (utility-host.ts sends init, then requests).
Object.defineProperty(process, 'parentPort', {
  value: { on: host.on, postMessage: host.post },
  configurable: true
})
vi.mock('kokoro-js', () => ({ KokoroTTS: { from_pretrained: host.load } }))
vi.mock('../embeddings-env', () => ({ configureTransformersEnv: vi.fn() }))
vi.mock('../onnx-device', () => ({
  loadWithOnnxFallback: async (load: (device: string) => Promise<unknown>) => ({
    runtime: await load(host.device),
    device: host.device
  })
}))
let profile: string
let output: string

/** Load the helper, send it the host's init message, and return its request channel. */
async function startWorker(): Promise<(request: unknown) => void> {
  await import('../tts-onnx-worker')
  const listener = host.on.mock.calls[0]![1] as (event: { data: unknown }) => void
  listener({
    data: {
      type: 'init',
      data: {
        modelsDir: host.modelsDir,
        modelReadDirectories: host.readDirectories,
        devices: [host.device, 'cpu']
      }
    }
  })
  return (request) => listener({ data: request })
}
beforeEach(() => {
  profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-onnx-speech-')))
  host.modelsDir = path.join(profile, 'models')
  host.readDirectories = [host.modelsDir]
  output = path.join(profile, 'out.wav')
  fs.mkdirSync(host.modelsDir)
  vi.resetModules()
  host.device = 'coreml'
  for (const mock of [host.on, host.post, host.load, host.generate]) mock.mockReset()
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
})
afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))
describe('voice helper response evidence', () => {
  it('loads a complete scan-folder package while the chosen folder is offline', async () => {
    const scan = path.join(profile, 'scan')
    const packageRoot = path.join(scan, '.cache/onnx-community/Kokoro-82M-v1.0-ONNX')
    for (const name of [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      // Core ML runs Kokoro's FP32 graph (its FP16 graph returned all-NaN audio).
      'onnx/model.onnx'
    ]) {
      const file = path.join(packageRoot, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, 'synthetic speech model')
    }
    host.readDirectories.push(scan)
    fs.rmdirSync(host.modelsDir)
    ;(await startWorker())({ id: 8, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 8, type: 'complete', device: 'coreml' })
    )
    expect(host.load).toHaveBeenCalledWith(
      packageRoot,
      expect.objectContaining({ dtype: 'fp32', local_files_only: true })
    )
    expect(fs.existsSync(host.modelsDir)).toBe(false)
  })

  it('refuses a speech download when storage is offline and the package is incomplete', async () => {
    fs.rmdirSync(host.modelsDir)
    ;(await startWorker())({ id: 9, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 9,
          type: 'error',
          error: expect.stringContaining('Connect the drive or choose another folder.')
        })
      )
    )
    expect(host.load).not.toHaveBeenCalled()
    expect(fs.existsSync(host.modelsDir)).toBe(false)
  })

  it('uses FP32 for CUDA speech so the T4 does not return NaN audio', async () => {
    host.device = 'cuda'
    ;(await startWorker())({ id: 7, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 7, type: 'complete', device: 'cuda' })
    )
    expect(host.load.mock.calls[0]![1]).toMatchObject({ dtype: 'fp32', device: 'cuda' })
  })
  it('reports the actual provider, emits progress and reuses its loaded runtime', async () => {
    const receive = await startWorker()
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
      outputPath: output
    })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 2, type: 'complete', device: 'coreml' })
    )
    expect(host.load).toHaveBeenCalledOnce()
    expect(host.load.mock.calls[0]![1]).toMatchObject({ dtype: 'fp32', device: 'coreml' })
    const wav = fs.readFileSync(output)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(20)).toBe(1) // PCM
    expect(wav.readUInt16LE(34)).toBe(16)
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([
      -32768, 0, 32767
    ])
  })
  it('returns an error for incomplete synthesis without claiming completion', async () => {
    ;(await startWorker())({ id: 3, type: 'synthesize', voice: 'af_heart' })
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
    ;(await startWorker())({
      id: 6,
      type: 'synthesize',
      text: 'Hello',
      voice: 'af_heart',
      outputPath: output
    })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 6,
          type: 'error',
          error: expect.stringContaining('silent audio')
        })
      )
    )
    expect(fs.existsSync(output)).toBe(false)
  })

  it('retries model loading after a provider failure', async () => {
    host.load.mockRejectedValueOnce(new Error('provider unavailable'))
    const receive = await startWorker()
    receive({ id: 4, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({
        id: 4,
        type: 'error',
        error: 'provider unavailable'
      })
    )
    receive({ id: 5, type: 'prepare', voice: 'af_heart' })
    await vi.waitFor(() =>
      expect(host.post).toHaveBeenCalledWith({ id: 5, type: 'complete', device: 'coreml' })
    )
    expect(host.load).toHaveBeenCalledTimes(2)
  })
})
