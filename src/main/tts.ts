import { beginRuntimeBackend } from './runtime-backends'
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
import { recordAIRequest } from './ai-request-log'
import os from 'os'
import path from 'path'
import { getActiveModal } from './active-models'
import { getActiveRemoteVisionServerForModality } from './vision/remote-vision-server'
import { listRemoteVoices, synthesizeRemoteVoice } from './remote-media-runtime'
import { writeDiagnosticLog } from './diagnostics-log'
import { modelsDir, requireModelStorage, resourceDirs } from './runtime-env'
import type { ManagedRuntime } from './runtime-manager'
import { chooseVoice, DEFAULT_VOICE } from './tts-logic'
import { OnnxSpeechRuntime } from './tts-onnx'

const LANGUAGE_TAGS: Readonly<Record<string, string>> = {
  'en-us': 'en-US',
  'en-gb': 'en-GB'
}
const SUPPORTED_VOICES = new Set(speechCapabilities.voices.map(({ id }) => id))
const ONNX_VOICES = new Set(
  speechCapabilities.voices
    .filter(({ language }) => language === 'en-us' || language === 'en-gb')
    .map(({ id }) => id)
)
const onnxSpeech = new OnnxSpeechRuntime()

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
  requireModelStorage()
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

async function synthesizeExecutorch(input: Parameters<ExecutorchSpeechRuntime['synthesize']>[0]): Promise<void> {
  await onnxSpeech.close()
  const status = beginRuntimeBackend('speech', 'Kokoro')
  try {
    // This bundled native target links the XNNPACK CPU backend only.
    status.ready('CPU (ExecuTorch)')
    await runtime().synthesize(input)
  } catch (error) {
    status.fail(error)
    throw error
  } finally { status.stop() }
}

let busy = false

/** The ONNX worker owns accelerated model memory and can be terminated on eviction. */
export const ttsRuntime: ManagedRuntime = {
  modality: 'tts',
  evict: () => onnxSpeech.close(),
  warm: () => onnxSpeech.prepare(DEFAULT_VOICE).then(() => undefined),
  release: () => onnxSpeech.close()
}

/** Runtime-owned catalogue. Listing it never downloads model assets. */
export async function listVoiceCatalog(
  onProgress?: (progress: number) => void
): Promise<RuntimeSpeechVoice[]> {
  const remote = getActiveRemoteVisionServerForModality('voice')
  if (remote) return remote.provider === 'openrouter' ? listRemoteVoices(remote) : []
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
  if (ONNX_VOICES.has(voice)) {
    try {
      await onnxSpeech.prepare(voice, onProgress)
      return
    } catch (error) {
      writeDiagnosticLog('tts', 'onnx.prepare.failed', { error: messageOf(error) }, 'warn')
    }
  }
  await prepareVoice(cacheDirectory(), voice, onProgress, undefined, bundledCacheDirectory())
}

/** Synthesize speech for `text`; returns a WAV data URL. */
export async function synthesize(
  text: string,
  voice?: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<{ dataUrl: string }> {
  return recordAIRequest(
    { modality: 'tts', source: 'Speech synthesis', request: { text, voice } },
    async (log) => {
      const remote = getActiveRemoteVisionServerForModality('voice')
      if (remote) {
        log.update({ model: remote.selectedModel, backend: 'Remote' })
        if (remote.provider !== 'openrouter') return synthesizeRemoteVoice(remote, text, voice)
        const voices = await listRemoteVoices(remote)
        const chosenVoice = voices.find((candidate) => candidate.id === voice)?.id ?? voices[0]?.id
        if (!chosenVoice) throw new Error('This remote model has no available speakers.')
        log.update({ effectiveRequest: { text, voice: chosenVoice } })
        return synthesizeRemoteVoice(remote, text, chosenVoice)
      }
      const selected = getActiveModal('speech')
      const requestedVoice = chooseVoice(voice, selected) || DEFAULT_VOICE
      // Older releases persisted Kokoro voices that the ExecuTorch catalogue does not contain.
      // Keep those profiles able to speak after upgrade; the runtime manifest remains the voice SSOT.
      const chosenVoice = SUPPORTED_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_VOICE
      const input = (text || '').trim()
      log.update({
        model: selected ?? 'Kokoro',
        effectiveRequest: { text: input.slice(0, 2000), voice: chosenVoice }
      })
      if (!input) throw new Error('Nothing to speak.')
      if (busy) throw new Error('Already generating speech. Please wait.')

      busy = true
      const requestId = `speak-${process.pid}-${Date.now()}`
      const outputPath = path.join(os.tmpdir(), `offgrid-tts-${requestId}.wav`)
      const startedAt = Date.now()
      writeDiagnosticLog('tts', 'request.started', {
        requestId,
        chars: input.length,
        engine: ONNX_VOICES.has(chosenVoice) ? 'onnxruntime' : 'executorch'
      })

      try {
        let engine = 'executorch'
        let device = 'cpu'
        if (ONNX_VOICES.has(chosenVoice)) {
          try {
            device = await recordAIRequest(
              {
                modality: 'tts',
                source: 'ONNX speech attempt',
                model: selected ?? 'Kokoro',
                request: { text: input.slice(0, 2000), voice: chosenVoice }
              },
              async (attempt) => {
                const usedDevice = await onnxSpeech.synthesize({
                  text: input.slice(0, 2000),
                  voice: chosenVoice,
                  outputPath,
                  onProgress
                })
                attempt.update({ backend: usedDevice })
                return usedDevice
              }
            )
            engine = 'onnxruntime'
          } catch (error) {
            writeDiagnosticLog(
              'tts',
              'onnx.fallback',
              { requestId, error: messageOf(error) },
              'warn'
            )
            await synthesizeExecutorch({
              text: input.slice(0, 2000),
              voiceId: chosenVoice,
              outputPath,
              onDownloadProgress: onProgress
            })
          }
        } else {
          await synthesizeExecutorch({
            text: input.slice(0, 2000),
            voiceId: chosenVoice,
            outputPath,
            onDownloadProgress: onProgress
          })
        }
        const wav = await fs.promises.readFile(outputPath)
        log.update({
          backend: device,
          metrics: { engine, durationMs: Date.now() - startedAt, wavBytes: wav.length }
        })
        if (wav.length <= 44) throw new Error('The local voice runtime returned empty audio.')
        writeDiagnosticLog('tts', 'request.completed', {
          requestId,
          durationMs: Date.now() - startedAt,
          wavBytes: wav.length,
          engine,
          device
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
  )
}
