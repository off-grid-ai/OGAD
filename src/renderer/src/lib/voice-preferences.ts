import {
  DEFAULT_SILENCE_AFTER_SPEECH_MS,
  DEFAULT_SPEAKER_DRAIN_MS,
  SILENCE_AFTER_SPEECH_CHOICES_MS,
  SPEAKER_DRAIN_CHOICES_MS,
  type VoiceTurnMode
} from '@offgrid/application'

export const VOICE_PREFERENCES_CHANGED_EVENT = 'og:voice-preferences-changed'

export interface VoicePreferences {
  voiceMode: boolean
  turnMode: VoiceTurnMode
  silenceAfterSpeechMs: number
  speakerDrainMs: number
  ttsEnabled: boolean
  speed: number
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  voiceMode: false,
  turnMode: 'tap',
  silenceAfterSpeechMs: DEFAULT_SILENCE_AFTER_SPEECH_MS,
  speakerDrainMs: DEFAULT_SPEAKER_DRAIN_MS,
  ttsEnabled: true,
  speed: 1
}

function oneOf<T>(value: unknown, choices: readonly T[], fallback: T): T {
  return choices.includes(value as T) ? (value as T) : fallback
}

function playbackSpeed(value: unknown): number {
  return typeof value === 'number' && value >= 0.5 && value <= 2 ? value : 1
}

/** Project the settings database into one validated voice preference contract. */
export function readVoicePreferences(settings: Record<string, unknown>): VoicePreferences {
  return {
    voiceMode:
      typeof settings.composerVoiceMode === 'boolean'
        ? settings.composerVoiceMode
        : DEFAULT_VOICE_PREFERENCES.voiceMode,
    turnMode: oneOf(
      settings.composerVoiceTurnMode,
      ['tap', 'silence', 'handsfree'] as const,
      DEFAULT_VOICE_PREFERENCES.turnMode
    ),
    silenceAfterSpeechMs: oneOf(
      settings.voiceSilenceAfterSpeechMs,
      SILENCE_AFTER_SPEECH_CHOICES_MS,
      DEFAULT_VOICE_PREFERENCES.silenceAfterSpeechMs
    ),
    speakerDrainMs: oneOf(
      settings.voiceSpeakerDrainMs,
      SPEAKER_DRAIN_CHOICES_MS,
      DEFAULT_VOICE_PREFERENCES.speakerDrainMs
    ),
    ttsEnabled:
      typeof settings.ttsEnabled === 'boolean'
        ? settings.ttsEnabled
        : DEFAULT_VOICE_PREFERENCES.ttsEnabled,
    speed: playbackSpeed(settings.ttsSpeed)
  }
}

/** Notify mounted renderer surfaces after the database write succeeds. */
export function publishVoicePreferences(preferences: VoicePreferences): void {
  window.dispatchEvent(
    new CustomEvent<VoicePreferences>(VOICE_PREFERENCES_CHANGED_EVENT, { detail: preferences })
  )
}
