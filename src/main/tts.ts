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
import { getActiveModal } from './active-models'
import { writeDiagnosticLog } from './diagnostics-log'
import { modelsDir, resourceDirs } from './runtime-env'
import type { ManagedRuntimePort as ManagedRuntime } from '@offgrid/models'
import { chooseVoice, DEFAULT_VOICE } from './tts-logic'
import { generateDesktopOperation } from './desktop-generation'
import { registerDesktopVoiceProgress } from './model-generation-adapters'

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
export const ttsRuntime: ManagedRuntime = {
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
  onProgress?: (progress: DownloadProgress) => void
): Promise<{ dataUrl: string }> {
  const selected = getActiveModal('speech')
  const requestedVoice = chooseVoice(voice, selected) || DEFAULT_VOICE
  // Older releases persisted Kokoro voices that the ExecuTorch catalogue does not contain.
  // Keep those profiles able to speak after upgrade; the runtime manifest remains the voice SSOT.
  const chosenVoice = SUPPORTED_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_VOICE
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
      onDownloadProgress: onProgress
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
    void fs.promises.unlink(outputPath).catch(() => {})
  }
}

export async function synthesize(
  text: string,
  voice?: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<{ dataUrl: string }> {
  const turnId = `desktop-voice:${Date.now()}:${Math.random().toString(36).slice(2)}`
  const unregister = onProgress ? registerDesktopVoiceProgress(turnId, onProgress) : undefined
  try {
    const result = await generateDesktopOperation(
      { type: 'voice', text, voice },
      {
        identity: { conversationId: turnId, turnId },
        timeoutMs: 10 * 60 * 1000,
        allowFallback: false
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
