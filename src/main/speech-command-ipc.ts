import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { VOICE_TURN_LABELS } from '@offgrid/application'
import type {
  OffGridApplication,
  SpeakCommand,
  StreamSpeechCommand,
  TranscribeCommand
} from '@offgrid/application'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import {
  SPEECH_CANCEL_TRANSCRIPTION_CHANNEL,
  SPEECH_EVENT_CHANNEL,
  SPEECH_FEED_STREAM_CHANNEL,
  SPEECH_FINISH_STREAM_CHANNEL,
  SPEECH_GET_SNAPSHOT_CHANNEL,
  SPEECH_INTERRUPT_CHANNEL,
  SPEECH_SELECT_MODEL_CHANNEL,
  SPEECH_SELECT_VOICE_CHANNEL,
  SPEECH_SAVE_PREFERENCES_CHANNEL,
  SPEECH_SNAPSHOT_CHANGED_CHANNEL,
  SPEECH_SPEAK_CHANNEL,
  SPEECH_START_REALTIME_CHANNEL,
  SPEECH_STOP_REALTIME_CHANNEL,
  SPEECH_TRANSCRIBE_CHANNEL,
  type DesktopSpeechSnapshot,
  type SpeechCancelTranscriptionOutcome,
  type SpeechSelectionOutcome,
  type SpeechPreferencesOutcome,
  type SpeechPreferencesPatch,
  type SpeechStartRealtimeCommand,
  type SpeechStartRealtimeOutcome,
  type SpeechStopRealtimeOutcome,
  type SpeechTranscribeOutcome,
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

function parseStartRealtimeCommand(value: unknown): SpeechStartRealtimeCommand | null {
  if (!value || typeof value !== 'object') return null
  const command = value as Record<string, unknown>
  if (
    typeof command.mode !== 'string' ||
    !Object.prototype.hasOwnProperty.call(VOICE_TURN_LABELS, command.mode) ||
    !optionalString(command.language, 64)
  ) {
    return null
  }
  return {
    mode: command.mode as SpeechStartRealtimeCommand['mode'],
    ...(typeof command.language === 'string' ? { language: command.language } : {})
  }
}

function parseSelection(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

function parseTranscribeCommand(value: unknown): TranscribeCommand | null {
  if (!value || typeof value !== 'object') return null
  const command = value as Record<string, unknown>
  const source = command.source as Record<string, unknown> | undefined
  const operationId = optionalString(command.operationId, 256) ? command.operationId : null
  if (
    !source ||
    source.kind !== 'bytes' ||
    !(source.bytes instanceof Uint8Array) ||
    typeof source.mimeType !== 'string' ||
    source.mimeType.length === 0 ||
    source.mimeType.length > 256 ||
    operationId === null ||
    operationId === '' ||
    !optionalString(command.language, 64)
  )
    return null
  return {
    source: { kind: 'bytes', bytes: source.bytes, mimeType: source.mimeType },
    ...(typeof operationId === 'string' ? { operationId } : {}),
    ...(typeof command.language === 'string' ? { language: command.language } : {})
  }
}

function assertMainRenderer(event: IpcMainInvokeEvent): void {
  if (event.sender !== getMainWindow()?.webContents) {
    throw new Error('Speech commands are only available to the main renderer.')
  }
}

let registered = false
let stopEvents: (() => void) | null = null
let stopSnapshots: (() => void) | null = null

async function speechApplication(): Promise<OffGridApplication> {
  const { desktopApplication } = await import('./composition/application')
  stopEvents ??= desktopApplication.speech.events((event) => {
    const contents = getMainWindow()?.webContents
    if (contents && !contents.isDestroyed()) contents.send(SPEECH_EVENT_CHANNEL, event)
  })
  stopSnapshots ??= desktopApplication.speech.subscribe((snapshot) => {
    const contents = getMainWindow()?.webContents
    if (contents && !contents.isDestroyed()) {
      contents.send(SPEECH_SNAPSHOT_CHANGED_CHANNEL, snapshot)
    }
  })
  return desktopApplication
}

export function setupSpeechCommandIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(SPEECH_GET_SNAPSHOT_CHANNEL, async (event): Promise<DesktopSpeechSnapshot> => {
    assertMainRenderer(event)
    return (await speechApplication()).speech.snapshot()
  })
  ipcMain.handle(
    SPEECH_START_REALTIME_CHANNEL,
    async (event, value: unknown): Promise<SpeechStartRealtimeOutcome> => {
      assertMainRenderer(event)
      const command = parseStartRealtimeCommand(value)
      if (!command) throw new Error('Invalid realtime speech command.')
      return (await speechApplication()).speech.startRealtime(command)
    }
  )
  ipcMain.handle(
    SPEECH_STOP_REALTIME_CHANNEL,
    async (event): Promise<SpeechStopRealtimeOutcome> => {
      assertMainRenderer(event)
      return (await speechApplication()).speech.stopRealtime()
    }
  )
  ipcMain.handle(
    SPEECH_SELECT_MODEL_CHANNEL,
    async (event, modality: unknown, value: unknown): Promise<SpeechSelectionOutcome> => {
      assertMainRenderer(event)
      if (modality !== 'stt' && modality !== 'tts') throw new Error('Invalid speech modality.')
      const modelId = parseSelection(value, 512)
      if (modelId === undefined) throw new Error('Invalid speech model selection.')
      return (await speechApplication()).speech.selectModel(modality, modelId)
    }
  )
  ipcMain.handle(
    SPEECH_SELECT_VOICE_CHANNEL,
    async (event, value: unknown): Promise<SpeechSelectionOutcome> => {
      assertMainRenderer(event)
      const voice = parseSelection(value, 256)
      if (voice === undefined) throw new Error('Invalid speech voice selection.')
      return (await speechApplication()).speech.selectVoice(voice)
    }
  )
  ipcMain.handle(
    SPEECH_SAVE_PREFERENCES_CHANNEL,
    async (event, value: unknown): Promise<SpeechPreferencesOutcome> => {
      assertMainRenderer(event)
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid speech preference patch.')
      }
      return (await speechApplication()).speech.savePreferences(value as SpeechPreferencesPatch)
    }
  )
  ipcMain.handle(
    SPEECH_TRANSCRIBE_CHANNEL,
    async (event, value: unknown): Promise<SpeechTranscribeOutcome> => {
      assertMainRenderer(event)
      const command = parseTranscribeCommand(value)
      if (!command) throw new Error('Invalid speech transcription command.')
      const desktopApplication = await speechApplication()
      return desktopApplication.speech.transcribe(command)
    }
  )
  ipcMain.handle(
    SPEECH_CANCEL_TRANSCRIPTION_CHANNEL,
    async (event, value: unknown): Promise<SpeechCancelTranscriptionOutcome> => {
      assertMainRenderer(event)
      const operationId = parseOperationId(value)
      if (!operationId) throw new Error('Invalid speech transcription operation ID.')
      const desktopApplication = await speechApplication()
      return desktopApplication.speech.cancelTranscription(operationId)
    }
  )
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
      ipcMain.removeHandler(SPEECH_TRANSCRIBE_CHANNEL)
      ipcMain.removeHandler(SPEECH_CANCEL_TRANSCRIPTION_CHANNEL)
      ipcMain.removeHandler(SPEECH_SPEAK_CHANNEL)
      ipcMain.removeHandler(SPEECH_FEED_STREAM_CHANNEL)
      ipcMain.removeHandler(SPEECH_FINISH_STREAM_CHANNEL)
      ipcMain.removeHandler(SPEECH_INTERRUPT_CHANNEL)
      ipcMain.removeHandler(SPEECH_GET_SNAPSHOT_CHANNEL)
      ipcMain.removeHandler(SPEECH_START_REALTIME_CHANNEL)
      ipcMain.removeHandler(SPEECH_STOP_REALTIME_CHANNEL)
      ipcMain.removeHandler(SPEECH_SELECT_MODEL_CHANNEL)
      ipcMain.removeHandler(SPEECH_SELECT_VOICE_CHANNEL)
      ipcMain.removeHandler(SPEECH_SAVE_PREFERENCES_CHANNEL)
      stopEvents?.()
      stopEvents = null
      stopSnapshots?.()
      stopSnapshots = null
      registered = false
    }
  })
}
