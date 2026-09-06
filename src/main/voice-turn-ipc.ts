/**
 * The Electron transport for the voice-turn executor: main asks the window to run its own turn.
 *
 * Registered so `voiceTurn` can be composed into the application root. Only the main window
 * answers, and only its sender is trusted - a turn that persists rows and reaches the mesh is not
 * something any frame may claim to have run.
 */
import { ipcMain, type IpcMainEvent } from 'electron'
import type { VoiceTurnExecutor } from '@offgrid/application'
import {
  VOICE_TURN_REQUEST_CHANNEL,
  VOICE_TURN_RESULT_CHANNEL,
  type VoiceTurnHostResult
} from '../shared/voice-turn-contract'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import { createVoiceTurnBroker, type VoiceTurnBroker } from './voice-turn-broker'

function parseResult(value: unknown): VoiceTurnHostResult | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  if (typeof result.requestId !== 'string' || !result.requestId) return null
  if (result.status === 'completed') {
    return typeof result.answer === 'string'
      ? { requestId: result.requestId, status: 'completed', answer: result.answer }
      : null
  }
  if (result.status === 'cancelled') return { requestId: result.requestId, status: 'cancelled' }
  if (result.status === 'failed' && typeof result.error === 'string') {
    return { requestId: result.requestId, status: 'failed', error: result.error }
  }
  return null
}

let broker: VoiceTurnBroker | null = null

export function setupVoiceTurnIpc(): VoiceTurnExecutor {
  if (!broker) {
    broker = createVoiceTurnBroker({
      send: (message) => {
        const contents = getMainWindow()?.webContents
        if (!contents || contents.isDestroyed()) {
          // Typed refusal rather than a downgrade: with no window there is nothing that can run a
          // turn with rows, context, tools and sync, and answering anyway would produce something
          // else wearing the same name.
          throw new Error('No window is available to run a voice turn.')
        }
        contents.send(VOICE_TURN_REQUEST_CHANNEL, message)
      },
      onResult: (listener) => {
        const receive = (event: IpcMainEvent, value: unknown): void => {
          if (event.sender !== getMainWindow()?.webContents) return
          const result = parseResult(value)
          if (result) listener(result)
        }
        ipcMain.on(VOICE_TURN_RESULT_CHANNEL, receive)
        return () => ipcMain.removeListener(VOICE_TURN_RESULT_CHANNEL, receive)
      }
    })
    applicationShutdown.register({ name: 'voice-turn:transport', shutdown: disposeVoiceTurnIpc })
  }
  return broker.execute
}

export function disposeVoiceTurnIpc(): void {
  broker?.dispose()
  broker = null
}
