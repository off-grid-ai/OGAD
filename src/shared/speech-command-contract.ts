import type {
  OperationHandle,
  Outcome,
  SpeakCommand,
  SpeechEvent,
  SpeechFailure,
  StreamSpeechCommand
} from '@offgrid/application'

export const SPEECH_SPEAK_CHANNEL = 'speech:command:speak'
export const SPEECH_FEED_STREAM_CHANNEL = 'speech:command:feed-stream'
export const SPEECH_FINISH_STREAM_CHANNEL = 'speech:command:finish-stream'
export const SPEECH_INTERRUPT_CHANNEL = 'speech:command:interrupt'
export const SPEECH_EVENT_CHANNEL = 'speech:event'

export type SpeechSpeakCommand = SpeakCommand
export type SpeechSpeakOutcome = Outcome<OperationHandle, SpeechFailure>
export type SpeechStreamCommand = StreamSpeechCommand
export type DesktopSpeechEvent = SpeechEvent
