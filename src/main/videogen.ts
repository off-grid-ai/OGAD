import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getActiveModal } from './active-models'
import { getSetting } from './database'
import { findSdBinary, sdRuntimeLibraryEnv } from './imagegen/sd-runtime'
import { resolveExistingOwnedEntry, resolveExistingOwnedPath } from './imagegen/owned-path'
import { cleanEnhancedPrompt } from './imagegen/prompt-enhance'
import { llm } from './llm'
import { modalityQueue, CHAT_JOB, VIDEO_JOB } from './modality-queue/queue'
import { dataDir, modelsDir } from './runtime-env'
import { ffmpegBin } from './transcription/whisper-cli'
import type {
  VideoGenerationOutputContract,
  VideoGenerationRequestContract,
  VideoGenerationUpdateContract
} from '../shared/video-generation-contract'
import { videoArgs, type VideoModelPack } from './videogen/args'
import { generatedVideoSidecarPath, readGeneratedVideoSidecar } from './videogen/gallery-sidecar'
import { describeOwnGeneratedVideo } from './videogen/generated-video-share'
import { emitSharedFileMutation } from './sync-shared-file'

const VIDEO_DIR = 'generated-videos'
const WEIGHT = /wan2[._-]?1[_-]?t2v[_-]?1[._]?3b.*\.(?:safetensors|gguf)$/i
const VAE = 'wan_2.1_vae.safetensors'
const ENCODER = 'umt5-xxl-encoder-Q4_K_M.gguf'
const CANCELLED = 'Video generation stopped.'
let currentChild: ChildProcess | null = null
let cancelRequested = false
let activeJob = false

export const generatedVideosDir = (): string => path.join(dataDir(), VIDEO_DIR)

function availablePacks(): Array<{ name: string; pack: VideoModelPack }> {
  const directory = modelsDir()
  try {
    const entries = fs.readdirSync(directory)
    if (!entries.includes(VAE) || !entries.includes(ENCODER)) return []
    return entries.filter((name) => WEIGHT.test(name)).flatMap((name) => {
      const weight = resolveExistingOwnedEntry(directory, name)
      const vae = resolveExistingOwnedEntry(directory, VAE)
      const encoder = resolveExistingOwnedEntry(directory, ENCODER)
      return weight && vae && encoder ? [{ name, pack: { weight, vae, encoder } }] : []
    })
  } catch {
    return []
  }
}

export function videoGenStatus(): {
  available: boolean
  models: string[]
  active: string | null
  reason?: string
} {
  const packs = availablePacks()
  const chosen = getActiveModal('video')
  const active = packs.find((p) => p.name === chosen)?.name ?? packs[0]?.name ?? null
  if (!findSdBinary('sd-cli')) return { available: false, models: packs.map((p) => p.name), active, reason: 'Video engine was not found.' }
  if (!ffmpegBin()) return { available: false, models: packs.map((p) => p.name), active, reason: 'Video encoder was not found.' }
  if (!packs.length) return { available: false, models: [], active: null, reason: 'Download a complete video model pack.' }
  return { available: true, models: packs.map((p) => p.name), active }
}

function resolvedRequest(request: VideoGenerationRequestContract): Required<Omit<VideoGenerationRequestContract, 'model' | 'enhancePrompt'>> {
  const chosen = request.model ?? videoGenStatus().active ?? ''
  const saved = getSetting<Record<string, Partial<VideoGenerationRequestContract>>>('videoParams', {})[chosen] ?? {}
  const width = request.width ?? saved.width ?? 320
  const height = request.height ?? saved.height ?? 192
  const frames = request.frames ?? saved.frames ?? 17
  const fps = request.fps ?? saved.fps ?? 8
  const steps = request.steps ?? saved.steps ?? 20
  const guidance = request.guidance ?? saved.guidance ?? 6
  const savedSeed = Number.parseInt(getSetting('videoSeed', ''), 10)
  const requestedSeed = request.seed ?? savedSeed
  const seed = !Number.isFinite(requestedSeed) || requestedSeed < 0 ? Math.floor(Math.random() * 2147483647) : requestedSeed
  if (!request.prompt.trim()) throw new Error('Enter a video prompt.')
  if (![width, height, frames, fps, steps, guidance, seed].every(Number.isFinite)) throw new Error('Video settings must be numbers.')
  if (width < 256 || width > 832 || height < 192 || height > 480 || width % 16 || height % 16) throw new Error('Video size must use multiples of 16 from 256 × 192 through 832 × 480.')
  if (frames < 9 || frames > 81 || (frames - 1) % 4 !== 0) throw new Error('Frame count must be 4n + 1, from 9 through 81.')
  if (fps < 4 || fps > 24 || steps < 4 || steps > 50 || guidance < 0 || guidance > 20 || seed < 0) throw new Error('Video settings are outside the supported range.')
  return {
    prompt: request.prompt.trim(),
    negativePrompt: request.negativePrompt ?? getSetting('videoNegative', ''),
    width, height, frames, fps, steps, guidance, seed
  }
}

async function enhanceVideoPrompt(prompt: string, onUpdate?: (update: VideoGenerationUpdateContract) => void): Promise<string> {
  let streaming = ''
  try {
    const instruction = `Rewrite the request as one short, concrete video prompt. Keep the subject and action. Add camera movement, lighting and motion only when helpful. Return only the prompt, on one line.\n\nRequest:\n${prompt.slice(0, 2000)}`
    const result = await modalityQueue.run(CHAT_JOB, () => llm.chatStream(
      instruction, [], (text, kind) => {
        if (kind === 'content') {
          streaming += text
          onUpdate?.({ stage: 'enhancing', enhancedPrompt: streaming })
        }
      },
      { temperature: 0.7, thinking: false }, 2048, 60000
    ))
    return cleanEnhancedPrompt(result.content, prompt)
  } catch {
    return prompt
  }
}

function runProcess(binary: string, args: string[], onText?: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: path.dirname(binary),
      env: { ...process.env, ...sdRuntimeLibraryEnv(process.platform, binary, process.env) }
    })
    currentChild = child
    let tail = ''
    const capture = (data: Buffer): void => {
      const text = data.toString()
      tail = `${tail}${text}`.slice(-1200)
      onText?.(text)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => {
      currentChild = null
      reject(error)
    })
    child.once('close', (code) => {
      currentChild = null
      if (cancelRequested) reject(new Error(CANCELLED))
      else if (code === 0) resolve()
      else reject(new Error(`Video engine exited with code ${String(code)}: ${tail}`))
    })
    if (cancelRequested) child.kill('SIGTERM')
  })
}

export function cancelVideoGen(): boolean {
  if (!activeJob) return false
  cancelRequested = true
  currentChild?.kill('SIGTERM')
  return true
}

export async function generateVideo(
  input: VideoGenerationRequestContract,
  onUpdate?: (update: VideoGenerationUpdateContract) => void
): Promise<VideoGenerationOutputContract> {
  const status = videoGenStatus()
  if (!status.available) throw new Error(status.reason ?? 'Video generation is unavailable.')
  const selected = input.model ?? status.active
  const pack = availablePacks().find((item) => item.name === selected)
  if (!pack) throw new Error('Select a complete video model pack.')
  let request = resolvedRequest(input)
  cancelRequested = false
  activeJob = true
  try {
    if (input.enhancePrompt ?? getSetting('enhanceVideoPrompts', false)) {
      onUpdate?.({ stage: 'enhancing', enhancedPrompt: '' })
      request = { ...request, prompt: await enhanceVideoPrompt(request.prompt, onUpdate) }
    }
    if (cancelRequested) throw new Error(CANCELLED)
    onUpdate?.({ stage: 'preparing', enhancedPrompt: request.prompt })
    fs.mkdirSync(generatedVideosDir(), { recursive: true })
  } catch (error) {
    activeJob = false
    cancelRequested = false
    throw error
  }
  const root = generatedVideosDir()
  const id = randomUUID()
  const raw = path.join(root, `${id}.webm`)
  const output = path.join(root, `${id}.mp4`)
  const cli = findSdBinary('sd-cli')!
  const ffmpeg = ffmpegBin()!
  try {
    await modalityQueue.run(VIDEO_JOB, async () => {
      if (cancelRequested) throw new Error(CANCELLED)
      let progressText = ''
      let lastStep = 0
      await runProcess(cli, videoArgs(pack.pack, request, raw), (chunk) => {
        progressText = `${progressText}${chunk}`.slice(-256)
        const match = progressText.match(/(?:^|[^\d])(\d{1,3})\s*\/\s*(\d{1,3})(?:[^\d]|$)/)
        if (match) {
          const step = Number(match[1])
          const total = Number(match[2])
          if (step > lastStep && step <= total && total <= request.steps) {
            lastStep = step
            onUpdate?.({ stage: 'generating', progress: { step, total } })
          }
        }
      })
      if (!fs.existsSync(raw) || fs.statSync(raw).size === 0) throw new Error('Video engine produced no clip.')
      onUpdate?.({ stage: 'encoding' })
      await runProcess(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', raw,
        '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output
      ])
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('Video encoder produced no MP4 file.')
    })
    return {
      path: output,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      model: pack.name,
      width: request.width,
      height: request.height,
      frames: request.frames,
      fps: request.fps,
      steps: request.steps,
      guidance: request.guidance,
      seed: request.seed,
      durationSeconds: request.frames / request.fps
    }
  } catch (error) {
    fs.rmSync(output, { force: true })
    throw error
  } finally {
    fs.rmSync(raw, { force: true })
    cancelRequested = false
    activeJob = false
  }
}

export function listGeneratedVideos(scope?: { conversationId?: string; projectId?: string | null }): Array<{
  path: string; name: string; mtime: number; syncId?: string; conversationId?: string; projectId?: string | null; durationSeconds?: number
}> {
  const root = generatedVideosDir()
  try {
    return fs.readdirSync(root).filter((name) => /\.mp4$/i.test(name)).flatMap((name) => {
      const owned = resolveExistingOwnedEntry(root, name)
      if (!owned) return []
      const facts = readGeneratedVideoSidecar(owned)
      if (scope?.conversationId && facts.conversationId !== scope.conversationId) return []
      if (!scope?.conversationId && scope?.projectId && facts.projectId !== scope.projectId) return []
      return [{ path: owned, name, mtime: fs.statSync(owned).mtimeMs, ...facts }]
    }).sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function deleteGeneratedVideo(candidate: string): boolean {
  const owned = resolveExistingOwnedPath(generatedVideosDir(), candidate)
  if (!owned || !owned.endsWith('.mp4')) return false
  try {
    let shared: ReturnType<typeof describeOwnGeneratedVideo> = null
    try { shared = describeOwnGeneratedVideo(owned) } catch { /* An older local clip can lack sync metadata. */ }
    fs.rmSync(owned)
    fs.rmSync(generatedVideoSidecarPath(owned), { force: true })
    if (shared) emitSharedFileMutation({ kind: 'delete', file: shared })
    return true
  } catch {
    return false
  }
}

export async function exportGeneratedVideo(candidate: string, destination: string): Promise<void> {
  const owned = resolveExistingOwnedPath(generatedVideosDir(), candidate)
  if (!owned || !owned.endsWith('.mp4')) throw new Error('Video is outside the gallery.')
  await fs.promises.copyFile(owned, destination)
}
