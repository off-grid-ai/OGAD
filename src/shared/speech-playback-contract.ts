import type { SynthesizedAudio } from '@offgrid/speech'

export const SPEECH_PLAYBACK_REQUEST_CHANNEL = 'speech:playback:request'
export const SPEECH_PLAYBACK_RESULT_CHANNEL = 'speech:playback:result'

export type SpeechPlaybackRequest =
  | { type: 'play'; requestId: string; audio: SynthesizedAudio }
  | { type: 'stop'; requestId: string }

export type SpeechPlaybackResult =
  | { requestId: string; status: 'completed' }
  | { requestId: string; status: 'cancelled' }
  | { requestId: string; status: 'failed'; error: string }
