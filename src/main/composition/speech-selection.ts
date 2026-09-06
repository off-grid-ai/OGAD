import {
  readVoicePreferences,
  VOICE_SETTING_KEYS,
  type SpeechPlatformPorts,
  type VoicePreferences
} from '@offgrid/application'
import { getSetting, saveSetting } from '../database'

type SelectionPort = SpeechPlatformPorts['selection']
const SELECTED_VOICE_KEY = 'selectedSpeechVoice'
const LEGACY_SELECTED_VOICE_KEY = 'ttsVoice'

const selectedVoice = (): string | null =>
  getSetting<string>(SELECTED_VOICE_KEY, '') ||
  getSetting<string>(LEGACY_SELECTED_VOICE_KEY, '') ||
  null

export function createDesktopSpeechSelectionPort(): SelectionPort {
  return {
    readVoice: async () => selectedVoice(),
    async writeVoice(voice, commitVoice) {
      saveSetting(SELECTED_VOICE_KEY, voice ?? '')
      commitVoice()
    }
  }
}

type PreferencePorts = Pick<SpeechPlatformPorts, 'initialPreferences' | 'preferences'>

const readPreferences = (): VoicePreferences =>
  readVoicePreferences(
    Object.fromEntries(
      Object.values(VOICE_SETTING_KEYS).map((key) => [key, getSetting(key, undefined)])
    )
  )

/** Existing SQLite keys are I/O only; Shared owns validation, defaults, and reactive state. */
export function createDesktopSpeechPreferencePorts(): PreferencePorts {
  return {
    get initialPreferences() {
      return readPreferences()
    },
    preferences: {
      supported: Object.keys(VOICE_SETTING_KEYS) as (keyof typeof VOICE_SETTING_KEYS)[],
      async write(preferences) {
        for (const [field, key] of Object.entries(VOICE_SETTING_KEYS)) {
          saveSetting(key, preferences[field as keyof typeof preferences])
        }
      }
    }
  }
}
