import { ipcMain, type IpcMainEvent } from 'electron'
import {
  SPEECH_PLAYBACK_REQUEST_CHANNEL,
  SPEECH_PLAYBACK_RESULT_CHANNEL,
  type SpeechPlaybackResult
} from '../shared/speech-playback-contract'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import {
  createSpeechPlaybackBroker,
  type SpeechPlaybackBroker,
  type SpeechPlaybackBrokerHost
} from './speech-playback-broker'

function parseResult(value: unknown): SpeechPlaybackResult | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  if (typeof result.requestId !== 'string' || !result.requestId) return null
  if (result.status === 'completed' || result.status === 'cancelled') {
    return { requestId: result.requestId, status: result.status }
  }
  if (result.status === 'failed' && typeof result.error === 'string') {
    return { requestId: result.requestId, status: 'failed', error: result.error }
  }
  return null
}

function electronPlaybackHost(): SpeechPlaybackBrokerHost {
  return {
    send: (request) => {
      const contents = getMainWindow()?.webContents
      if (!contents || contents.isDestroyed())
        throw new Error('Speech playback renderer is unavailable.')
      contents.send(SPEECH_PLAYBACK_REQUEST_CHANNEL, request)
    },
    onResult: (listener) => {
      const receive = (event: IpcMainEvent, value: unknown): void => {
        if (event.sender !== getMainWindow()?.webContents) return
        const result = parseResult(value)
        if (result) listener(result)
      }
      ipcMain.on(SPEECH_PLAYBACK_RESULT_CHANNEL, receive)
      return () => ipcMain.removeListener(SPEECH_PLAYBACK_RESULT_CHANNEL, receive)
    }
  }
}

let broker: SpeechPlaybackBroker | null = null

export function setupSpeechPlaybackIpc(): SpeechPlaybackBroker {
  if (!broker) {
    broker = createSpeechPlaybackBroker(electronPlaybackHost())
    applicationShutdown.register({
      name: 'speech:playback-transport',
      shutdown: disposeSpeechPlaybackIpc
    })
  }
  return broker
}

export function disposeSpeechPlaybackIpc(): void {
  broker?.dispose()
  broker = null
}
