import type {
  OperationHandle,
  Outcome,
  SpeakCommand,
  SpeechEvent,
  SpeechFailure,
  TranscribeCommand,
  StreamSpeechCommand
} from '@offgrid/application'

export const SPEECH_SPEAK_CHANNEL = 'speech:command:speak'
export const SPEECH_TRANSCRIBE_CHANNEL = 'speech:command:transcribe'
export const SPEECH_CANCEL_TRANSCRIPTION_CHANNEL = 'speech:command:cancel-transcription'
export const SPEECH_FEED_STREAM_CHANNEL = 'speech:command:feed-stream'
export const SPEECH_FINISH_STREAM_CHANNEL = 'speech:command:finish-stream'
export const SPEECH_INTERRUPT_CHANNEL = 'speech:command:interrupt'
export const SPEECH_EVENT_CHANNEL = 'speech:event'

export type SpeechSpeakCommand = SpeakCommand
export type SpeechSpeakOutcome = Outcome<OperationHandle, SpeechFailure>
export type SpeechTranscribeCommand = TranscribeCommand
export type SpeechTranscribeOutcome = Outcome<{ text: string }, SpeechFailure>
export type SpeechCancelTranscriptionOutcome = Outcome<void, SpeechFailure>
export type SpeechStreamCommand = StreamSpeechCommand
export type DesktopSpeechEvent = SpeechEvent
