import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  FilesPort,
  SpeechClock,
  SynthesizerPort,
  TranscriberPort,
  TranscriptionSource,
  Unsubscribe
} from '@offgrid/speech'
import { getActiveTranscription } from '../transcription/select'
import { inspectTtsRuntimeState, synthesizeNative } from '../tts'

export interface DesktopSpeechIoPorts {
  transcriber: TranscriberPort
  synthesizer: SynthesizerPort
  files: FilesPort
  clock: SpeechClock
}

function extensionOf(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'webm'
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

async function removeOwnedFile(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function transcribeTemporaryBytes(
  transcriber: ReturnType<typeof getActiveTranscription>,
  source: Extract<TranscriptionSource, { kind: 'bytes' }>,
  options: Parameters<TranscriberPort['transcribe']>[1]
): Promise<{ text: string }> {
  const file = path.join(
    os.tmpdir(),
    `offgrid-speech-${process.pid}-${randomUUID()}.${extensionOf(options.extension)}`
  )
  let transcript: { text: string } | null = null
  let primaryFailure: Error | null = null
  try {
    options.signal.throwIfAborted()
    await fs.promises.writeFile(file, source.bytes, { signal: options.signal })
    options.signal.throwIfAborted()
    transcript = await transcriber.transcribe(
      { path: file },
      { language: options.language, signal: options.signal }
    )
  } catch (error) {
    primaryFailure = errorOf(error)
  }

  let cleanupFailure: Error | null = null
  try {
    await removeOwnedFile(file)
  } catch (error) {
    cleanupFailure = errorOf(error)
  }
  if (primaryFailure && cleanupFailure) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      'Speech transcription and temporary-file cleanup failed.'
    )
  }
  if (primaryFailure) throw primaryFailure
  if (cleanupFailure) throw cleanupFailure
  if (!transcript) throw new Error('The transcription engine returned no transcript.')
  return transcript
}

function createTranscriber(): TranscriberPort {
  return {
    ready: () => getActiveTranscription().isAvailable(),
    transcribe: async (source, options) => {
      const transcriber = getActiveTranscription()
      if (source.kind === 'bytes') {
        return transcribeTemporaryBytes(transcriber, source, options)
      }
      options.signal.throwIfAborted()
      return transcriber.transcribe(
        { path: source.path },
        { language: options.language, signal: options.signal }
      )
    }
  }
}

function createSynthesizer(): SynthesizerPort {
  const progressListeners = new Set<() => void>()
  return {
    ready: () => inspectTtsRuntimeState().ready,
    synthesize: async (request, signal) => {
      signal.throwIfAborted()
      const audio = await synthesizeNative(request.text, request.voice, {
        signal,
        onProgress: () => {
          for (const listener of progressListeners) listener()
        }
      })
      signal.throwIfAborted()
      return { kind: 'inline', dataUri: audio.dataUrl }
    },
    onProgress: (listener): Unsubscribe => {
      progressListeners.add(listener)
      return () => progressListeners.delete(listener)
    }
  }
}

export function createDesktopSpeechIoPorts(): DesktopSpeechIoPorts {
  return {
    transcriber: createTranscriber(),
    synthesizer: createSynthesizer(),
    files: { remove: removeOwnedFile },
    clock: {
      now: Date.now,
      after: (ms, callback) => {
        const timer = setTimeout(callback, ms)
        return () => clearTimeout(timer)
      }
    }
  }
}
