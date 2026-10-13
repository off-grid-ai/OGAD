import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  AudioSpeakResponse,
  AudioTranscribeResponse,
  AudioVoicesResponse
} from './bridge-media-protocol'
import {
  fitsSealedResponse,
  MAX_SPEAK_TEXT_CHARS,
  MAX_TRANSCRIBE_AUDIO_BYTES
} from './bridge-limits'

const AUDIO_TYPES: Readonly<Record<string, string | undefined>> = {
  'audio/webm': '.webm',
  'audio/webm;codecs=opus': '.webm',
  'audio/ogg': '.ogg',
  'audio/ogg;codecs=opus': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac'
}

function decodeAudio(raw: unknown): Buffer {
  if (typeof raw !== 'string' || !raw) {
    throw new Error('invalid audio base64')
  }
  if (raw.length > 4 * Math.ceil(MAX_TRANSCRIBE_AUDIO_BYTES / 3)) {
    throw new Error(`Audio too large. Maximum ${MAX_TRANSCRIBE_AUDIO_BYTES} decoded bytes.`)
  }
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new Error('invalid audio base64')
  }
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.toString('base64') !== raw) {
    throw new Error('invalid audio base64')
  }
  if (decoded.length > MAX_TRANSCRIBE_AUDIO_BYTES) {
    throw new Error(`Audio too large. Maximum ${MAX_TRANSCRIBE_AUDIO_BYTES} decoded bytes.`)
  }
  return decoded
}

export async function readAudioVoices(): Promise<AudioVoicesResponse> {
  const tts = await import('../tts')
  return { voices: await tts.listVoices() }
}

export async function transcribeBridgeAudio(
  params: Record<string, unknown>
): Promise<AudioTranscribeResponse> {
  if (Object.keys(params).some((key) => !['audio', 'mimeType'].includes(key))) {
    throw new Error('invalid')
  }
  const extension =
    typeof params.mimeType === 'string' && Object.hasOwn(AUDIO_TYPES, params.mimeType)
      ? AUDIO_TYPES[params.mimeType]
      : undefined
  if (!extension) {
    throw new Error('invalid audio mimeType')
  }
  const audio = decodeAudio(params.audio)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-bridge-stt-'))
  try {
    const file = path.join(directory, `audio${extension}`)
    await fs.writeFile(file, audio, { mode: 0o600 })
    const { getActiveTranscription } = await import('../transcription/select')
    const { transcriptionRequestOptions } = await import('../model-server/transcription-request')
    const result = await getActiveTranscription().transcribe(
      { path: file },
      transcriptionRequestOptions({})
    )
    return { text: result.text.trim() }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

export async function speakBridgeAudio(
  params: Record<string, unknown>
): Promise<AudioSpeakResponse> {
  if (
    Object.keys(params).some((key) => !['text', 'voice'].includes(key)) ||
    typeof params.text !== 'string' ||
    !params.text.trim()
  ) {
    throw new Error('invalid')
  }
  if (params.text.length > MAX_SPEAK_TEXT_CHARS) {
    throw new Error(`Text too long. Maximum ${MAX_SPEAK_TEXT_CHARS} characters.`)
  }
  if (
    params.voice !== undefined &&
    (typeof params.voice !== 'string' || !/^[\w.-]{1,64}$/.test(params.voice))
  ) {
    throw new Error('invalid voice')
  }
  const tts = await import('../tts')
  const { dataUrl } = await tts.synthesize(params.text.trim(), params.voice as string | undefined)
  const match = /^data:(audio\/[\w.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl)
  if (!match) {
    throw new Error('Invalid speech audio response.')
  }
  const result = { audio: match[2]!, mimeType: match[1]! }
  if (!fitsSealedResponse(result)) {
    throw new Error('Speech audio too large for the sealed response.')
  }
  return result
}
