import type { RecordedAudio } from '@offgrid/speech'

export const SPEECH_MICROPHONE_REQUEST_CHANNEL = 'speech:microphone:request'
export const SPEECH_MICROPHONE_RESULT_CHANNEL = 'speech:microphone:result'
export const SPEECH_MICROPHONE_LEVEL_CHANNEL = 'speech:microphone:level'

export type SpeechMicrophoneRequest =
  | { type: 'start'; requestId: string }
  | { type: 'stop'; requestId: string; captureId: string }
  | { type: 'cancel'; requestId: string; captureId: string }

export type SpeechMicrophoneResult =
  | { type: 'start'; requestId: string; status: 'completed'; echoCancelled: boolean }
  | { type: 'stop'; requestId: string; status: 'completed'; audio: RecordedAudio }
  | { type: 'cancel'; requestId: string; status: 'completed' }
  | {
      type: SpeechMicrophoneRequest['type']
      requestId: string
      status: 'failed' | 'cancelled'
      error?: string
    }

export interface SpeechMicrophoneLevel {
  captureId: string
  rms: number
}
