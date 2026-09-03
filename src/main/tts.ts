import { randomUUID } from 'node:crypto'
// Local text-to-speech through the pinned React Native ExecuTorch Kokoro runtime.
// The runtime lives in its own repository and runs as a child process, so it does
// not add another native inference engine to Electron's main process.

import {
  ExecutorchSpeechRuntime,
  prepareVoice,
  speechCapabilities,
  type DownloadProgress
} from '@offgrid/executorch-speech'
import { kokoroVoiceLabel, speechLanguageLabel, type RuntimeSpeechVoice } from '@offgrid/speech'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeDiagnosticLog } from './diagnostics-log'
import { modelsDir, resourceDirs } from './runtime-env'
import type { DesktopManagedRuntime } from './model-runtime-port'
import { DEFAULT_SPEECH_VOICE, resolveSpeechVoice } from '@offgrid/models'
import { generateDesktopOperation } from './desktop-generation'
import { registerDesktopVoiceProgress } from './generation-progress'

const LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  'en-us': 'en-US',
  'en-gb': 'en-GB'
}
const SUPPORTED_VOICES = new Set(speechCapabilities.voices.map(({ id }) => id))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function executablePath(): string {
  const candidates = [
    ...resourceDirs().map((root) => path.join(root, 'bin', 'executorch-speech')),
    path.resolve(process.cwd(), '../executorch-speech/native/bin/executorch-speech')
  ]
  const executable = candidates.find((candidate) => fs.existsSync(candidate))
  if (!executable) throw new Error('The local voice runtime is not installed in this build.')
  return executable
}

export interface TtsRuntimeState {
  installed: boolean
  ready: boolean
  error?: string
}

/** Publish native adapter readiness without projecting runtime assets into the generic model store. */
export function inspectTtsRuntimeState(): TtsRuntimeState {
  try {
    executablePath()
    return { installed: true, ready: true }
  } catch (error) {
    return { installed: false, ready: false, error: messageOf(error) }
  }
}

function cacheDirectory(): string {
  return path.join(modelsDir(), '.cache', 'executorch-speech')
}

function bundledCacheDirectory(): string | undefined {
  return [
    ...resourceDirs().map((root) => path.join(root, 'speech-assets')),
    path.resolve(process.cwd(), '../executorch-speech/generated/default-assets')
  ].find((candidate) => fs.existsSync(path.join(candidate, 'index.json')))
}

function runtime(): ExecutorchSpeechRuntime {
  return new ExecutorchSpeechRuntime(cacheDirectory(), executablePath(), bundledCacheDirectory())
}

let busy = false

/** ExecuTorch releases every model when its short-lived process exits. */
export const ttsRuntime: DesktopManagedRuntime = {
  modality: 'tts',
  evict: () => {},
  warm: () => {},
  release: () => {}
}

/** Runtime-owned catalogue. Listing it never downloads model assets. */
export async function listVoiceCatalog(
  onProgress?: (progress: number) => void
): Promise<RuntimeSpeechVoice[]> {
  const voices = speechCapabilities.voices.map(({ id, language }) => ({
    id,
    label: kokoroVoiceLabel(id),
    language: LANGUAGE_TAGS[language] ?? language,
    languageLabel: speechLanguageLabel(LANGUAGE_TAGS[language] ?? language)
  }))
  onProgress?.(100)
  return voices
}

export async function listVoices(onProgress?: (progress: number) => void): Promise<string[]> {
  return (await listVoiceCatalog(onProgress)).map(({ id }) => id)
}

/** Download and validate the selected voice once. Cached assets return immediately. */
export async function prepareVoiceAssets(
  voice: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<void> {
  await prepareVoice(cacheDirectory(), voice, onProgress, undefined, bundledCacheDirectory())
}

/** Synthesize speech for `text`; returns a WAV data URL. */
export async function synthesizeNative(
  text: string,
  voice?: string,
  options: {
    onProgress?: (progress: DownloadProgress) => void
    signal?: AbortSignal
  } = {}
): Promise<{ dataUrl: string }> {
  // Shared owns voice selection and stale-persistence recovery. This adapter owns only ExecuTorch I/O.
  const chosenVoice = resolveSpeechVoice({
    requested: voice,
    supported: SUPPORTED_VOICES,
    fallback: DEFAULT_SPEECH_VOICE
  })
  const input = (text || '').trim()
  if (!input) throw new Error('Nothing to speak.')
  if (busy) throw new Error('Already generating speech. Please wait.')

  busy = true
  const requestId = `speak-${process.pid}-${Date.now()}`
  const outputPath = path.join(os.tmpdir(), `offgrid-tts-${requestId}.wav`)
  const startedAt = Date.now()
  writeDiagnosticLog('tts', 'request.started', {
    requestId,
    chars: input.length,
    engine: 'executorch'
  })

  try {
    await runtime().synthesize({
      text: input.slice(0, 2000),
      voiceId: chosenVoice,
      outputPath,
      onDownloadProgress: options.onProgress,
      signal: options.signal
    })
    const wav = await fs.promises.readFile(outputPath)
    if (wav.length <= 44) throw new Error('The local voice runtime returned empty audio.')
    writeDiagnosticLog('tts', 'request.completed', {
      requestId,
      durationMs: Date.now() - startedAt,
      wavBytes: wav.length
    })
    return { dataUrl: `data:audio/wav;base64,${wav.toString('base64')}` }
  } catch (error) {
    writeDiagnosticLog(
      'tts',
      'request.failed',
      { requestId, durationMs: Date.now() - startedAt, error: messageOf(error) },
      'error'
    )
    throw error
  } finally {
    busy = false
    void fs.promises.unlink(outputPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      writeDiagnosticLog(
        'tts',
        'request.cleanup_failed',
        { requestId, path: outputPath, error: messageOf(error) },
        'error'
      )
    })
  }
}

export async function synthesize(
  text: string,
  voice?: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<{ dataUrl: string }> {
  const turnId = `desktop-voice:${randomUUID()}`
  const unregister = onProgress ? registerDesktopVoiceProgress(turnId, onProgress) : undefined
  try {
    const result = await generateDesktopOperation(
      { type: 'voice', text, voice },
      {
        profile: 'voice-synthesis',
        identity: { conversationId: turnId, turnId }
      }
    )
    if (result.output.type !== 'voice') throw new Error('The voice engine returned no audio.')
    const audio = result.output.audio
    return {
      dataUrl: audio.data ? `data:${audio.mimeType};base64,${audio.data}` : (audio.uri ?? '')
    }
  } finally {
    unregister?.()
  }
}
