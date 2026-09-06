import { ipcRenderer } from 'electron'
import {
  SPEECH_CANCEL_TRANSCRIPTION_CHANNEL,
  SPEECH_EVENT_CHANNEL,
  SPEECH_FEED_STREAM_CHANNEL,
  SPEECH_FINISH_STREAM_CHANNEL,
  SPEECH_GET_SNAPSHOT_CHANNEL,
  SPEECH_INTERRUPT_CHANNEL,
  SPEECH_SAVE_PREFERENCES_CHANNEL,
  SPEECH_SELECT_MODEL_CHANNEL,
  SPEECH_SELECT_VOICE_CHANNEL,
  SPEECH_SNAPSHOT_CHANGED_CHANNEL,
  SPEECH_SPEAK_CHANNEL,
  SPEECH_START_REALTIME_CHANNEL,
  SPEECH_STOP_REALTIME_CHANNEL,
  SPEECH_TRANSCRIBE_CHANNEL,
  type DesktopSpeechEvent,
  type DesktopSpeechSnapshot,
  type SpeechCancelTranscriptionOutcome,
  type SpeechModelModality,
  type SpeechModelSelection,
  type SpeechPreferencesOutcome,
  type SpeechPreferencesPatch,
  type SpeechSelectionOutcome,
  type SpeechSpeakCommand,
  type SpeechSpeakOutcome,
  type SpeechStartRealtimeCommand,
  type SpeechStartRealtimeOutcome,
  type SpeechStopRealtimeOutcome,
  type SpeechStreamCommand,
  type SpeechTranscribeCommand,
  type SpeechTranscribeOutcome,
  type SpeechVoiceSelection
} from '../shared/speech-command-contract'

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: unknown, value: T): void => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const speechCommandApi = {
  getSnapshot: (): Promise<DesktopSpeechSnapshot> =>
    ipcRenderer.invoke(SPEECH_GET_SNAPSHOT_CHANNEL),
  onSnapshot: (callback: (snapshot: DesktopSpeechSnapshot) => void): (() => void) =>
    subscribe(SPEECH_SNAPSHOT_CHANGED_CHANNEL, callback),
  startRealtime: (command: SpeechStartRealtimeCommand): Promise<SpeechStartRealtimeOutcome> =>
    ipcRenderer.invoke(SPEECH_START_REALTIME_CHANNEL, command),
  stopRealtime: (): Promise<SpeechStopRealtimeOutcome> =>
    ipcRenderer.invoke(SPEECH_STOP_REALTIME_CHANNEL),
  selectModel: (
    modality: SpeechModelModality,
    modelId: SpeechModelSelection
  ): Promise<SpeechSelectionOutcome> =>
    ipcRenderer.invoke(SPEECH_SELECT_MODEL_CHANNEL, modality, modelId),
  selectVoice: (voice: SpeechVoiceSelection): Promise<SpeechSelectionOutcome> =>
    ipcRenderer.invoke(SPEECH_SELECT_VOICE_CHANNEL, voice),
  savePreferences: (preferences: SpeechPreferencesPatch): Promise<SpeechPreferencesOutcome> =>
    ipcRenderer.invoke(SPEECH_SAVE_PREFERENCES_CHANNEL, preferences),
  transcribe: (command: SpeechTranscribeCommand): Promise<SpeechTranscribeOutcome> =>
    ipcRenderer.invoke(SPEECH_TRANSCRIBE_CHANNEL, command),
  cancelTranscription: (operationId: string): Promise<SpeechCancelTranscriptionOutcome> =>
    ipcRenderer.invoke(SPEECH_CANCEL_TRANSCRIPTION_CHANNEL, operationId),
  speak: (command: SpeechSpeakCommand): Promise<SpeechSpeakOutcome> =>
    ipcRenderer.invoke(SPEECH_SPEAK_CHANNEL, command),
  feedStream: (command: SpeechStreamCommand): Promise<void> =>
    ipcRenderer.invoke(SPEECH_FEED_STREAM_CHANNEL, command),
  finishStream: (operationId: string): Promise<void> =>
    ipcRenderer.invoke(SPEECH_FINISH_STREAM_CHANNEL, operationId),
  interrupt: (): Promise<void> => ipcRenderer.invoke(SPEECH_INTERRUPT_CHANNEL),
  onEvent: (callback: (event: DesktopSpeechEvent) => void): (() => void) =>
    subscribe(SPEECH_EVENT_CHANNEL, callback)
}
