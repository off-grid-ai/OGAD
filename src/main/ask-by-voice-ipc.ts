/**
 * Starting a voice question, and streaming the workflow's own events back.
 *
 * This is the caller `workflows.askByVoice` had none of. The renderer captures audio and asks for a
 * run; everything after that - transcription, the turn, speaking the answer, the deadline, the
 * cancel - is the workflow's, under one correlated operation id. Nothing here sequences anything:
 * it validates a command, forwards events, and stops.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { AskByVoiceCommand, OffGridApplication } from '@offgrid/application'
import {
  ASK_BY_VOICE_CANCEL_CHANNEL,
  ASK_BY_VOICE_EVENT_CHANNEL,
  ASK_BY_VOICE_START_CHANNEL,
  type AskByVoiceStartCommand,
  type AskByVoiceStarted
} from '../shared/ask-by-voice-contract'
import { getMainWindow } from './main-window'
import { applicationShutdown } from './shutdown'
import { writeDiagnosticLog } from './diagnostics-log'

const MAX_AUDIO_BYTES = 64 * 1024 * 1024

function assertMainRenderer(event: IpcMainInvokeEvent): void {
  if (event.sender !== getMainWindow()?.webContents) {
    throw new Error('Voice questions may only be started by the main window.')
  }
}

function parseStart(value: unknown): AskByVoiceStartCommand | null {
  if (!value || typeof value !== 'object') return null
  const command = value as Record<string, unknown>
  const bytes = command.bytes
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null
  if (bytes.byteLength > MAX_AUDIO_BYTES) return null
  if (typeof command.mimeType !== 'string' || !command.mimeType) return null
  const conversationId = command.conversationId
  if (conversationId !== undefined && (typeof conversationId !== 'string' || !conversationId)) {
    return null
  }
  const projectId = command.projectId
  if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') return null
  if (command.speak !== undefined && typeof command.speak !== 'boolean') return null
  return {
    bytes,
    mimeType: command.mimeType,
    ...(typeof conversationId === 'string' ? { conversationId } : {}),
    ...(projectId === undefined ? {} : { projectId: projectId as string | null }),
    ...(typeof command.speak === 'boolean' ? { speak: command.speak } : {})
  }
}

/** One controller per run, so a cancel reaches the run it names and no other. */
const runs = new Map<string, AbortController>()
let registered = false

function commandFor(start: AskByVoiceStartCommand, controller: AbortController): AskByVoiceCommand {
  return {
    source: { kind: 'bytes', bytes: start.bytes, mimeType: start.mimeType },
    ...(start.conversationId ? { conversationId: start.conversationId } : {}),
    ...(start.projectId ? { projectId: start.projectId } : {}),
    ...(start.speak === undefined ? {} : { speak: start.speak }),
    signal: controller.signal
  }
}

export function setupAskByVoiceIpc(application: () => Promise<OffGridApplication>): void {
  if (registered) return
  registered = true

  ipcMain.handle(
    ASK_BY_VOICE_START_CHANNEL,
    async (event, value: unknown): Promise<AskByVoiceStarted> => {
      assertMainRenderer(event)
      const start = parseStart(value)
      if (!start) throw new Error('Invalid voice question.')
      const controller = new AbortController()
      const offgrid = await application()
      const stream = offgrid.workflows.askByVoice(commandFor(start, controller))
      /**
       * The run's id arrives on its own first event, so the caller learns it from the stream rather
       * than from a second source that could disagree. This handle resolves on that event and
       * REJECTS if the stream ends without one - a caller that never learns the id could never
       * cancel the run.
       */
      let identify: (operationId: string) => void = () => undefined
      let refuse: (error: Error) => void = () => undefined
      const identified = new Promise<string>((resolve, reject) => {
        identify = resolve
        refuse = reject
      })
      let operationId = ''
      void (async (): Promise<void> => {
        try {
          for await (const workflowEvent of stream) {
            if (!operationId) {
              operationId = workflowEvent.operationId
              runs.set(operationId, controller)
              identify(operationId)
            }
            const contents = getMainWindow()?.webContents
            if (contents && !contents.isDestroyed()) {
              contents.send(ASK_BY_VOICE_EVENT_CHANNEL, { operationId, event: workflowEvent })
            }
          }
          if (!operationId) refuse(new Error('The voice question produced no events.'))
        } catch (error) {
          // The workflow reports its own failures as events; anything arriving here is the stream
          // itself breaking, which has no other channel.
          const message = error instanceof Error ? error.message : String(error)
          writeDiagnosticLog(
            'voice',
            'ask-by-voice.stream.failed',
            { operationId, error: message },
            'error'
          )
          if (!operationId) refuse(new Error(message))
        } finally {
          if (operationId) runs.delete(operationId)
        }
      })()
      return { operationId: await identified }
    }
  )

  ipcMain.handle(ASK_BY_VOICE_CANCEL_CHANNEL, async (event, value: unknown): Promise<void> => {
    assertMainRenderer(event)
    if (typeof value !== 'string' || !value) throw new Error('Invalid voice question id.')
    // Through the workflow, which is the one canceller: it aborts the run, and for a turn the host
    // is executing the signal IS the stop - no second teardown is issued for the same turn.
    const offgrid = await application()
    const outcome = await offgrid.workflows.cancelAskByVoice({ operationId: value })
    if (!outcome.ok) {
      writeDiagnosticLog('voice', 'ask-by-voice.cancel.refused', { operationId: value }, 'warn')
    }
  })

  applicationShutdown.register({
    name: 'voice:ask-by-voice',
    shutdown: () => {
      for (const controller of runs.values()) controller.abort()
      runs.clear()
    }
  })
}
