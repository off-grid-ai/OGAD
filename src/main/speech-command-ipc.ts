import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { OffGridApplication, SpeakCommand, StreamSpeechCommand } from '@offgrid/application'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import {
  SPEECH_EVENT_CHANNEL,
  SPEECH_FEED_STREAM_CHANNEL,
  SPEECH_FINISH_STREAM_CHANNEL,
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

function parseStreamCommand(value: unknown): StreamSpeechCommand | null {
  if (!value || typeof value !== 'object') return null
  const command = value as Record<string, unknown>
  if (
    typeof command.operationId !== 'string' ||
    command.operationId.length === 0 ||
    command.operationId.length > 256 ||
    typeof command.delta !== 'string' ||
    command.delta.length > MAX_SPEECH_TEXT_LENGTH ||
    !optionalString(command.voice, 256) ||
    !optionalString(command.language, 64) ||
    !optionalSpeed(command.speed)
  )
    return null
  return {
    operationId: command.operationId,
    delta: command.delta,
    ...(typeof command.voice === 'string' ? { voice: command.voice } : {}),
    ...(typeof command.language === 'string' ? { language: command.language } : {}),
    ...(typeof command.speed === 'number' ? { speed: command.speed } : {})
  }
}

function parseOperationId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function assertMainRenderer(event: IpcMainInvokeEvent): void {
  if (event.sender !== getMainWindow()?.webContents) {
    throw new Error('Speech commands are only available to the main renderer.')
  }
}

let registered = false
let stopEvents: (() => void) | null = null

async function speechApplication(): Promise<OffGridApplication> {
  const { desktopApplication } = await import('./composition/application')
  stopEvents ??= desktopApplication.speech.events((event) => {
    const contents = getMainWindow()?.webContents
    if (contents && !contents.isDestroyed()) contents.send(SPEECH_EVENT_CHANNEL, event)
  })
  return desktopApplication
}

export function setupSpeechCommandIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(
    SPEECH_SPEAK_CHANNEL,
    async (event, value: unknown): Promise<SpeechSpeakOutcome> => {
      assertMainRenderer(event)
      const command = parseSpeakCommand(value)
      if (!command) throw new Error('Invalid speech command.')
      const desktopApplication = await speechApplication()
      return desktopApplication.speech.speak(command)
    }
  )
  ipcMain.handle(SPEECH_FEED_STREAM_CHANNEL, async (event, value: unknown): Promise<void> => {
    assertMainRenderer(event)
    const command = parseStreamCommand(value)
    if (!command) throw new Error('Invalid speech stream command.')
    const desktopApplication = await speechApplication()
    desktopApplication.speech.feedStream(command)
  })
  ipcMain.handle(SPEECH_FINISH_STREAM_CHANNEL, async (event, value: unknown): Promise<void> => {
    assertMainRenderer(event)
    const operationId = parseOperationId(value)
    if (!operationId) throw new Error('Invalid speech stream operation ID.')
    const desktopApplication = await speechApplication()
    desktopApplication.speech.finishStream(operationId)
  })
  ipcMain.handle(SPEECH_INTERRUPT_CHANNEL, async (event): Promise<void> => {
    assertMainRenderer(event)
    const desktopApplication = await speechApplication()
    await desktopApplication.speech.interrupt()
  })
  applicationShutdown.register({
    name: 'speech:command-transport',
    shutdown: () => {
      ipcMain.removeHandler(SPEECH_SPEAK_CHANNEL)
      ipcMain.removeHandler(SPEECH_FEED_STREAM_CHANNEL)
      ipcMain.removeHandler(SPEECH_FINISH_STREAM_CHANNEL)
      ipcMain.removeHandler(SPEECH_INTERRUPT_CHANNEL)
      stopEvents?.()
      stopEvents = null
      registered = false
    }
  })
}
