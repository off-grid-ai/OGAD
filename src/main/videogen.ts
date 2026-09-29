import { getBackendPreference } from './backend-preferences'
import { beginRuntimeBackend, runtimeBackendSnapshot } from './runtime-backends'
import { getActiveRemoteVisionServerForModality } from './vision/remote-vision-server'
import { generateRemoteVideo } from './remote-media-runtime'
import { resolveVideoRequest, isSupportedVideoWeight, videoPackFiles } from '@offgrid/models'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getActiveModal } from './active-models'
import { getDB, getSetting, updateRagMessage } from './database'
import { readGeneratedVideoReference } from '../shared/generated-video-reference'
import {
  findSdBinary,
  findSdBinaries,
  imageBackendForRuntime,
  sdRuntimeLibraryEnv
} from './imagegen/sd-runtime'
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
const CANCELLED = 'Video generation stopped.'
let cancelRequested = false
let activeJob = false
let jobAbort: AbortController | null = null

export const generatedVideosDir = (): string => path.join(dataDir(), VIDEO_DIR)

function availablePacks(): Array<{ name: string; pack: VideoModelPack }> {
  const directory = modelsDir()
  try {
    const entries = fs.readdirSync(directory)
    return entries
      .filter((name) => isSupportedVideoWeight(name))
      .flatMap((name) => {
        const names = videoPackFiles(name)!
        const pack: Record<string, string> = {}
        for (const [role, file] of Object.entries(names)) {
          const owned = resolveExistingOwnedEntry(directory, file)
          if (!owned) return []
          pack[role] = owned
        }
        return [{ name, pack: pack as unknown as VideoModelPack }]
      })
  } catch {
    return []
  }
}

export function videoGenStatus(options: { localOnly?: boolean } = {}): {
  available: boolean
  models: string[]
  active: string | null
  reason?: string
} {
  const remote = !options.localOnly && getActiveRemoteVisionServerForModality('video')
  if (remote)
    return { available: true, models: [remote.selectedModel], active: remote.selectedModel }
  const packs = availablePacks()
  const chosen = getActiveModal('video')
  const active = packs.find((p) => p.name === chosen)?.name ?? packs[0]?.name ?? null
  if (!findSdBinary('sd-cli'))
    return {
      available: false,
      models: packs.map((p) => p.name),
      active,
      reason: 'Video engine was not found.'
    }
  if (!ffmpegBin())
    return {
      available: false,
      models: packs.map((p) => p.name),
      active,
      reason: 'Video encoder was not found.'
    }
  if (!packs.length)
    return {
      available: false,
      models: [],
      active: null,
      reason: 'Download a complete video model pack.'
    }
  return { available: true, models: packs.map((p) => p.name), active }
}

function resolvedRequest(
  request: VideoGenerationRequestContract,
  chosen: string
): Required<Omit<VideoGenerationRequestContract, 'model' | 'enhancePrompt'>> {
  const saved =
    getSetting<Record<string, Partial<VideoGenerationRequestContract>>>('videoParams', {})[
      chosen
    ] ?? {}
  const savedSeed = Number(getSetting<number | string>('videoSeed', -1))
  return resolveVideoRequest(
    { ...request, model: chosen },
    {
      ...saved,
      seed: Number.isFinite(savedSeed) ? savedSeed : -1,
      negativePrompt: getSetting('videoNegative', '')
    }
  )
}

async function enhanceVideoPrompt(
  prompt: string,
  onUpdate?: (update: VideoGenerationUpdateContract) => void,
  signal?: AbortSignal
): Promise<string> {
  let streaming = ''
  try {
    const instruction = `Rewrite the request as one short, concrete video prompt. Keep the subject and action. Add camera movement, lighting and motion only when helpful. Return only the prompt, on one line.\n\nRequest:\n${prompt.slice(0, 2000)}`
    const result = await modalityQueue.run(
      CHAT_JOB,
      () =>
        llm.chatStream(
          instruction,
          [],
          (text, kind) => {
            if (kind === 'content') {
              streaming += text
              onUpdate?.({ stage: 'enhancing', enhancedPrompt: streaming })
            }
          },
          { temperature: 0.7, thinking: false },
          2048,
          60000
        ),
      signal
    )
    return cleanEnhancedPrompt(result.content, prompt)
  } catch {
    return prompt
  }
}

function runProcess(
  binary: string,
  args: string[],
  onText?: (text: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: path.dirname(binary),
      env: { ...process.env, ...sdRuntimeLibraryEnv(process.platform, binary, process.env) }
    })
    const signal = jobAbort?.signal
    let tail = ''
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 5000)
      killTimer.unref()
    }
    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer)
      signal?.removeEventListener('abort', stop)
    }
    signal?.addEventListener('abort', stop, { once: true })
    const capture = (data: Buffer): void => {
      const text = data.toString()
      tail = `${tail}${text}`.slice(-1200)
      onText?.(text)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (code, signal) => {
      cleanup()
      if (cancelRequested) reject(new Error(CANCELLED))
      else if (code === 0) resolve()
      else
        reject(
          new Error(
            `Video engine exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}: ${tail}`
          )
        )
    })
    if (cancelRequested) stop()
  })
}

export function cancelVideoGen(): boolean {
  if (!activeJob) return false
  cancelRequested = true
  jobAbort?.abort(new Error(CANCELLED))
  return true
}

export async function generateVideo(
  input: VideoGenerationRequestContract,
  onUpdate?: (update: VideoGenerationUpdateContract) => void,
  options: { localOnly?: boolean } = {}
): Promise<VideoGenerationOutputContract> {
  if (activeJob) throw new Error('A video is already generating.')
  const status = videoGenStatus(options)
  if (!status.available) throw new Error(status.reason ?? 'Video generation is unavailable.')
  const remote = !options.localOnly && getActiveRemoteVisionServerForModality('video')
  const selected = input.model ?? status.active
  if (remote && input.model && input.model !== remote.selectedModel)
    throw new Error('Select the requested video model before generating.')
  const pack = availablePacks().find((item) => item.name === selected)
  if (!pack && !remote) throw new Error('Select a complete video model pack.')
  let request = resolvedRequest(input, selected ?? '')
  cancelRequested = false
  activeJob = true
  jobAbort = new AbortController()
  try {
    if (input.enhancePrompt ?? getSetting('enhanceVideoPrompts', false)) {
      onUpdate?.({ stage: 'enhancing', enhancedPrompt: '' })
      request = {
        ...request,
        prompt: await enhanceVideoPrompt(request.prompt, onUpdate, jobAbort.signal)
      }
    }
    if (cancelRequested) throw new Error(CANCELLED)
    onUpdate?.({ stage: 'preparing', enhancedPrompt: request.prompt })
    fs.mkdirSync(generatedVideosDir(), { recursive: true })
  } catch (error) {
    activeJob = false
    cancelRequested = false
    jobAbort = null
    throw error
  }
  const root = generatedVideosDir()
  const id = randomUUID()
  const raw = path.join(root, `${id}.webm`)
  const output = path.join(root, `${id}.mp4`)
  const previewPath = `${output}.preview.png`
  const ffmpeg = ffmpegBin()!
  try {
    if (remote) {
      await generateRemoteVideo(remote, request, output, jobAbort.signal, (progress, stage, preview) =>
        onUpdate?.({ stage: stage ?? 'generating', progress, ...(preview ? { preview } : {}) })
      )
    } else
      await modalityQueue.run(
        VIDEO_JOB,
        async () => {
          if (cancelRequested) throw new Error(CANCELLED)
          const preference = getBackendPreference('video')
          const preferred = findSdBinaries('sd-cli', preference)
          // Metal and Vulkan distributions also contain CPU kernels. Explicit
          // CPU must remain usable when no separate CPU binary is packaged.
          const runtimes =
            preference === 'cpu' && preferred.length === 0
              ? findSdBinaries('sd-cli').filter(
                  (runtime) => imageBackendForRuntime(process.platform, runtime) !== 'CUDA'
                )
              : preferred
          if (!runtimes.length) throw new Error('Video engine was not found.')
          const attempts = runtimes.map((runtime) => ({ runtime, cpu: preference === 'cpu' }))
          // Linux's Vulkan distribution includes CPU kernels in the same binary.
          if (
            preference !== 'cpu' &&
            !runtimes.some((runtime) => imageBackendForRuntime(process.platform, runtime) === 'CPU')
          ) {
            const runtime = runtimes.find(
              (item) => imageBackendForRuntime(process.platform, item) !== 'CUDA'
            )
            if (runtime) attempts.push({ runtime, cpu: true })
          }
          for (const [index, { runtime, cpu }] of attempts.entries()) {
            if (cancelRequested) throw new Error(CANCELLED)
            const backend = beginRuntimeBackend('video', pack!.name)
            let progressText = ''
            let decoding = false
            let decodeMarker = ''
            let framePublished = false
            let lastStep = 0
            try {
              // A failed engine can leave a partial file. Never accept it on retry.
              fs.rmSync(raw, { force: true })
              fs.rmSync(previewPath, { force: true })
              console.info(`[videogen] Starting runtime ${runtime}`)
              // CUDA binaries can start on a non-NVIDIA host and silently use CPU.
              // Try the Vulkan engine first in that case.
              if (!cpu && imageBackendForRuntime(process.platform, runtime) === 'CUDA') {
                let devices = ''
                await runProcess(runtime, ['--list-devices'], (chunk) => {
                  devices = `${devices}${chunk}`.slice(-16384)
                })
                if (!/^CUDA\d*\s/im.test(devices))
                  throw new Error('The CUDA engine found no usable CUDA device.')
              }
              let help = ''
              await runProcess(runtime, ['--help'], (chunk) => { help += chunk })
              const decodedPreviewArgs = help.includes('--decode-preview-path')
                ? ['--decode-preview-path', previewPath] : []
              await runProcess(
                runtime,
                [...videoArgs(pack!.pack, request, raw), ...decodedPreviewArgs, ...(cpu ? ['--backend', 'cpu'] : [])],
                (chunk) => {
                  backend.observe(chunk)
                  progressText = `${progressText}${chunk}`.slice(-4096)
                  const decoded = [...progressText.matchAll(/OFFGRID_VIDEO_DECODE (\d+) (\d+)/g)].at(-1)
                  if (decoded && decoded[0] !== decodeMarker) {
                    decodeMarker = decoded[0]
                    decoding = true
                    const step = Number(decoded[1]), total = Number(decoded[2])
                    onUpdate?.({ stage: 'decoding', progress: total > 0 ? { step, total } : null })
                  }
                  const frame = /OFFGRID_VIDEO_FRAME (\d+) (\d+)/.exec(progressText)
                  if (!framePublished && frame && fs.existsSync(previewPath)) {
                    framePublished = true
                    onUpdate?.({ stage: 'decoding', preview: { path: previewPath, width: Number(frame[1]), height: Number(frame[2]) } })
                  }

                  const match = [...progressText.matchAll(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/g)].at(-1)
                  if (match && !decoding) {
                    const step = Number(match[1])
                    const total = Number(match[2])
                    if (step > lastStep && step <= total && total <= request.steps) {
                      lastStep = step
                      backend.ready()
                      onUpdate?.({ stage: 'generating', progress: { step, total } })
                    }
                  }
                }
              )
              if (!fs.existsSync(raw) || fs.statSync(raw).size === 0)
                throw new Error('Video engine produced no clip.')
              console.info(
                '[videogen] Completed runtime',
                runtimeBackendSnapshot().find((item) => item.id === 'video')
              )
              backend.stop()
              break
            } catch (error) {
              if (cancelRequested) {
                backend.stop()
                throw new Error(CANCELLED)
              }
              backend.fail(error)
              const next = attempts[index + 1]
              if (!next) throw error
              console.warn(
                `[videogen] Runtime failed; retrying with ${next.runtime}${next.cpu ? ' (CPU)' : ''}`,
                error
              )
              onUpdate?.({ stage: 'preparing', progress: null, preview: null })
            }
          }
          onUpdate?.({ stage: 'encoding', progress: null })
          await runProcess(ffmpeg, [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-i',
            raw,
            '-an',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            output
          ])
          if (!fs.existsSync(output) || fs.statSync(output).size === 0)
            throw new Error('Video encoder produced no MP4 file.')
        },
        jobAbort.signal
      )
    if (cancelRequested) throw new Error(CANCELLED)
    return {
      path: output,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      model: remote ? remote.selectedModel : pack!.name,
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
    jobAbort = null
    fs.rmSync(raw, { force: true })
    fs.rmSync(previewPath, { force: true })
    fs.rmSync(`${previewPath}.tmp.png`, { force: true })
    cancelRequested = false
    activeJob = false
  }
}

export function listGeneratedVideos(scope?: {
  conversationId?: string
  projectId?: string | null
}): Array<{
  path: string
  name: string
  mtime: number
  syncId?: string
  conversationId?: string
  projectId?: string | null
  durationSeconds?: number
}> {
  const root = generatedVideosDir()
  try {
    return fs
      .readdirSync(root)
      .filter((name) => /\.mp4$/i.test(name))
      .flatMap((name) => {
        const owned = resolveExistingOwnedEntry(root, name)
        if (!owned) return []
        const facts = readGeneratedVideoSidecar(owned)
        if (scope?.conversationId && facts.conversationId !== scope.conversationId) return []
        if (
          !scope?.conversationId &&
          scope?.projectId !== undefined &&
          (facts.projectId ?? null) !== scope.projectId
        )
          return []
        return [{ path: owned, name, mtime: fs.statSync(owned).mtimeMs, ...facts }]
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export function deleteGeneratedVideo(candidate: string): boolean {
  const owned = resolveExistingOwnedPath(generatedVideosDir(), candidate)
  if (!owned || !owned.endsWith('.mp4')) return false
  try {
    let shared: ReturnType<typeof describeOwnGeneratedVideo> = null
    try {
      shared = describeOwnGeneratedVideo(owned)
    } catch {
      /* An older local clip can lack sync metadata. */
    }
    const messages = getDB()
      .prepare(
        "SELECT uuid, conversation_id, content, context FROM rag_messages WHERE context LIKE '%videoRef%'"
      )
      .all() as Array<{ uuid: string; conversation_id: string; content: string; context: string }>
    for (const message of messages) {
      let context: Record<string, unknown>
      try {
        context = JSON.parse(message.context) as Record<string, unknown>
      } catch {
        continue
      }
      const reference = readGeneratedVideoReference(context)
      if (
        !reference ||
        (reference.path !== owned && !(shared?.syncId && reference.id === shared.syncId))
      )
        continue
      delete context.videoRef
      updateRagMessage(message.conversation_id, message.uuid, message.content, context)
    }
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
