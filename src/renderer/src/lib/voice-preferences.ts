import {
  DEFAULT_VOICE_PREFERENCES,
  readVoicePreferences,
  type VoicePreferences
} from '@offgrid/application'

export { DEFAULT_VOICE_PREFERENCES, readVoicePreferences, type VoicePreferences }

export const VOICE_PREFERENCES_CHANGED_EVENT = 'og:voice-preferences-changed'

/** Notify mounted renderer surfaces after the database write succeeds. */
export function publishVoicePreferences(preferences: VoicePreferences): void {
  window.dispatchEvent(
    new CustomEvent<VoicePreferences>(VOICE_PREFERENCES_CHANGED_EVENT, { detail: preferences })
  )
}
