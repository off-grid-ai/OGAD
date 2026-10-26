import fs from 'node:fs'
import path from 'node:path'
import {
  kokoroVoiceLanguage,
  kokoroVoiceLabel,
  speechLanguageLabel,
  type RuntimeSpeechVoice
} from '@offgrid/speech'
import { IMAGE_MEMORY_GUARD_ERROR_CODE, imageMemoryGuardErrorMessage } from '../shared/image-generation-contract'
import { getActiveRemoteVisionServerForModality } from './vision/remote-vision-server'

export type RemoteServer = NonNullable<ReturnType<typeof getActiveRemoteVisionServerForModality>>

let cachedRemoteVoices: { key: string; expiresAt: number; voices: RuntimeSpeechVoice[] } | undefined

/** Speakers of the selected remote speech model. An Off Grid gateway lists them at
 * `/audio/voices`; OpenRouter and other OpenAI-compatible servers put them on the model's
 * catalog entry (`supported_voices`, or `voices` as an Off Grid gateway also does). A
 * compatible server without catalog speakers may still serve `/audio/voices`. */
export async function listRemoteVoices(server: RemoteServer): Promise<RuntimeSpeechVoice[]> {
  const key = `${server.id}:${server.endpoint}:${server.selectedModel}`
  if (cachedRemoteVoices?.key === key && cachedRemoteVoices.expiresAt > Date.now()) {
    return cachedRemoteVoices.voices
  }
  const ids =
    server.provider === 'ogad' ? await audioVoiceIds(server) : await catalogVoiceIds(server)
  const voices = ids.map((id) => remoteSpeechVoice(server.selectedModel, id))
  cachedRemoteVoices = { key, voices, expiresAt: Date.now() + 5 * 60_000 }
  return voices
}

function voiceIds(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).filter(
    (id): id is string => typeof id === 'string' && !!id
  )
}

async function audioVoiceIds(server: RemoteServer): Promise<string[]> {
  const response = await checked(
    await fetch(`${server.endpoint}/audio/voices`, { headers: headers(server) })
  )
  return voiceIds(((await response.json()) as { voices?: unknown }).voices)
}

async function catalogVoiceIds(server: RemoteServer): Promise<string[]> {
  let ids: string[] = []
  try {
    const response = await checked(
      await fetch(`${server.endpoint}/models?output_modalities=speech`, {
        headers: headers(server)
      })
    )
    const catalog = (await response.json()) as {
      data?: Array<{ id?: unknown; supported_voices?: unknown; voices?: unknown }>
    }
    const model = catalog.data?.find((item) => item.id === server.selectedModel)
    ids = voiceIds(model?.supported_voices)
    if (!ids.length) ids = voiceIds(model?.voices)
  } catch (error) {
    if (server.provider === 'openrouter') throw error
  }
  if (ids.length || server.provider === 'openrouter') return ids
  // A compatible server that does not list speakers has none to offer; speech still works.
  return audioVoiceIds(server).catch(() => [])
}

function remoteSpeechVoice(model: string, id: string): RuntimeSpeechVoice {
  if (/kokoro/i.test(model)) {
    const language = kokoroVoiceLanguage(id)
    return {
      id,
      label: kokoroVoiceLabel(id),
      ...(language ? { language: language.code, languageLabel: language.label } : {})
    }
  }
  const language = model.startsWith('deepgram/')
    ? id.match(/-([a-z]{2})$/i)?.[1]?.toLowerCase()
    : model.startsWith('microsoft/mai-voice-2')
      ? id.match(/^([a-z]{2}-[A-Z]{2})-/)?.[1]
      : model.startsWith('mistralai/voxtral-mini-tts')
        ? id.match(/^([a-z]{2})_/i)?.[1]?.toLowerCase().replace(/^gb$/, 'en-GB')
        : undefined
  return {
    id,
    label: id
      .replace(/^flux-/, '')
      .replace(/-en$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    ...(language ? { language, languageLabel: speechLanguageLabel(language) } : {})
  }
}

export function headers(server: RemoteServer, contentType?: string): Record<string, string> {
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
    throw new Error(
      imageMemoryGuardErrorMessage(message.replace(`${IMAGE_MEMORY_GUARD_ERROR_CODE}:`, '').trim())
    )
  }
  throw new Error(message)
}

export async function checked(response: Response): Promise<Response> {
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
  signal?: AbortSignal,
  initImage?: string,
  parameters?: { steps?: number; cfgScale?: number; seed?: number; negativePrompt?: string }
): Promise<{ bytes: Buffer; mime: string }> {
  const fields = {
    model: server.selectedModel,
    prompt,
    ...(width && height ? { size: `${width}x${height}` } : {}),
    ...(parameters?.steps !== undefined ? { steps: parameters.steps } : {}),
    ...(parameters?.cfgScale !== undefined ? { cfg_scale: parameters.cfgScale } : {}),
    ...(parameters?.seed !== undefined ? { seed: parameters.seed } : {}),
    ...(parameters?.negativePrompt ? { negative_prompt: parameters.negativePrompt } : {}),
    allow_unsafe_memory_override: allowUnsafeMemoryOverride
  }
  let requestBody: string | FormData = JSON.stringify(fields)
  if (initImage) {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value))
    const bytes = await fs.promises.readFile(initImage)
    const extension = path.extname(initImage).toLowerCase()
    const mime =
      extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.webp'
          ? 'image/webp'
          : 'image/png'
    form.append('image', new Blob([bytes], { type: mime }), path.basename(initImage))
    requestBody = form
  }
  const response = await checked(
    await fetch(`${server.endpoint}/images/${initImage ? 'edits' : 'generations'}`, {
      method: 'POST',
      headers: headers(server, initImage ? undefined : 'application/json'),
      signal,
      body: requestBody
    })
  )
  const body = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>
  }
  const value =
    body.data?.[0]?.url ??
    (body.data?.[0]?.b64_json ? `data:image/png;base64,${body.data[0].b64_json}` : undefined)
  if (!value) throw new Error('The remote server returned no image.')
  if (value.startsWith('data:')) return decodeImageDataUrl(value)
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('The remote server returned an unsupported image URL.')
  // The provider token must never be forwarded to a returned media URL.
  const image = await checked(await fetch(url, { signal }))
  const mime = (image.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase()
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime))
    throw new Error('The remote server returned an unsupported image format.')
  const bytes = Buffer.from(await image.arrayBuffer())
  if (!bytes.length || bytes.length > 50 * 1024 * 1024)
    throw new Error('The remote server returned an invalid image size.')
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
  return {
    dataUrl: `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  }
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
  form.append(
    'file',
    new Blob([bytes], { type: 'application/octet-stream' }),
    path.basename(audioPath)
  )
  const response = await checked(
    await fetch(`${server.endpoint}/audio/transcriptions`, {
      method: 'POST',
      headers: headers(server),
      body: form,
      signal
    })
  )
  const result = (await response.json()) as { text?: string; language?: string }
  if (typeof result.text !== 'string' || !result.text.trim())
    throw new Error('The remote server returned no transcript.')
  return { text: result.text.trim(), language: result.language }
}
