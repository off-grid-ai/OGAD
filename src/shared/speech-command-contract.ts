import type {
  OperationHandle,
  Outcome,
  SpeakCommand,
  SpeechEvent,
  SpeechFacade,
  SpeechFailure,
  SpeechSnapshot,
  StartRealtimeCommand,
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
export const SPEECH_GET_SNAPSHOT_CHANNEL = 'speech:command:get-snapshot'
export const SPEECH_SNAPSHOT_CHANGED_CHANNEL = 'speech:snapshot-changed'
export const SPEECH_START_REALTIME_CHANNEL = 'speech:command:start-realtime'
export const SPEECH_STOP_REALTIME_CHANNEL = 'speech:command:stop-realtime'
export const SPEECH_SELECT_MODEL_CHANNEL = 'speech:command:select-model'
export const SPEECH_SELECT_VOICE_CHANNEL = 'speech:command:select-voice'
export const SPEECH_SAVE_PREFERENCES_CHANNEL = 'speech:command:save-preferences'

export type SpeechSpeakCommand = SpeakCommand
export type SpeechSpeakOutcome = Outcome<OperationHandle, SpeechFailure>
export type SpeechTranscribeCommand = TranscribeCommand
export type SpeechTranscribeOutcome = Outcome<{ text: string }, SpeechFailure>
export type SpeechCancelTranscriptionOutcome = Outcome<void, SpeechFailure>
export type SpeechStreamCommand = StreamSpeechCommand
export type DesktopSpeechEvent = SpeechEvent
export type DesktopSpeechSnapshot = SpeechSnapshot
export type SpeechStartRealtimeCommand = StartRealtimeCommand
export type SpeechStartRealtimeOutcome = Awaited<ReturnType<SpeechFacade['startRealtime']>>
export type SpeechStopRealtimeOutcome = Awaited<ReturnType<SpeechFacade['stopRealtime']>>
export type SpeechModelModality = Parameters<SpeechFacade['selectModel']>[0]
export type SpeechModelSelection = Parameters<SpeechFacade['selectModel']>[1]
export type SpeechVoiceSelection = Parameters<SpeechFacade['selectVoice']>[0]
export type SpeechSelectionOutcome = Awaited<ReturnType<SpeechFacade['selectModel']>>
export type SpeechPreferencesPatch = Parameters<SpeechFacade['savePreferences']>[0]
export type SpeechPreferencesOutcome = Awaited<ReturnType<SpeechFacade['savePreferences']>>
