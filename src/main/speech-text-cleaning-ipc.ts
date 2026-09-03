import { randomUUID } from 'node:crypto'
import { ipcMain, type IpcMainEvent } from 'electron'
import {
  SPEECH_TEXT_CLEAN_REQUEST_CHANNEL,
  SPEECH_TEXT_CLEAN_RESULT_CHANNEL,
  type SpeechTextCleanRequest,
  type SpeechTextCleanResult
} from '../shared/speech-text-cleaning-contract'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'

interface PendingClean {
  ownerId: number
  reject(error: Error): void
  resolve(text: string): void
  signal?: AbortSignal
  onAbort?: () => void
}

export interface DesktopSpeechTextCleaner {
  clean(text: string, signal?: AbortSignal): Promise<string>
  dispose(): void
}

function parseResult(value: unknown): SpeechTextCleanResult | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  if (typeof result.requestId !== 'string' || !result.requestId) return null
  if (result.status === 'completed' && typeof result.text === 'string') {
    return { requestId: result.requestId, status: 'completed', text: result.text }
  }
  if (result.status === 'cancelled') return { requestId: result.requestId, status: 'cancelled' }
  if (result.status === 'failed' && typeof result.error === 'string') {
    return { requestId: result.requestId, status: 'failed', error: result.error }
  }
  return null
}

function cancellationError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error('Speech text cleaning was cancelled.')
}

let cleaner: DesktopSpeechTextCleaner | null = null

export function setupSpeechTextCleaningIpc(): DesktopSpeechTextCleaner {
  if (cleaner) return cleaner
  const pending = new Map<string, PendingClean>()

  const send = (ownerId: number, request: SpeechTextCleanRequest): void => {
    const contents = getMainWindow()?.webContents
    if (!contents || contents.isDestroyed() || contents.id !== ownerId)
      throw new Error('Speech text cleaner renderer is unavailable.')
    contents.send(SPEECH_TEXT_CLEAN_REQUEST_CHANNEL, request)
  }

  const settle = (requestId: string, result: SpeechTextCleanResult): void => {
    const request = pending.get(requestId)
    if (!request) return
    pending.delete(requestId)
    if (request.signal && request.onAbort) {
      request.signal.removeEventListener('abort', request.onAbort)
    }
    if (result.status === 'completed') request.resolve(result.text)
    else if (result.status === 'failed') request.reject(new Error(result.error))
    else request.reject(cancellationError(request.signal))
  }

  const receive = (event: IpcMainEvent, value: unknown): void => {
    if (event.sender !== getMainWindow()?.webContents) return
    const result = parseResult(value)
    const rawRequestId =
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).requestId === 'string'
        ? ((value as Record<string, unknown>).requestId as string)
        : null
    const request = pending.get(result?.requestId ?? rawRequestId ?? '')
    if (request?.ownerId !== event.sender.id) return
    if (!result) {
      settle(rawRequestId!, {
        requestId: rawRequestId!,
        status: 'failed',
        error: 'The speech text cleaner returned an invalid response.'
      })
      return
    }
    settle(result.requestId, result)
  }
  ipcMain.on(SPEECH_TEXT_CLEAN_RESULT_CHANNEL, receive)

  cleaner = {
    clean(text, signal) {
      if (signal?.aborted) return Promise.reject(cancellationError(signal))
      const contents = getMainWindow()?.webContents
      if (!contents || contents.isDestroyed()) {
        return Promise.reject(new Error('Speech text cleaner renderer is unavailable.'))
      }
      const requestId = randomUUID()
      return new Promise<string>((resolve, reject) => {
        const onAbort = (): void => {
          try {
            send(contents.id, { type: 'cancel', requestId })
          } catch (error) {
            settle(requestId, { requestId, status: 'failed', error: String(error) })
            return
          }
          settle(requestId, { requestId, status: 'cancelled' })
        }
        pending.set(requestId, { ownerId: contents.id, resolve, reject, signal, onAbort })
        signal?.addEventListener('abort', onAbort, { once: true })
        try {
          send(contents.id, { type: 'clean', requestId, text })
        } catch (error) {
          settle(requestId, {
            requestId,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
    },
    dispose() {
      ipcMain.removeListener(SPEECH_TEXT_CLEAN_RESULT_CHANNEL, receive)
      const error = new Error('Speech text cleaner was disposed.')
      for (const [requestId, request] of pending) {
        if (request.signal && request.onAbort) {
          request.signal.removeEventListener('abort', request.onAbort)
        }
        try {
          send(request.ownerId, { type: 'cancel', requestId })
        } catch {
          // The same disposal error below remains visible to the waiting caller.
        }
        request.reject(error)
      }
      pending.clear()
      cleaner = null
    }
  }
  applicationShutdown.register({
    name: 'speech:text-cleaning-transport',
    shutdown: cleaner.dispose
  })
  return cleaner
}
