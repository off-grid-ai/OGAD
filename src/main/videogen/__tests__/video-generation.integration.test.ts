// The local video journey through the real job service, runtime, modality queue, settings
// database and gallery. Only the external executables are stand-ins: `sd-cli` and `ffmpeg`
// are small scripts that print the engine's real progress format and write real files, so
// every process, file and cancellation path below is the one users run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VideoGenerationJobContract } from '../../../shared/video-generation-contract'

// Electron is the one framework boundary: no safe storage in a Node test process.
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { configureRuntime } from '../../runtime-env'
import { getDB, saveSetting } from '../../database'
import { cancelVideoGen, deleteGeneratedVideo, listGeneratedVideos, videoGenStatus } from '../../videogen'
import { VideoGenerationJobService } from '../job-service'
import { readGeneratedVideoSidecar, writeGeneratedVideoSidecar } from '../gallery-sidecar'
import { readGeneratedVideoMetadata } from '@offgrid/sync'

const WEIGHT = 'wan2.1_t2v_1.3B_fp16.safetensors'
const PACK = [WEIGHT, 'wan_2.1_vae.safetensors', 'umt5-xxl-encoder-Q4_K_M.gguf']

/** sd-cli: --help, --list-devices, or one clip. FAKE_SD_MODE picks ok, slow, or gpu-fails. */
const FAKE_SD_CLI = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_SD_ARGS) fs.appendFileSync(process.env.FAKE_SD_ARGS, JSON.stringify(args) + '\\n')
if (args.includes('--help')) { process.stdout.write('usage: sd-cli [--decode-preview-path PATH]\\n'); process.exit(0) }
if (args.includes('--list-devices')) process.exit(0)
const value = (flag) => args[args.indexOf(flag) + 1]
const mode = process.env.FAKE_SD_MODE || 'ok'
if (mode === 'gpu-fails' && !args.includes('cpu')) { process.stderr.write('ggml_vulkan: device lost\\n'); process.exit(1) }
const steps = Number(value('--steps'))
let step = 0
process.stderr.write('loading tensors 812/1095\\n')
const tick = () => {
  if (mode === 'slow') return setTimeout(tick, 50)
  step += 1
  process.stderr.write('  |=====>     | ' + step + '/' + steps + ' - 0.10s/it\\r')
  if (step < steps) return setTimeout(tick, 5)
  process.stderr.write('OFFGRID_VIDEO_DECODE 1 2\\n')
  const preview = args.includes('--decode-preview-path') ? value('--decode-preview-path') : null
  if (preview) { fs.writeFileSync(preview, 'png'); process.stderr.write('OFFGRID_VIDEO_FRAME 832 480\\n') }
  process.stderr.write('OFFGRID_VIDEO_DECODE 2 2\\n')
  fs.writeFileSync(value('-o'), 'synthetic clip')
  process.exit(0)
}
process.on('SIGTERM', () => process.exit(143))
tick()
`

/** ffmpeg: lists an H.264 encoder and copies the clip to the MP4 it is asked for. */
const FAKE_FFMPEG = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('-encoders')) { process.stdout.write(' V....D libx264  H.264 / AVC\\n'); process.exit(0) }
if (process.env.FAKE_FFMPEG_MODE === 'fail') { fs.writeFileSync(args.at(-1), 'partial'); process.exit(1) }
fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1))
`

let root: string
let argsLog: string

function install(dir: string, name: string, source: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), source, { mode: 0o755 })
}

function engineRuns(): string[][] {
  if (!fs.existsSync(argsLog)) return []
  return fs
    .readFileSync(argsLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[])
    .filter((args) => args.includes('vid_gen'))
}

function videosDir(): string {
  return path.join(root, 'generated-videos')
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'og-video-journey-'))
  const bin = path.join(root, 'bin')
  install(path.join(bin, 'sd'), 'sd-cli', FAKE_SD_CLI)
  install(bin, 'ffmpeg', FAKE_FFMPEG)
  fs.mkdirSync(path.join(root, 'models'))
  for (const name of PACK) fs.writeFileSync(path.join(root, 'models', name), 'weights')
  argsLog = path.join(root, 'sd-args.log')
  process.env.FAKE_SD_ARGS = argsLog
  delete process.env.FAKE_SD_MODE
  delete process.env.FAKE_FFMPEG_MODE
  configureRuntime({ dataDir: root, modelsDir: path.join(root, 'models'), binRoots: [bin] })
  getDB()
})

afterEach(() => {
  getDB().close()
  configureRuntime({ dataDir: undefined, modelsDir: undefined, binRoots: undefined })
  delete process.env.FAKE_SD_ARGS
  fs.rmSync(root, { recursive: true, force: true })
})

/** Run one job and keep every snapshot the UI would have been shown. */
async function run(
  jobs: VideoGenerationJobService,
  request: Parameters<VideoGenerationJobService['start']>[0]
): Promise<{ snapshots: VideoGenerationJobContract[]; result: Awaited<ReturnType<VideoGenerationJobService['start']>> }> {
  const snapshots: VideoGenerationJobContract[] = []
  const off = jobs.onChange((job) => snapshots.push(job))
  try {
    return { snapshots, result: await jobs.start(request) }
  } finally {
    off()
  }
}

describe.skipIf(process.platform === 'win32')('local video generation journey', () => {
  it('refuses to start without the complete model pack', async () => {
    fs.unlinkSync(path.join(root, 'models', 'wan_2.1_vae.safetensors'))
    expect(videoGenStatus()).toMatchObject({ available: false })
    await expect(new VideoGenerationJobService().start({ prompt: 'lake' })).rejects.toThrow(
      'complete video model pack'
    )
    expect(engineRuns()).toEqual([])
  })

  it('makes a clip: sampling steps only, then decode, preview and encoding, then a saved MP4', async () => {
    const jobs = new VideoGenerationJobService()
    const { snapshots, result } = await run(jobs, {
      prompt: 'A red ball rolls across a table',
      steps: 4,
      conversationId: 'chat-a'
    })

    const steps = snapshots
      .filter((job) => job.stage === 'generating' && job.progress)
      .map((job) => job.progress!.step)
    // Tensor loading (812/1095) is never shown as generation progress.
    expect(steps).toEqual([1, 2, 3, 4])
    expect(snapshots.some((job) => job.stage === 'decoding' && job.preview)).toBe(true)
    expect(snapshots.some((job) => job.stage === 'encoding')).toBe(true)
    expect(jobs.status()).toMatchObject({ phase: 'succeeded', outputPath: result.path })

    // The MP4 is the only file left: the intermediate clip and preview are gone.
    expect(fs.readFileSync(result.path, 'utf8')).toBe('synthetic clip')
    expect(fs.readdirSync(videosDir()).sort()).toEqual(
      [path.basename(result.path), `${path.basename(result.path)}.json`].sort()
    )
    const sidecar = readGeneratedVideoSidecar(result.path)
    expect(sidecar).toMatchObject({ conversationId: 'chat-a', syncId: result.syncId })
    expect(readGeneratedVideoMetadata(sidecar.metadataJson)).toMatchObject({
      prompt: 'A red ball rolls across a table',
      steps: 4
    })
    expect(listGeneratedVideos({ conversationId: 'chat-a' })).toHaveLength(1)
  })

  it('gives the engine the saved settings for this model', async () => {
    saveSetting('videoParams', {
      [WEIGHT]: { width: 512, height: 288, frames: 33, fps: 16, steps: 4, guidance: 5 }
    })
    saveSetting('videoSeed', 91)
    saveSetting('videoNegative', 'blur')
    const { result } = await run(new VideoGenerationJobService(), { prompt: 'A slow pan' })
    expect(result).toMatchObject({ width: 512, height: 288, frames: 33, fps: 16, seed: 91 })
    const args = engineRuns()[0]!
    const flag = (name: string): string | undefined => args[args.indexOf(name) + 1]
    expect([flag('-W'), flag('-H'), flag('--video-frames'), flag('--steps')]).toEqual([
      '512',
      '288',
      '33',
      '4'
    ])
    expect([flag('-s'), flag('-n'), flag('--flow-shift')]).toEqual(['91', 'blur', '3'])
  })

  it('retries on the CPU when the GPU engine fails, and the clip still completes', async () => {
    process.env.FAKE_SD_MODE = 'gpu-fails'
    const { result } = await run(new VideoGenerationJobService(), { prompt: 'lake', steps: 4 })
    const runs = engineRuns()
    expect(runs).toHaveLength(2)
    expect(runs[0]).not.toContain('cpu')
    expect(runs[1]!.slice(-2)).toEqual(['--backend', 'cpu'])
    expect(fs.existsSync(result.path)).toBe(true)
  })

  it('stops a running engine, keeps no clip, and lets the next clip run', async () => {
    process.env.FAKE_SD_MODE = 'slow'
    const jobs = new VideoGenerationJobService()
    const running = jobs.start({ prompt: 'lake', steps: 4 })
    await vi.waitFor(() => expect(engineRuns()).toHaveLength(1), { timeout: 5000 })
    expect(jobs.cancel()).toBe(true)
    await expect(running).rejects.toThrow(/stopped/i)
    expect(jobs.status().phase).toBe('cancelled')
    expect(fs.readdirSync(videosDir())).toEqual([])

    delete process.env.FAKE_SD_MODE
    const { result } = await run(jobs, { prompt: 'lake', steps: 4 })
    expect(fs.existsSync(result.path)).toBe(true)
  })

  it('removes a failed encoding and lets the next clip run', async () => {
    process.env.FAKE_FFMPEG_MODE = 'fail'
    await expect(new VideoGenerationJobService().start({ prompt: 'lake', steps: 4 })).rejects.toThrow(
      'code 1'
    )
    expect(fs.readdirSync(videosDir())).toEqual([])
    expect(cancelVideoGen()).toBe(false)
    delete process.env.FAKE_FFMPEG_MODE
    const { result } = await run(new VideoGenerationJobService(), { prompt: 'lake', steps: 4 })
    expect(fs.existsSync(result.path)).toBe(true)
  })

  it('refuses a second clip while one runs, and links the finished clip to its chat message', async () => {
    process.env.FAKE_SD_MODE = 'slow'
    const jobs = new VideoGenerationJobService()
    const chat = '11111111-1111-4111-8111-111111111111'
    const first = jobs.start({ prompt: 'lake', steps: 4, conversationId: chat, projectId: 'project-a' })
    await expect(jobs.start({ prompt: 'second', steps: 4 })).rejects.toThrow('already generating')
    await vi.waitFor(() => expect(engineRuns()).toHaveLength(1), { timeout: 5000 })
    jobs.cancel()
    await expect(first).rejects.toThrow(/stopped/i)

    delete process.env.FAKE_SD_MODE
    const { result } = await run(jobs, { prompt: 'lake', steps: 4, conversationId: chat, projectId: 'project-a' })
    expect(jobs.acknowledgeConversation('chat-b', 'message-b')).toBe(false)
    const updated: string[] = []
    jobs.onConversationUpdated((conversationId) => updated.push(conversationId))
    const message = '22222222-2222-4222-8222-222222222222'
    expect(jobs.acknowledgeConversation(chat, message)).toBe(true)
    expect(readGeneratedVideoSidecar(result.path)).toMatchObject({
      syncId: result.syncId,
      messageId: message,
      projectId: 'project-a'
    })
    expect(updated).toEqual([chat])
  })

  it('records an engine failure without keeping a clip, and rejects invalid settings before it starts', async () => {
    await expect(new VideoGenerationJobService().start({ prompt: 'lake', steps: 4.5 })).rejects.toThrow()
    expect(engineRuns()).toEqual([])
    fs.rmSync(path.join(root, 'bin', 'sd', 'sd-cli'))
    install(path.join(root, 'bin', 'sd'), 'sd-cli', '#!/bin/sh\necho "out of memory" >&2\nexit 1\n')
    const jobs = new VideoGenerationJobService()
    await expect(jobs.start({ prompt: 'lake', steps: 4 })).rejects.toThrow(/out of memory/)
    expect(jobs.status()).toMatchObject({ phase: 'failed', outputPath: null })
    expect(fs.readdirSync(videosDir())).toEqual([])
  })

  it('scopes the gallery and never deletes outside its own folder', async () => {
    const { result } = await run(new VideoGenerationJobService(), { prompt: 'lake', steps: 4 })
    writeGeneratedVideoSidecar(result.path, { conversationId: 'chat-a', projectId: 'project-a' })
    expect(listGeneratedVideos({ conversationId: 'chat-b' })).toEqual([])
    expect(listGeneratedVideos({ conversationId: 'chat-a' })).toHaveLength(1)
    const outsider = path.join(root, 'outside.mp4')
    fs.writeFileSync(outsider, 'keep')
    expect(deleteGeneratedVideo(outsider)).toBe(false)
    expect(fs.existsSync(outsider)).toBe(true)
    expect(deleteGeneratedVideo(result.path)).toBe(true)
    expect(listGeneratedVideos()).toEqual([])
  })
})
