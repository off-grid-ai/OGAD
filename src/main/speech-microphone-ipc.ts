import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import type { RecordedAudio } from '@offgrid/speech'
import {
  SPEECH_MICROPHONE_LEVEL_CHANNEL,
  SPEECH_MICROPHONE_REQUEST_CHANNEL,
  SPEECH_MICROPHONE_RESULT_CHANNEL,
  type SpeechMicrophoneLevel,
  type SpeechMicrophoneResult
} from '../shared/speech-microphone-contract'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import {
  createSpeechMicrophoneBroker,
  type SpeechMicrophoneBroker,
  type SpeechMicrophoneBrokerHost
} from './speech-microphone-broker'

function recordedAudio(value: unknown): RecordedAudio | null {
  if (!value || typeof value !== 'object') return null
  const audio = value as Record<string, unknown>
  if (typeof audio.mime !== 'string') return null
  if (audio.bytes !== undefined && !(audio.bytes instanceof Uint8Array)) return null
  if (audio.path !== undefined && typeof audio.path !== 'string') return null
  if (
    audio.durationSeconds !== undefined &&
    (typeof audio.durationSeconds !== 'number' ||
      !Number.isFinite(audio.durationSeconds) ||
      audio.durationSeconds < 0)
  )
    return null
  return {
    mime: audio.mime,
    ...(audio.bytes instanceof Uint8Array ? { bytes: audio.bytes } : {}),
    ...(typeof audio.path === 'string' ? { path: audio.path } : {}),
    ...(typeof audio.durationSeconds === 'number' ? { durationSeconds: audio.durationSeconds } : {})
  }
}

type MicrophoneCommand = SpeechMicrophoneResult['type']

function resultIdentity(
  value: unknown
): { result: Record<string, unknown>; requestId: string; type: MicrophoneCommand } | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  if (
    typeof result.requestId !== 'string' ||
    !result.requestId ||
    (result.type !== 'start' && result.type !== 'stop' && result.type !== 'cancel')
  )
    return null
  return { result, requestId: result.requestId, type: result.type }
}

function completedResult(
  result: Record<string, unknown>,
  requestId: string,
  type: MicrophoneCommand
): SpeechMicrophoneResult | null {
  if (type === 'start' && typeof result.echoCancelled === 'boolean') {
    return { type, requestId, status: 'completed', echoCancelled: result.echoCancelled }
  }
  if (type === 'stop') {
    const audio = recordedAudio(result.audio)
    return audio ? { type, requestId, status: 'completed', audio } : null
  }
  return type === 'cancel' ? { type, requestId, status: 'completed' } : null
}

function parseResult(value: unknown): SpeechMicrophoneResult | null {
  const identity = resultIdentity(value)
  if (!identity) return null
  const { result, requestId, type } = identity
  if (result.status === 'failed' || result.status === 'cancelled') {
    if (result.error !== undefined && typeof result.error !== 'string') return null
    return {
      type,
      requestId,
      status: result.status,
      ...(typeof result.error === 'string' ? { error: result.error } : {})
    }
  }
  if (result.status !== 'completed') return null
  return completedResult(result, requestId, type)
}

function parseLevel(value: unknown): SpeechMicrophoneLevel | null {
  if (!value || typeof value !== 'object') return null
  const level = value as Record<string, unknown>
  return typeof level.captureId === 'string' &&
    level.captureId &&
    typeof level.rms === 'number' &&
    Number.isFinite(level.rms) &&
    level.rms >= 0 &&
    level.rms <= 1
    ? { captureId: level.captureId, rms: level.rms }
    : null
}

function currentContents(): WebContents | null {
  return getMainWindow()?.webContents ?? null
}

function electronMicrophoneHost(): SpeechMicrophoneBrokerHost {
  return {
    rendererId: () => currentContents()?.id ?? null,
    send: (rendererId, request) => {
      const contents = currentContents()
      if (!contents || contents.isDestroyed() || contents.id !== rendererId)
        throw new Error('Speech microphone renderer is unavailable.')
      contents.send(SPEECH_MICROPHONE_REQUEST_CHANNEL, request)
    },
    onResult: (listener) => {
      const receive = (event: IpcMainEvent, value: unknown): void => {
        if (event.sender !== currentContents()) return
        const result = parseResult(value)
        if (result) listener(event.sender.id, result)
      }
      ipcMain.on(SPEECH_MICROPHONE_RESULT_CHANNEL, receive)
      return () => ipcMain.removeListener(SPEECH_MICROPHONE_RESULT_CHANNEL, receive)
    },
    onLevel: (listener) => {
      const receive = (event: IpcMainEvent, value: unknown): void => {
        if (event.sender !== currentContents()) return
        const level = parseLevel(value)
        if (level) listener(event.sender.id, level)
      }
      ipcMain.on(SPEECH_MICROPHONE_LEVEL_CHANNEL, receive)
      return () => ipcMain.removeListener(SPEECH_MICROPHONE_LEVEL_CHANNEL, receive)
    }
  }
}

let broker: SpeechMicrophoneBroker | null = null

export function setupSpeechMicrophoneIpc(): SpeechMicrophoneBroker {
  if (!broker) {
    broker = createSpeechMicrophoneBroker(electronMicrophoneHost())
    applicationShutdown.register({
      name: 'speech:microphone-transport',
      shutdown: disposeSpeechMicrophoneIpc
    })
  }
  return broker
}

export function disposeSpeechMicrophoneIpc(): void {
  broker?.dispose()
  broker = null
}
