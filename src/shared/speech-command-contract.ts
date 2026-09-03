import type {
  OperationHandle,
  Outcome,
  SpeakCommand,
  SpeechEvent,
  SpeechFailure
} from '@offgrid/application'

export const SPEECH_SPEAK_CHANNEL = 'speech:command:speak'
export const SPEECH_INTERRUPT_CHANNEL = 'speech:command:interrupt'
export const SPEECH_EVENT_CHANNEL = 'speech:event'

export type SpeechSpeakCommand = SpeakCommand
export type SpeechSpeakOutcome = Outcome<OperationHandle, SpeechFailure>
export type DesktopSpeechEvent = SpeechEvent
