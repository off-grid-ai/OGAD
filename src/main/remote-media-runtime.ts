import fs from 'node:fs'
import path from 'node:path'
import type { VideoGenerationProgressContract, VideoGenerationStage } from '@offgrid/models'
import { kokoroVoiceLanguage, type RuntimeSpeechVoice } from '@offgrid/speech'
import { IMAGE_MEMORY_GUARD_ERROR_CODE, imageMemoryGuardErrorMessage } from '../shared/image-generation-contract'
import { getActiveRemoteVisionServerForModality } from './vision/remote-vision-server'

type RemoteServer = NonNullable<ReturnType<typeof getActiveRemoteVisionServerForModality>>

let cachedRemoteVoices:
  | { key: string; expiresAt: number; voices: RuntimeSpeechVoice[] }
  | undefined

export async function listRemoteVoices(server: RemoteServer): Promise<RuntimeSpeechVoice[]> {
  const key = `${server.id}:${server.endpoint}:${server.selectedModel}`
  if (cachedRemoteVoices?.key === key && cachedRemoteVoices.expiresAt > Date.now()) {
    return cachedRemoteVoices.voices
  }
  const response = await checked(
    await fetch(`${server.endpoint}/models?output_modalities=speech`, {
      headers: headers(server)
    })
  )
  const catalog = (await response.json()) as {
    data?: Array<{ id?: string; supported_voices?: string[] }>
  }
  const model = catalog.data?.find((item) => item.id === server.selectedModel)
  const voices = (model?.supported_voices ?? [])
    .filter((id): id is string => typeof id === 'string' && !!id)
    .map((id) => {
      const language = server.selectedModel === 'hexgrad/kokoro-82m'
        ? kokoroVoiceLanguage(id)?.code
        : server.selectedModel.startsWith('deepgram/')
          ? id.match(/-([a-z]{2})$/i)?.[1]?.toLowerCase()
          : server.selectedModel.startsWith('microsoft/mai-voice-2')
            ? id.match(/^([a-z]{2}-[A-Z]{2})-/)?.[1]
            : server.selectedModel.startsWith('mistralai/voxtral-mini-tts')
              ? id.match(/^([a-z]{2})_/i)?.[1]?.toLowerCase().replace(/^gb$/, 'en-GB')
              : undefined
      return {
        id,
        label: id
          .replace(/^flux-/, '')
          .replace(/-en$/, '')
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (letter) => letter.toUpperCase()),
        ...(language ? { language } : {})
      }
    })
  cachedRemoteVoices = { key, voices, expiresAt: Date.now() + 5 * 60_000 }
  return voices
}

function headers(server: RemoteServer, contentType?: string): Record<string, string> {
  return {
    ...(server.apiKey ? { Authorization: `Bearer ${server.apiKey}` } : {}),
    ...(contentType ? { 'Content-Type': contentType } : {})
  }
}

async function providerFailure(response: Response): Promise<never> {
  const body = (await response.text().catch(() => '')).slice(0, 4096)
  let message = body.trim()
  let code = ''
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string } | string
      message?: string
      code?: string
    }
    message =
      typeof parsed.error === 'string'
        ? parsed.error
        : (parsed.error?.message ?? parsed.message ?? '')
    code =
      parsed.error && typeof parsed.error === 'object'
        ? (parsed.error.code ?? parsed.code ?? '')
        : (parsed.code ?? '')
  } catch {
    /* A plain-text server error is still useful. */
  }
  message = (message || `Server returned HTTP ${response.status}.`).slice(0, 500)
  if (code === IMAGE_MEMORY_GUARD_ERROR_CODE || message.includes(IMAGE_MEMORY_GUARD_ERROR_CODE)) {
    throw new Error(imageMemoryGuardErrorMessage(message.replace(`${IMAGE_MEMORY_GUARD_ERROR_CODE}:`, '').trim()))
  }
  throw new Error(message)
}

async function checked(response: Response): Promise<Response> {
  if (!response.ok) await providerFailure(response)
  return response
}

function decodeImageDataUrl(value: string): { bytes: Buffer; mime: string } {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(value)
  if (!match) throw new Error('The remote server returned an unsupported image format.')
  return { bytes: Buffer.from(match[2]!, 'base64'), mime: match[1]!.toLowerCase() }
}

export async function generateRemoteImage(
  server: RemoteServer,
  prompt: string,
  width: number | undefined,
  height: number | undefined,
  allowUnsafeMemoryOverride: boolean,
  signal?: AbortSignal
): Promise<{ bytes: Buffer; mime: string }> {
  const response = await checked(
    await fetch(`${server.endpoint}/images/generations`, {
      method: 'POST',
      headers: headers(server, 'application/json'),
      signal,
      body: JSON.stringify({
        model: server.selectedModel,
        prompt,
        ...(width && height ? { size: `${width}x${height}` } : {}),
        allow_unsafe_memory_override: allowUnsafeMemoryOverride
      })
    })
  )
  const body = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>
  }
  const value = body.data?.[0]?.url ?? (body.data?.[0]?.b64_json ? `data:image/png;base64,${body.data[0].b64_json}` : undefined)
  if (!value) throw new Error('The remote server returned no image.')
  if (value.startsWith('data:')) return decodeImageDataUrl(value)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The remote server returned an unsupported image URL.')
  // The provider token must never be forwarded to a returned media URL.
  const image = await checked(await fetch(url, { signal }))
  const mime = (image.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('The remote server returned an unsupported image format.')
  const bytes = Buffer.from(await image.arrayBuffer())
  if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('The remote server returned an invalid image size.')
  return { bytes, mime }
}

export async function synthesizeRemoteVoice(
  server: RemoteServer,
  text: string,
  voice?: string
): Promise<{ dataUrl: string }> {
  const response = await checked(
    await fetch(`${server.endpoint}/audio/speech`, {
      method: 'POST',
      headers: headers(server, 'application/json'),
      body: JSON.stringify({
        model: server.selectedModel,
        input: text,
        ...(voice ? { voice } : {}),
        ...(server.provider === 'openrouter' ? { response_format: 'mp3' } : {})
      })
    })
  )
  const mime = response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
  return { dataUrl: `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}` }
}

export async function transcribeRemoteAudio(
  server: RemoteServer,
  audioPath: string,
  language?: string,
  signal?: AbortSignal
): Promise<{ text: string; language?: string }> {
  const form = new FormData()
  form.append('model', server.selectedModel)
  if (language && language !== 'auto') form.append('language', language)
  const bytes = await fs.promises.readFile(audioPath)
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), path.basename(audioPath))
  const response = await checked(await fetch(`${server.endpoint}/audio/transcriptions`, {
    method: 'POST',
    headers: headers(server),
    body: form,
    signal
  }))
  const result = await response.json() as { text?: string; language?: string }
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('The remote server returned no transcript.')
  return { text: result.text.trim(), language: result.language }
}

/** OGAD owns the asynchronous job. Always fetch bytes from its authenticated
 * content endpoint; never forward credentials to a URL from a response. */
export async function generateRemoteVideo(
  server: RemoteServer,
  request: import('@offgrid/models').ResolvedVideoRequest,
  output: string,
  signal: AbortSignal,
  onProgress?: (progress: VideoGenerationProgressContract | null, stage?: VideoGenerationStage, preview?: { path: string; width: number; height: number }) => void
): Promise<void> {
  if (server.provider !== 'ogad')
    throw new Error('Remote video generation requires an OGAD server.')
  const { randomUUID } = await import('node:crypto')
  const { Readable, Transform } = await import('node:stream')
  const { pipeline } = await import('node:stream/promises')
  const { setTimeout: delay } = await import('node:timers/promises')
  const id = randomUUID()
  const endpoint = `${server.endpoint}/videos/${id}`
  let previewDownloaded = false
  const cancel = (): void => {
    void fetch(`${endpoint}/cancel`, {
      method: 'POST',
      headers: headers(server),
      signal: AbortSignal.timeout(10_000)
    }).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    await checked(
      await fetch(`${server.endpoint}/videos`, {
        method: 'POST',
        headers: headers(server, 'application/json'),
        signal,
        body: JSON.stringify({
          ...request,
          model: server.selectedModel,
          enhancePrompt: false,
          client_job_id: id
        })
      })
    )
    for (;;) {
      signal.throwIfAborted()
      const response = await checked(await fetch(endpoint, { headers: headers(server), signal }))
      const job = (await response.json()) as {
        status: string
        stage?: VideoGenerationStage
        preview?: { width: number; height: number }
        error?: { message?: string }
        progress?: { step: number; total: number }
      }
      const progress =
        job.progress && Number.isFinite(job.progress.step) && Number.isFinite(job.progress.total)
          ? job.progress
          : null
      const stage =
        job.stage && ['enhancing', 'preparing', 'conditioning', 'generating', 'decoding', 'encoding'].includes(job.stage)
          ? job.stage
          : undefined
      if (progress || stage) onProgress?.(progress, stage)
      if (!previewDownloaded && job.preview && Number.isFinite(job.preview.width) && Number.isFinite(job.preview.height)) {
        try {
          const response = await fetch(`${endpoint}/preview`, {
            headers: headers(server),
            signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          })
          if (response.ok && response.body && response.headers.get('content-type')?.startsWith('image/png')) {
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                size += value.length
                if (size > 16 * 1024 * 1024) { await reader.cancel(); break }
                chunks.push(value)
              }
            } finally { reader.releaseLock() }
            if (size > 0 && size <= 16 * 1024 * 1024) {
              const path = `${output}.preview.png`
              await fs.promises.writeFile(path, Buffer.concat(chunks))
              previewDownloaded = true
              onProgress?.(progress, stage, { path, width: job.preview.width, height: job.preview.height })
            }
          }
        } catch {
          // A preview is optional; keep the authoritative remote job running.
          signal.throwIfAborted()
        }
      }
      if (job.status === 'failed' || job.status === 'cancelled')
        throw new Error(job.error?.message || 'Remote video generation failed.')
      if (job.status === 'completed') break
      await delay(1000, undefined, { signal })
    }
    const response = await checked(
      await fetch(`${endpoint}/content`, { headers: headers(server), signal })
    )
    if (!response.body) throw new Error('The OGAD server returned no video.')
    let bytes = 0
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        callback(
          bytes > 512 * 1024 * 1024 ? new Error('The video exceeds the download limit.') : null,
          chunk
        )
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      limit,
      fs.createWriteStream(output, { flags: 'wx' }),
      { signal }
    )
    if (!bytes) throw new Error('The OGAD server returned an empty video.')
  } catch (error) {
    cancel()
    await fs.promises.rm(output, { force: true })
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
