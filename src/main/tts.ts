import { withStorageDownload } from './model-storage-guard'
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
import {
  kokoroVoiceLabel,
  speechLanguageLabel,
  joinPcmWavs,
  speechChunks,
  spokenText,
  type RuntimeSpeechVoice
} from '@offgrid/speech'
import fs from 'fs'
import { createHash } from 'node:crypto'
import { recordAIRequest } from './ai-request-log'
import os from 'os'
import path from 'path'
import { getActiveModal } from './active-models'
import { getActiveRemoteVisionServerForModality } from './vision/remote-vision-server'
import { listRemoteVoices, synthesizeRemoteVoice } from './remote-media-runtime'
import { writeDiagnosticLog } from './diagnostics-log'
import { modelsDir, requireModelStorage, resourceDirs } from './runtime-env'
import { modelReadDirectories, resolveIndexedModelPackage } from './model-paths'
import type { ManagedRuntime } from './runtime-manager'
import { modalityQueue, SPEECH_JOB } from './modality-queue/queue'
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

function cacheDirectory(voice: string): string {
  const assets = Object.entries(
    speechCapabilities.voices.find((entry) => entry.id === voice)?.assets ?? {}
  )
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([asset, url]) => ({
      name: `${asset}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}-${path.basename(new URL(url).pathname)}`,
      url
    }))
  const bundled = bundledCacheDirectory()
  const cached =
    assets.length &&
    resolveIndexedModelPackage(assets, [
      ...modelReadDirectories().map((root) => path.join(root, '.cache', 'executorch-speech')),
      ...(bundled ? [bundled] : [])
    ])
  if (cached) return cached
  requireModelStorage()
  return path.join(modelsDir(), '.cache', 'executorch-speech')
}

function bundledCacheDirectory(): string | undefined {
  return [
    ...modelReadDirectories()
      .filter((root) => root !== modelsDir())
      .map((root) => path.join(root, '.cache', 'executorch-speech')),
    ...resourceDirs().map((root) => path.join(root, 'speech-assets')),
    path.resolve(process.cwd(), '../executorch-speech/generated/default-assets')
  ].find((candidate) => fs.existsSync(path.join(candidate, 'index.json')))
}

function runtime(voice: string): ExecutorchSpeechRuntime {
  return new ExecutorchSpeechRuntime(
    cacheDirectory(voice),
    executablePath(),
    bundledCacheDirectory()
  )
}

async function synthesizeExecutorch(input: Parameters<ExecutorchSpeechRuntime['synthesize']>[0]): Promise<void> {
  await onnxSpeech.close()
  const status = beginRuntimeBackend('speech', 'Kokoro')
  try {
    // This bundled native target links the XNNPACK CPU backend only.
    status.ready('CPU (ExecuTorch)')
    await runtime(input.voiceId).synthesize(input)
  } catch (error) {
    status.fail(error)
    throw error
  } finally { status.stop() }
}

let busy = false

/** The ONNX worker owns accelerated model memory and can be terminated on eviction. */
/** Kokoro's resident cost in MB (the Settings note: on-demand frees about 330 MB). */
const KOKORO_MB = 330

export const ttsRuntime: ManagedRuntime = {
  modality: 'tts',
  footprintMB: () => (onnxSpeech.isLoaded() ? KOKORO_MB : 0),
  expectedMB: () => KOKORO_MB,
  evict: () => onnxSpeech.close(),
  release: () => onnxSpeech.close()
}

/** Runtime-owned catalogue. Listing it never downloads model assets. */
export async function listVoiceCatalog(
  onProgress?: (progress: number) => void
): Promise<RuntimeSpeechVoice[]> {
  const remote = getActiveRemoteVisionServerForModality('voice')
  // Every remote provider owns its speakers; the remote model, not this machine, decides them.
  if (remote) return listRemoteVoices(remote)
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
  return withStorageDownload(() => prepareVoiceAssetsInner(voice, onProgress))
}

async function prepareVoiceAssetsInner(
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
  await prepareVoice(cacheDirectory(voice), voice, onProgress, undefined, bundledCacheDirectory())
}

/** One finished speech pass: the voice can start on pass 0 while the rest is still being made. */
export interface SpeechPass {
  readonly index: number
  readonly count: number
  readonly dataUrl: string
}

interface SynthesizeOptions {
  /** This machine's own voices, even when a remote voice is chosen (a WAV, always). */
  readonly local?: boolean
  /** Each local pass as it is ready, before the joined clip resolves. */
  readonly onPass?: (pass: SpeechPass) => void
}

/** Synthesize speech for `text`; returns a WAV data URL. */
export async function synthesize(
  text: string,
  voice?: string,
  onProgress?: (progress: DownloadProgress) => void,
  options: SynthesizeOptions = {}
): Promise<{ dataUrl: string }> {
  const requestedAt = Date.now()
  // First synthesis can download assets even without an explicit Prepare request. A queue job, so
  // no background model pass starts while the listener waits for this voice.
  return modalityQueue.run(SPEECH_JOB, () =>
    withStorageDownload(() => synthesizeInner(text, voice, onProgress, options, requestedAt))
  )
}

const wavDataUrl = (wav: Uint8Array): string =>
  `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`

/**
 * Kokoro reads at most ~510 phoneme tokens at once and drops the rest, so a reply is spoken in
 * passes (`speechChunks`) and joined into one WAV at `outputPath`. Pass 0 is the first sentence
 * alone, handed to `onPass` as soon as it is ready so the voice can start. Returns the device used
 * and when the first pass was ready.
 */
async function synthesizeOnnxPasses(input: {
  readonly text: string
  readonly voice: string
  readonly outputPath: string
  readonly onProgress?: (progress: DownloadProgress) => void
  readonly onPass?: (pass: SpeechPass) => void
}): Promise<{ device: string; passes: number; firstPassAt: number }> {
  const passes = speechChunks(input.text)
  if (passes.length === 0) throw new Error('Nothing to speak.')
  const wavs: Uint8Array[] = []
  let device = 'cpu'
  let firstPassAt = 0
  try {
    for (const [index, text] of passes.entries()) {
      const passPath = `${input.outputPath}.${index}.wav`
      device = await onnxSpeech.synthesize({
        text,
        voice: input.voice,
        outputPath: passPath,
        onProgress: input.onProgress
      })
      const wav = await fs.promises.readFile(passPath)
      wavs.push(wav)
      if (index === 0) firstPassAt = Date.now()
      if (passes.length > 1)
        input.onPass?.({ index, count: passes.length, dataUrl: wavDataUrl(wav) })
    }
  } finally {
    await Promise.all(
      passes.map((_, index) =>
        fs.promises.unlink(`${input.outputPath}.${index}.wav`).catch(() => {})
      )
    )
  }
  const joined = wavs.length === 1 ? wavs[0] : joinPcmWavs(wavs)
  if (!joined) throw new Error('Speech passes could not be joined into one clip.')
  await fs.promises.writeFile(input.outputPath, joined)
  return { device, passes: passes.length, firstPassAt }
}

async function synthesizeInner(
  text: string,
  voice: string | undefined,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  options: SynthesizeOptions,
  requestedAt: number
): Promise<{ dataUrl: string }> {
  return recordAIRequest(
    { modality: 'tts', source: 'Speech synthesis', request: { text, voice } },
    async (log) => {
      // Every voice, local or remote, speaks the same words: emoji are not read aloud.
      const spoken = spokenText(text || '')
      if (!spoken) throw new Error('Nothing to speak.')
      const remote = options.local ? null : getActiveRemoteVisionServerForModality('voice')
      if (remote) {
        log.update({ model: remote.selectedModel, backend: 'Remote' })
        if (remote.provider !== 'openrouter') return synthesizeRemoteVoice(remote, spoken, voice)
        const voices = await listRemoteVoices(remote)
        const chosenVoice = voices.find((candidate) => candidate.id === voice)?.id ?? voices[0]?.id
        if (!chosenVoice) throw new Error('This remote model has no available speakers.')
        log.update({ effectiveRequest: { text: spoken, voice: chosenVoice } })
        return synthesizeRemoteVoice(remote, spoken, chosenVoice)
      }
      const selected = getActiveModal('speech')
      const requestedVoice = chooseVoice(voice, selected) || DEFAULT_VOICE
      // Older releases persisted Kokoro voices that the ExecuTorch catalogue does not contain.
      // Keep those profiles able to speak after upgrade; the runtime manifest remains the voice SSOT.
      const chosenVoice = SUPPORTED_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_VOICE
      const input = spoken
      log.update({
        model: selected ?? 'Kokoro',
        effectiveRequest: { text: input.slice(0, 2000), voice: chosenVoice }
      })
      if (busy) throw new Error('Already generating speech. Please wait.')

      busy = true
      const requestId = `speak-${process.pid}-${Date.now()}`
      const outputPath = path.join(os.tmpdir(), `offgrid-tts-${requestId}.wav`)
      const startedAt = Date.now()
      writeDiagnosticLog('tts', 'request.started', {
        requestId,
        chars: input.length,
        // Time spent waiting for the speech slot (another voice or dictation ahead of it).
        queuedMs: startedAt - requestedAt,
        engine: ONNX_VOICES.has(chosenVoice) ? 'onnxruntime' : 'executorch'
      })

      try {
        let engine = 'executorch'
        let device = 'cpu'
        let passes = 1
        let firstPassAt = 0
        if (ONNX_VOICES.has(chosenVoice)) {
          try {
            const result = await recordAIRequest(
              {
                modality: 'tts',
                source: 'ONNX speech attempt',
                model: selected ?? 'Kokoro',
                request: { text: input.slice(0, 2000), voice: chosenVoice }
              },
              async (attempt) => {
                const done = await synthesizeOnnxPasses({
                  text: input,
                  voice: chosenVoice,
                  outputPath,
                  onProgress,
                  onPass: options.onPass
                })
                attempt.update({ backend: done.device })
                return done
              }
            )
            device = result.device
            passes = result.passes
            firstPassAt = result.firstPassAt
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
          // Request to first playable audio: the wait the listener actually feels. Only a caller
          // that takes passes hears the first one early; the rest wait for the whole clip.
          firstAudioMs: (options.onPass && passes > 1 ? firstPassAt : Date.now()) - requestedAt,
          passes,
          wavBytes: wav.length,
          engine,
          device
        })
        return { dataUrl: wavDataUrl(wav) }
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
