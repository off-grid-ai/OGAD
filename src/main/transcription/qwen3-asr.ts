// Qwen3-ASR speech-to-text on the llama.cpp server the app already ships (llama.cpp b8769+ has the
// `qwen3a` audio projector, PR #19441). One resident llama-server holds the model and its audio
// projector, on its own port beside chat, and stops after five idle minutes like the resident
// whisper-server. Audio is decoded to 16 kHz mono WAV by the bundled ffmpeg and sent in pieces of at
// most 30 seconds (chunk.ts), each as a chat request whose only content is the audio.
//
// The model answers `language English<asr_text>the words`. A language the person pinned is passed
// the way Qwen's own toolkit passes it: by starting the answer with `language <Name><asr_text>`.

import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Mutex } from 'async-mutex'
import { transcriptionLanguages } from '@offgrid/speech'
import { recordAIRequest } from '../ai-request-log'
import { getActiveModal } from '../active-models'
import { DedicatedLlamaRuntime } from '../llm/dedicated-llama-runtime'
import { modelReadDirectories } from '../model-paths'
import { filesMB } from '../model-footprint'
import { binRoots, exe } from '../runtime-env'
import { joinChunkTexts, splitWav } from './chunk'
import { modelsByEngine } from './classify'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import { runNativeTranscriptionProcess } from './native-process'
import { activeMatchesEntry } from './parakeet-cli'
import type { Transcript, TranscribeOptions, TranscriptionService } from './types'
import { ffmpegBin } from './whisper-cli'

// Off chat (8439), image (8440), whisper-server (8441), grounding (8489) and decision (8459).
const QWEN3_ASR_PORT = 8442
/** Qwen's model card decodes with max_new_tokens 1024; 30 s of speech is far fewer tokens. */
const MAX_TOKENS = 1024
/** 30 s of audio is about 400 audio tokens; with the answer this stays well inside 4096. */
const CONTEXT_TOKENS = 4096
const IDLE_MS = 5 * 60_000
const ANSWER_MARK = '<asr_text>'

export interface Qwen3AsrModel {
  id: string
  modelPath: string
  mmProjPath: string
}

/** The installed Qwen3-ASR model to use: the active pick first, else the first installed one. */
export function qwen3AsrModel(): Qwen3AsrModel | null {
  const entries = modelsByEngine('qwen3-asr')
  const active = getActiveModal('transcription')
  const ordered = [...entries].sort(
    (a, b) => Number(activeMatchesEntry(active, b)) - Number(activeMatchesEntry(active, a))
  )
  for (const entry of ordered) {
    const files = (entry as { files: Array<{ name: string; role?: string }> }).files
    const primary = files.find((file) => file.role !== 'mmproj')?.name
    const projector = files.find((file) => file.role === 'mmproj')?.name
    if (!primary || !projector) continue
    for (const dir of modelReadDirectories()) {
      const modelPath = path.join(dir, primary)
      const mmProjPath = path.join(dir, projector)
      if (fs.existsSync(modelPath) && fs.existsSync(mmProjPath))
        return { id: entry.id, modelPath, mmProjPath }
    }
  }
  return null
}

/** A llama-server is bundled (every desktop build ships one). */
function llamaServerInstalled(): boolean {
  return binRoots().some((root) =>
    ['llama', 'llama-cpu', 'llama-cuda', ''].some((folder) =>
      fs.existsSync(path.join(root, folder, exe('llama-server')))
    )
  )
}

/**
 * The chat request for one piece of audio: the audio alone in the user turn, greedy decoding, and
 * the pinned language (Qwen's own name for it) as the start of the answer. Pure.
 */
export function buildQwen3AsrRequest(
  wavBase64: string,
  pinnedLanguage?: string
): Record<string, unknown> {
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } }]
      },
      ...(pinnedLanguage
        ? [{ role: 'assistant', content: `language ${pinnedLanguage}${ANSWER_MARK}` }]
        : [])
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    stream: false
  }
}

/** The text and language from an answer: `language English<asr_text>the words`, or only the
 *  words when the request started the answer itself. Pure. */
export function parseQwen3AsrAnswer(content: string): { text: string; language?: string } {
  const at = content.indexOf(ANSWER_MARK)
  if (at < 0) return { text: content.trim() }
  const language = /language\s+([^<\s]+)/i.exec(content.slice(0, at))?.[1]
  return {
    text: content.slice(at + ANSWER_MARK.length).trim(),
    ...(language && language.toLowerCase() !== 'none' ? { language } : {})
  }
}

/** Qwen's name for a language code the person pinned (`en` -> `English`), none for auto. */
function languageName(code: string | undefined): string | undefined {
  if (!code || code === 'auto') return undefined
  return transcriptionLanguages('qwen3-asr').find((language) => language.code === code)?.label
}

class Qwen3AsrTranscription implements TranscriptionService {
  private modelId: string | null = null
  private paths: Qwen3AsrModel | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private readonly mutex = new Mutex()
  private readonly runtime = new DedicatedLlamaRuntime({
    id: 'transcription',
    label: 'Speech-to-text',
    modality: 'llm',
    port: QWEN3_ASR_PORT,
    readyTimeoutMs: 120_000,
    modelPaths: async () => {
      if (!this.paths) throw new Error('No Qwen3-ASR model is installed.')
      return { model: this.paths.id, ...this.paths }
    },
    extraArgs: () => ({
      effectiveCtxSize: CONTEXT_TOKENS,
      flashAttn: true,
      kvCacheType: 'f16',
      speculativeDecoding: 'off',
      threads: undefined,
      batchSize: undefined
    }),
    // Every piece of audio is new: llama-server's host prompt cache would only hold memory.
    argv: ['--cache-ram', '0']
  })

  isAvailable(): boolean {
    return llamaServerInstalled() && qwen3AsrModel() !== null
  }

  /** Memory the loaded model holds, in MB (weights, projector and a context allowance). */
  residentMB(): number {
    return this.runtime.isRunning && this.paths
      ? filesMB([this.paths.modelPath, this.paths.mmProjPath]) + 512
      : 0
  }

  stop(): void {
    this.clearIdle()
    void this.runtime.stop()
  }

  private clearIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
  }

  private async ensureUp(model: Qwen3AsrModel): Promise<void> {
    if (this.modelId !== model.id || this.paths?.modelPath !== model.modelPath) {
      await this.runtime.stop()
      this.modelId = model.id
      this.paths = model
    }
    await this.runtime.start()
  }

  private async transcribePiece(
    wavPath: string,
    language: string | undefined,
    signal?: AbortSignal
  ): Promise<{ text: string; language?: string }> {
    const audio = (await fs.promises.readFile(wavPath, { signal })).toString('base64')
    const name = languageName(language)
    this.runtime.recordRequest()
    const response = await fetch(`http://127.0.0.1:${this.runtime.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildQwen3AsrRequest(audio, name)),
      signal
    })
    if (!response.ok)
      throw new Error(
        `Qwen3-ASR could not transcribe the audio (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`
      )
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    const answer = parseQwen3AsrAnswer(body.choices?.[0]?.message?.content ?? '')
    return name ? { text: answer.text, language: name } : answer
  }

  async transcribe(input: { path: string }, opts: TranscribeOptions = {}): Promise<Transcript> {
    const model = qwen3AsrModel()
    return recordAIRequest(
      {
        modality: 'stt',
        source: 'Qwen3-ASR transcription',
        model: model?.id ?? 'Qwen3-ASR',
        request: { ...input, ...opts },
        signal: opts.signal
      },
      async (log) => {
        await log.inputFile(input.path)
        if (!model) throw new Error('No Qwen3-ASR model is installed.')
        const work = path.join(os.tmpdir(), `offgrid-qwen3-asr-${process.pid}-${randomUUID()}`)
        return this.mutex.runExclusive(async () => {
          this.clearIdle()
          try {
            let wav = input.path
            if (!opts.alreadyWav16k) {
              const ff = ffmpegBin()
              if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
              await fs.promises.mkdir(work, { recursive: true })
              wav = path.join(work, 'input.wav')
              await runNativeTranscriptionProcess(ff, decodeToWavArgs(input.path, wav), {
                timeout: DECODE_TIMEOUT_MS,
                signal: opts.signal
              })
            }
            const chunks = await splitWav(wav, path.join(work, 'chunks'))
            opts.signal?.throwIfAborted()
            await this.ensureUp(model)
            const texts: string[] = []
            let detected: string | undefined
            for (const chunk of chunks) {
              const piece = await this.transcribePiece(chunk.path, opts.language, opts.signal)
              texts.push(piece.text)
              detected ??= piece.language
            }
            const { text, segments } = joinChunkTexts(chunks, texts)
            const language =
              opts.language && opts.language !== 'auto'
                ? opts.language
                : transcriptionLanguages('qwen3-asr').find((item) => item.label === detected)?.code
            return opts.timestamps ? { text, segments, language } : { text, language }
          } finally {
            await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {})
            this.idle = setTimeout(() => this.stop(), IDLE_MS)
            this.idle.unref()
          }
        })
      }
    )
  }
}

/** Shared singleton — callers depend on the interface, not the class. */
export const qwen3AsrTranscription = new Qwen3AsrTranscription()
