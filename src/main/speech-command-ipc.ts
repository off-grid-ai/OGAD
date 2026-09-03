import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { SpeakCommand } from '@offgrid/application'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import {
  SPEECH_INTERRUPT_CHANNEL,
  SPEECH_SPEAK_CHANNEL,
  type SpeechSpeakOutcome
} from '../shared/speech-command-contract'

const MAX_SPEECH_TEXT_LENGTH = 100_000

function optionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function optionalSpeed(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function parseSpeakCommand(value: unknown): SpeakCommand | null {
  if (!value || typeof value !== 'object') return null
  const command = value as Record<string, unknown>
  if (
    typeof command.text !== 'string' ||
    command.text.length > MAX_SPEECH_TEXT_LENGTH ||
    !optionalString(command.voice, 256) ||
    !optionalString(command.language, 64) ||
    !optionalString(command.operationId, 256) ||
    !optionalSpeed(command.speed) ||
    command.operationId === ''
  )
    return null
  return {
    text: command.text,
    ...(typeof command.voice === 'string' ? { voice: command.voice } : {}),
    ...(typeof command.language === 'string' ? { language: command.language } : {}),
    ...(typeof command.speed === 'number' ? { speed: command.speed } : {}),
    ...(typeof command.operationId === 'string' ? { operationId: command.operationId } : {})
  }
}

function assertMainRenderer(event: IpcMainInvokeEvent): void {
  if (event.sender !== getMainWindow()?.webContents) {
    throw new Error('Speech commands are only available to the main renderer.')
  }
}

let registered = false

export function setupSpeechCommandIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(
    SPEECH_SPEAK_CHANNEL,
    async (event, value: unknown): Promise<SpeechSpeakOutcome> => {
      assertMainRenderer(event)
      const command = parseSpeakCommand(value)
      if (!command) throw new Error('Invalid speech command.')
      const { desktopApplication } = await import('./composition/application')
      return desktopApplication.speech.speak(command)
    }
  )
  ipcMain.handle(SPEECH_INTERRUPT_CHANNEL, async (event): Promise<void> => {
    assertMainRenderer(event)
    const { desktopApplication } = await import('./composition/application')
    await desktopApplication.speech.interrupt()
  })
  applicationShutdown.register({
    name: 'speech:command-transport',
    shutdown: () => {
      ipcMain.removeHandler(SPEECH_SPEAK_CHANNEL)
      ipcMain.removeHandler(SPEECH_INTERRUPT_CHANNEL)
      registered = false
    }
  })
}
