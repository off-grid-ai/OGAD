/**
 * Starting a voice question from the renderer, and hearing how it goes.
 *
 * The renderer owns capture and nothing else: it hands over the recorded bytes and the scope the
 * question belongs to, and receives the workflow's own event stream. Every phase after that -
 * transcription, the turn, speaking the answer - is coordinated by `workflows.askByVoice` in main
 * under one correlated operation id.
 */
import type { AskByVoiceEvent } from '@offgrid/application'

export const ASK_BY_VOICE_START_CHANNEL = 'ask-by-voice:start'
export const ASK_BY_VOICE_CANCEL_CHANNEL = 'ask-by-voice:cancel'
export const ASK_BY_VOICE_EVENT_CHANNEL = 'ask-by-voice:event'

export interface AskByVoiceStartCommand {
  /** The captured audio. */
  readonly bytes: Uint8Array
  readonly mimeType: string
  /**
   * The conversation this question belongs to, when it belongs to one. Present means the answer
   * becomes a real chat turn; absent means a one-shot question with nothing to persist.
   */
  readonly conversationId?: string
  readonly projectId?: string | null
  /** Speak the answer back. Defaults to true in the workflow. */
  readonly speak?: boolean
}

/** The run's id, for correlating events and for cancelling it. */
export interface AskByVoiceStarted {
  readonly operationId: string
}

/** One event of a run, tagged with the run it belongs to so one listener can serve several. */
export interface AskByVoiceEventMessage {
  readonly operationId: string
  readonly event: AskByVoiceEvent
}
