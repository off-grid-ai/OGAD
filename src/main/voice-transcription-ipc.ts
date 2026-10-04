/** Request-scoped voice transcription IPC. Main owns cancellation and temp-file cleanup. */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import {
  admitTranscriptionRequest,
  isValidRequestId,
  transcriptionRequestKey
} from '@offgrid/speech'
import type { TranscriptionService } from './transcription/types'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

export interface VoiceTranscriptionIpcHost {
  handle(channel: string, listener: InvokeHandler): void
}

export type TranscriptionServiceProvider = () => Promise<TranscriptionService>

const active = new Map<string, AbortController>()

async function unlinkTemp(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

const productionService: TranscriptionServiceProvider = async () => {
  const { getActiveTranscription } = await import('./transcription/select')
  return getActiveTranscription()
}

export function setupVoiceTranscriptionIpc(
  host: VoiceTranscriptionIpcHost = ipcMain,
  getService: TranscriptionServiceProvider = productionService
): void {
  // IPC carries the audio bytes, extension and request identity as separate structured-clone fields.
  // eslint-disable-next-line max-params
  host.handle('voice:transcribe', async (event, audioValue, extValue, requestIdValue) => {
    const admission = admitTranscriptionRequest({
      senderId: event.sender.id,
      requestId: requestIdValue,
      extension: extValue,
      isActive: (key) => active.has(key)
    })
    if (!admission.ok) throw new Error(admission.message)
    const { extension: safeExt, key } = admission

    const audio = audioValue as ArrayBuffer | Uint8Array
    const buf = ArrayBuffer.isView(audio)
      ? Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
      : Buffer.from(audio)
    const tmp = path.join(
      os.tmpdir(),
      `offgrid-mic-${process.pid}-${crypto.randomUUID()}.${safeExt}`
    )
    const controller = new AbortController()
    const abortOnDestroyed = (): void => controller.abort()
    active.set(key, controller)
    event.sender.once('destroyed', abortOnDestroyed)
    try {
      await fs.promises.writeFile(tmp, buf, { signal: controller.signal })
      const service = await getService()
      controller.signal.throwIfAborted()
      return (await service.transcribe({ path: tmp }, { signal: controller.signal })).text
    } finally {
      if (active.get(key) === controller) active.delete(key)
      event.sender.removeListener('destroyed', abortOnDestroyed)
      await unlinkTemp(tmp)
    }
  })

  host.handle('voice:cancel-transcription', (event, requestIdValue) => {
    if (!isValidRequestId(requestIdValue)) return false
    const controller = active.get(transcriptionRequestKey(event.sender.id, requestIdValue))
    if (!controller) return false
    controller.abort()
    return true
  })
}
