import fs from 'fs'
import os from 'os'
import path from 'path'
import { decodeToWavArgs, DECODE_TIMEOUT_MS } from './ffmpeg-decode'
import { runNativeTranscriptionProcess } from './native-process'
import type { TranscriptionService, Transcript, TranscribeOptions } from './types'
import { ffmpegBin, whisperModel } from './whisper-cli'
import { whisperServer, type WhisperServerService } from './whisper-server'

/** TranscriptionService adapter for the resident process owner. Model selection and
 * input decoding stay separate from the shared server lifecycle and cancellation. */
export class WhisperServerTranscription implements TranscriptionService {
  constructor(private readonly svc: WhisperServerService = whisperServer) {}

  isAvailable(): boolean {
    return !!this.svc.findBinary() && !!whisperModel()
  }

  async transcribe(input: { path: string }, opts: TranscribeOptions = {}): Promise<Transcript> {
    opts.signal?.throwIfAborted()
    const model =
      opts.model && path.isAbsolute(opts.model) && fs.existsSync(opts.model)
        ? opts.model
        : whisperModel()
    if (!model)
      throw new Error('No transcription model found - download Whisper from Models first.')

    let wav = input.path
    let tmp: string | null = null
    if (!opts.alreadyWav16k) {
      const ff = ffmpegBin()
      if (!ff) throw new Error('ffmpeg is required to decode audio and was not found.')
      tmp = path.join(os.tmpdir(), `offgrid-stt-srv-${Date.now()}-${process.pid}.wav`)
      try {
        await runNativeTranscriptionProcess(ff, decodeToWavArgs(input.path, tmp), {
          timeout: DECODE_TIMEOUT_MS,
          signal: opts.signal
        })
      } catch (error) {
        fs.promises.unlink(tmp).catch(() => {})
        throw error
      }
      wav = tmp
    }

    try {
      return await this.svc.transcribe(
        { modelPath: model },
        {
          wavPath: wav,
          language: opts.language,
          prompt: opts.prompt,
          signal: opts.signal
        }
      )
    } finally {
      if (tmp) fs.promises.unlink(tmp).catch(() => {})
    }
  }
}

export const whisperServerTranscription: TranscriptionService = new WhisperServerTranscription()
