export const SPEECH_TEXT_CLEAN_REQUEST_CHANNEL = 'speech:text-clean:request'
export const SPEECH_TEXT_CLEAN_RESULT_CHANNEL = 'speech:text-clean:result'

export type SpeechTextCleanRequest =
  | { type: 'clean'; requestId: string; text: string }
  | { type: 'cancel'; requestId: string }

export type SpeechTextCleanResult =
  | { requestId: string; status: 'completed'; text: string }
  | { requestId: string; status: 'cancelled' }
  | { requestId: string; status: 'failed'; error: string }
