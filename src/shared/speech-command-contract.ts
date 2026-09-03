import type { OperationHandle, Outcome, SpeakCommand, SpeechFailure } from '@offgrid/application'

export const SPEECH_SPEAK_CHANNEL = 'speech:command:speak'
export const SPEECH_INTERRUPT_CHANNEL = 'speech:command:interrupt'

export type SpeechSpeakCommand = SpeakCommand
export type SpeechSpeakOutcome = Outcome<OperationHandle, SpeechFailure>
