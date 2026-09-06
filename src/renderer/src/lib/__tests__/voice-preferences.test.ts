// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import {
  DEFAULT_SILENCE_AFTER_SPEECH_MS,
  DEFAULT_SPEAKER_DRAIN_MS,
  SILENCE_AFTER_SPEECH_CHOICES_MS,
  SPEAKER_DRAIN_CHOICES_MS
} from '@offgrid/application'
import {
  DEFAULT_VOICE_PREFERENCES,
  VOICE_PREFERENCES_CHANGED_EVENT,
  publishVoicePreferences,
  readVoicePreferences,
  type VoicePreferences
} from '../voice-preferences'

describe('readVoicePreferences', () => {
  it('falls back to every default when the settings database is empty', () => {
    expect(readVoicePreferences({})).toEqual(DEFAULT_VOICE_PREFERENCES)
  })

  it('projects a fully populated, valid settings row', () => {
    const silence = SILENCE_AFTER_SPEECH_CHOICES_MS[0] as number
    const drain = SPEAKER_DRAIN_CHOICES_MS[0] as number
    expect(silence).not.toBe(DEFAULT_SILENCE_AFTER_SPEECH_MS)
    expect(drain).not.toBe(DEFAULT_SPEAKER_DRAIN_MS)

    expect(
      readVoicePreferences({
        composerVoiceMode: true,
        composerVoiceTurnMode: 'handsfree',
        voiceSilenceAfterSpeechMs: silence,
        voiceSpeakerDrainMs: drain,
        ttsEnabled: false,
        ttsSpeed: 1.5
      })
    ).toEqual<VoicePreferences>({
      voiceMode: true,
      turnMode: 'handsfree',
      silenceAfterSpeechMs: silence,
      speakerDrainMs: drain,
      ttsEnabled: false,
      speed: 1.5
    })
  })

  it.each(['tap', 'silence', 'handsfree'] as const)('accepts the %s turn mode', (turnMode) => {
    expect(readVoicePreferences({ composerVoiceTurnMode: turnMode }).turnMode).toBe(turnMode)
  })

  it('rejects boolean fields that are not booleans (strings from an older schema)', () => {
    const prefs = readVoicePreferences({ composerVoiceMode: 'true', ttsEnabled: 'false' })
    expect(prefs.voiceMode).toBe(DEFAULT_VOICE_PREFERENCES.voiceMode)
    expect(prefs.ttsEnabled).toBe(DEFAULT_VOICE_PREFERENCES.ttsEnabled)
  })

  it('rejects an unknown turn mode and off-list delay values', () => {
    const prefs = readVoicePreferences({
      composerVoiceTurnMode: 'push-to-talk',
      voiceSilenceAfterSpeechMs: 4321,
      voiceSpeakerDrainMs: '2000'
    })
    expect(prefs.turnMode).toBe(DEFAULT_VOICE_PREFERENCES.turnMode)
    expect(prefs.silenceAfterSpeechMs).toBe(DEFAULT_SILENCE_AFTER_SPEECH_MS)
    expect(prefs.speakerDrainMs).toBe(DEFAULT_SPEAKER_DRAIN_MS)
  })

  it.each([
    ['below the floor', 0.25],
    ['above the ceiling', 2.5],
    ['not a number', '1.5'],
    ['NaN', Number.NaN]
  ])('resets playback speed to 1 when the stored value is %s', (_case, ttsSpeed) => {
    expect(readVoicePreferences({ ttsSpeed }).speed).toBe(1)
  })

  it.each([0.5, 2])('keeps the inclusive playback speed bound %s', (ttsSpeed) => {
    expect(readVoicePreferences({ ttsSpeed }).speed).toBe(ttsSpeed)
  })
})

describe('publishVoicePreferences', () => {
  it('dispatches the changed event on window with the preferences as detail', () => {
    const listener = vi.fn()
    window.addEventListener(VOICE_PREFERENCES_CHANGED_EVENT, listener, { once: true })
    const prefs: VoicePreferences = { ...DEFAULT_VOICE_PREFERENCES, voiceMode: true }

    publishVoicePreferences(prefs)

    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0]?.[0] as CustomEvent<VoicePreferences>).detail).toEqual(prefs)
  })
})
