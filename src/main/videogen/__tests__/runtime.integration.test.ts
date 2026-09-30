import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ports = vi.hoisted(() => ({
  root: '', settings: {} as Record<string, unknown>, spawn: vi.fn(),
  run: vi.fn(), share: vi.fn()
}))
vi.mock('../../database', () => ({ getSetting: (key: string, fallback: unknown) => ports.settings[key] ?? fallback }))
vi.mock('../../llm', () => ({ llm: { chatStream: vi.fn() } }))
vi.mock('../../runtime-env', () => ({ dataDir: () => ports.root, modelsDir: () => path.join(ports.root, 'models') }))
vi.mock('../../imagegen/sd-runtime', () => ({ findSdBinary: () => '/bin/sd-cli', sdRuntimeLibraryEnv: () => ({}) }))
vi.mock('../../transcription/whisper-cli', () => ({ ffmpegBin: () => '/bin/ffmpeg' }))
vi.mock('../../modality-queue/queue', () => ({ modalityQueue: { run: ports.run }, CHAT_JOB: {}, VIDEO_JOB: {} }))
vi.mock('../../sync-shared-file', () => ({ emitSharedFileMutation: ports.share }))
vi.mock('node:child_process', () => ({ spawn: ports.spawn }))

import { cancelVideoGen, deleteGeneratedVideo, generateVideo, listGeneratedVideos, videoGenStatus } from '../../videogen'
import { writeGeneratedVideoSidecar } from '../gallery-sidecar'

const weight = 'wan2.1_t2v_1.3B_fp16.safetensors'
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: vi.fn(function (this: EventEmitter) { queueMicrotask(() => this.emit('close', null)); return true })
  })
}
beforeEach(() => {
  ports.root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-video-'))
  fs.mkdirSync(path.join(ports.root, 'models'))
  for (const name of [weight, 'wan_2.1_vae.safetensors', 'umt5-xxl-encoder-Q4_K_M.gguf']) {
    fs.writeFileSync(path.join(ports.root, 'models', name), 'fixture')
  }
  ports.settings = {}
  ports.run.mockReset().mockImplementation((_job, work) => work())
  ports.share.mockReset()
  ports.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
    const process = child()
    queueMicrotask(() => {
      process.stderr.emit('data', Buffer.from('1 / 20\n'))
      process.stderr.emit('data', Buffer.from('2 / 20\n'))
      fs.writeFileSync(args.at(-1)!, 'synthetic video bytes')
      process.emit('close', 0)
    })
    return process
  })
})
afterEach(() => fs.rmSync(ports.root, { recursive: true, force: true }))

describe('local video runtime boundary', () => {
  it('requires the complete model pack before admitting a job', async () => {
    fs.unlinkSync(path.join(ports.root, 'models', 'wan_2.1_vae.safetensors'))
    expect(videoGenStatus().available).toBe(false)
    await expect(generateVideo({ prompt: 'lake' })).rejects.toThrow('complete video model pack')
    expect(ports.spawn).not.toHaveBeenCalled()
  })

  it('uses saved settings, reports later steps, encodes MP4, and removes the intermediate file', async () => {
    ports.settings = { videoParams: { [weight]: { width: 512, height: 288, frames: 33, fps: 16, steps: 20, guidance: 5 } }, videoSeed: '91', videoNegative: 'blur' }
    const updates = vi.fn()
    const result = await generateVideo({ prompt: 'A slow pan across a lake' }, updates)
    expect(result).toMatchObject({ width: 512, height: 288, frames: 33, fps: 16, seed: 91, negativePrompt: 'blur', durationSeconds: 33 / 16 })
    expect(updates).toHaveBeenCalledWith({ stage: 'generating', progress: { step: 2, total: 20 } })
    expect(ports.spawn.mock.calls[0]![1]).toEqual(expect.arrayContaining(['vid_gen', '--vae', '--t5xxl', '-n', 'blur']))
    expect(ports.spawn.mock.calls[1]![1]).toEqual(expect.arrayContaining(['libx264', 'yuv420p', '+faststart']))
    expect(fs.existsSync(result.path)).toBe(true)
    expect(fs.readdirSync(path.dirname(result.path))).toEqual([path.basename(result.path)])
  })

  it('rejects fractional steps before starting the engine', async () => {
    await expect(generateVideo({ prompt: 'lake', steps: 4.5 })).rejects.toThrow()
    expect(ports.spawn).not.toHaveBeenCalled()
  })

  it('cancels a queued job without spawning an engine', async () => {
    let release!: () => void
    ports.run.mockImplementation((_job, work) => new Promise<void>(resolve => { release = resolve }).then(work))
    const pending = generateVideo({ prompt: 'lake' })
    const rejection = expect(pending).rejects.toThrow('stopped')
    expect(cancelVideoGen()).toBe(true)
    release()
    await rejection
    expect(ports.spawn).not.toHaveBeenCalled()
    expect(cancelVideoGen()).toBe(false)
  })

  it('cleans failed encoding output and permits the next job', async () => {
    ports.spawn.mockImplementation((binary: string, args: string[]) => {
      const process = child()
      queueMicrotask(() => {
        fs.writeFileSync(args.at(-1)!, 'partial')
        process.emit('close', binary.endsWith('ffmpeg') ? 1 : 0)
      })
      return process
    })
    await expect(generateVideo({ prompt: 'lake' })).rejects.toThrow('code 1')
    expect(fs.readdirSync(path.join(ports.root, 'generated-videos'))).toEqual([])
    expect(cancelVideoGen()).toBe(false)
  })

  it('scopes the gallery and refuses deletion outside its owned directory', async () => {
    const result = await generateVideo({ prompt: 'lake' })
    writeGeneratedVideoSidecar(result.path, { conversationId: 'chat-a', projectId: 'project-a' })
    expect(listGeneratedVideos({ conversationId: 'chat-b' })).toEqual([])
    expect(listGeneratedVideos({ conversationId: 'chat-a' })).toHaveLength(1)
    const outsider = path.join(ports.root, 'outside.mp4')
    fs.writeFileSync(outsider, 'keep')
    expect(deleteGeneratedVideo(outsider)).toBe(false)
    expect(fs.existsSync(outsider)).toBe(true)
    expect(deleteGeneratedVideo(result.path)).toBe(true)
    expect(listGeneratedVideos()).toEqual([])
  })
})
