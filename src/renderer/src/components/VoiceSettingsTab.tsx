import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SILENCE_AFTER_SPEECH_CHOICES_MS,
  SPEAKER_DRAIN_CHOICES_MS,
  VOICE_DELAY_LABELS,
  VOICE_TURN_LABELS,
  firstRuntimeVoiceForLanguage,
  kokoroVoiceLabel,
  runtimeSpeechLanguages,
  runtimeVoiceLanguage,
  runtimeVoicesForLanguage,
  secondsLabel,
  type RuntimeSpeechVoice,
  type VoiceTurnMode
} from '@offgrid/application'
import {
  DEFAULT_VOICE_PREFERENCES,
  VOICE_PREFERENCES_CHANGED_EVENT,
  publishVoicePreferences,
  readVoicePreferences,
  type VoicePreferences
} from '@renderer/lib/voice-preferences'
import { SettingsRow } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import { SettingsSlider } from './SettingsSlider'
import type { SettingsWriteOutcome } from './SettingsTextField'
import { LoadingDots } from './ui/loading-dots'
import { failed, ok } from '@offgrid/application'
import { projectProgress } from '@offgrid/ui'
import { useTransferRate } from '@renderer/hooks/useTransferRate'
import { downloadProgressSummary } from '@renderer/lib/download-progress'

/** Playback speed as the row has always shown it. */
const speedLabel = (speed: number): string => `${speed.toFixed(1)}x`

type AssetsState = 'loading' | 'checking' | 'downloading' | 'ready' | 'error'
type TestState = 'idle' | 'generating' | 'playing' | 'error'
interface VoiceAssetProgress {
  percentage: number | null
  downloadedBytes?: number
  totalBytes?: number | null
  bytesPerSecond?: number
}

const TURN_ORDER: VoiceTurnMode[] = ['tap', 'silence', 'handsfree']

function PreferenceButtons<T extends string | number>({
  options,
  selected,
  onSelect,
  label
}: {
  options: readonly { id: T; label: string }[]
  selected: T
  onSelect: (id: T) => void
  label: string
}): React.JSX.Element {
  return (
    <div
      className="grid grid-flow-col auto-cols-fr gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1"
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={selected === option.id}
          onClick={() => onSelect(option.id)}
          className={`rounded px-2 py-1.5 text-[11px] transition-colors ${selected === option.id ? 'bg-green-500/15 text-green-400' : 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function VoiceAssetStatus({
  state,
  voice,
  language,
  progress,
  onRetry
}: {
  state: AssetsState
  voice: string
  language: string
  progress: ReturnType<typeof projectProgress>
  onRetry: () => void
}): React.JSX.Element {
  if (state === 'loading' || state === 'checking') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-4 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5 text-xs text-neutral-400"
      >
        <LoadingDots />
        {state === 'loading' ? 'Loading voices...' : 'Checking voice files...'}
      </div>
    )
  }
  if (state === 'downloading') {
    const summary = downloadProgressSummary(progress)
    return (
      <div
        role="status"
        aria-live="polite"
        className="mb-4 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5 text-xs text-neutral-400"
      >
        <LoadingDots />
        Downloading {runtimeVoiceLanguage({ id: voice })?.label ?? language} audio
        {progress.determinate ? ` - ${Math.round(progress.percentage ?? 0)}%` : '...'}
        {` · ${summary.bytes} · ${summary.rate}`}
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div
        role="alert"
        className="mb-4 flex items-center justify-between gap-3 text-xs text-red-400"
      >
        <span>Could not load voices. Check your connection and retry.</span>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-red-500/50 px-2.5 py-1 text-red-300"
        >
          Retry
        </button>
      </div>
    )
  }
  return (
    <p role="status" className="mb-4 text-xs text-neutral-500">
      {runtimeVoiceLanguage({ id: voice })?.label ?? language} voice ready.
    </p>
  )
}

export function VoiceSettingsTab(): React.JSX.Element {
  const [voices, setVoices] = useState<RuntimeSpeechVoice[]>([])
  const [voice, setVoice] = useState('af_heart')
  const [language, setLanguage] = useState('en-US')
  const [assetsState, setAssetsState] = useState<AssetsState>('loading')
  const [progress, setProgress] = useState<VoiceAssetProgress>({ percentage: 0 })
  const [testState, setTestState] = useState<TestState>('idle')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [preferences, setPreferences] = useState(DEFAULT_VOICE_PREFERENCES)
  const testOperationRef = useRef<string | null>(null)
  const requestedVoiceRef = useRef('af_heart')
  const transferRate = useTransferRate()

  const requestVoices = useCallback((): void => {
    void window.api
      .ttsVoices()
      .then((runtimeVoices: RuntimeSpeechVoice[]) => {
        if (!runtimeVoices.length) throw new Error('No voices available')
        setVoices(runtimeVoices)
      })
      .catch((error: unknown) => {
        console.error('Could not load text-to-speech voices.', error)
        setAssetsState('error')
      })
  }, [])
  const loadVoices = useCallback((): void => {
    setAssetsState('loading')
    setProgress({ percentage: 0 })
    requestVoices()
  }, [requestVoices])

  useEffect(() => {
    const stopProgress = window.api.onTtsVoiceProgress(
      ({ voiceId, progress: percentage, sampledAtMs, ...next }) => {
        if (voiceId && voiceId !== requestedVoiceRef.current) return
        setAssetsState('downloading')
        setProgress({
          percentage,
          ...next,
          bytesPerSecond: transferRate.measure(next.downloadedBytes, sampledAtMs)
        })
      }
    )
    const stopSpeechEvents = window.api.speechCommands.onEvent((event) => {
      if (event.type !== 'speech_finished' || event.operationId !== testOperationRef.current) return
      testOperationRef.current = null
      setTestState(
        event.outcome.kind === 'spoken' || event.outcome.kind === 'interrupted' ? 'idle' : 'error'
      )
    })
    requestVoices()
    void window.api
      .getSettings()
      .then((settings) => {
        const savedVoice = typeof settings.ttsVoice === 'string' ? settings.ttsVoice : null
        if (savedVoice) {
          setVoice(savedVoice)
          setLanguage(runtimeVoiceLanguage({ id: savedVoice })?.code ?? 'en-US')
        }
        setPreferences(readVoicePreferences(settings))
      })
      .catch((error: unknown) => {
        console.error('Could not load voice settings.', error)
      })
      .finally(() => setSettingsLoaded(true))
    return () => {
      stopProgress()
      stopSpeechEvents()
      if (testOperationRef.current) {
        testOperationRef.current = null
        void window.api.speechCommands.interrupt().catch((error) => {
          console.error('Could not stop the voice sample.', error)
        })
      }
    }
  }, [requestVoices])

  useEffect(() => {
    if (!settingsLoaded || !voices.some(({ id }) => id === voice)) return
    requestedVoiceRef.current = voice
    // A new voice is a new download: measuring its first chunk against the previous voice's last
    // one would report a rate that never happened.
    transferRate.reset()
    void Promise.resolve()
      .then(() => {
        setAssetsState('checking')
        setProgress({ percentage: 0 })
        return window.api.prepareTtsVoice(voice)
      })
      .then(() => {
        if (requestedVoiceRef.current === voice) {
          setProgress({ percentage: 100 })
          setAssetsState('ready')
        }
      })
      .catch((error: unknown) => {
        console.error(`Could not prepare text-to-speech voice ${voice}.`, error)
        if (requestedVoiceRef.current === voice) setAssetsState('error')
      })
  }, [settingsLoaded, voice, voices])

  useEffect(() => {
    if (assetsState !== 'ready' || !voices.length || voices.some(({ id }) => id === voice)) return
    const fallback = firstRuntimeVoiceForLanguage(voices, language) ?? voices[0]
    if (!fallback) return
    void Promise.resolve().then(() => {
      setVoice(fallback.id)
      setLanguage(runtimeVoiceLanguage(fallback)?.code ?? 'en-US')
      void Promise.resolve(window.api.saveSetting('ttsVoice', fallback.id)).catch(
        (error: unknown) => {
          console.error(`Could not save fallback text-to-speech voice ${fallback.id}.`, error)
        }
      )
    })
  }, [assetsState, language, voice, voices])

  useEffect(() => {
    const updatePreferences = (event: Event): void => {
      setPreferences((event as CustomEvent<VoicePreferences>).detail)
    }
    window.addEventListener(VOICE_PREFERENCES_CHANGED_EVENT, updatePreferences)
    return () => window.removeEventListener(VOICE_PREFERENCES_CHANGED_EVENT, updatePreferences)
  }, [])

  /**
   * Save one voice preference and publish the committed set once. Returns the outcome so a caller
   * that shows failure - the speed slider - can, while the callers that only flip a choice keep
   * the revert-on-failure behaviour below.
   */
  const commitPreference = useCallback(
    async <K extends keyof VoicePreferences>(
      key: K,
      value: VoicePreferences[K],
      settingKey: string
    ): Promise<SettingsWriteOutcome> => {
      const previous = preferences
      const next = { ...preferences, [key]: value }
      setPreferences(next)
      try {
        await window.api.saveSetting(settingKey, value)
        publishVoicePreferences(next)
        return ok(undefined)
      } catch (error) {
        console.error(`Could not save voice preference ${settingKey}.`, error)
        setPreferences(previous)
        return failed({ message: 'This preference could not be saved.' })
      }
    },
    [preferences]
  )

  const persistPreference = useCallback(
    <K extends keyof VoicePreferences>(
      key: K,
      value: VoicePreferences[K],
      settingKey: string
    ): void => {
      void commitPreference(key, value, settingKey)
    },
    [commitPreference]
  )

  const commitSpeed = useCallback(
    (speed: number) => commitPreference('speed', speed, 'ttsSpeed'),
    [commitPreference]
  )

  const filteredVoices = useMemo(
    () => runtimeVoicesForLanguage(voices.length ? voices : [{ id: voice }], language),
    [language, voice, voices]
  )

  useEffect(() => {
    const selected = voices.find(({ id }) => id === voice)
    const selectedLanguage = selected ? runtimeVoiceLanguage(selected)?.code : undefined
    if (selectedLanguage && selectedLanguage !== language) {
      void Promise.resolve().then(() => setLanguage(selectedLanguage))
    }
  }, [language, voice, voices])

  const pickVoice = (nextVoice: string): void => {
    const previous = { voice, language }
    const runtimeVoice = voices.find(({ id }) => id === nextVoice) ?? { id: nextVoice }
    setVoice(nextVoice)
    setLanguage(runtimeVoiceLanguage(runtimeVoice)?.code ?? language)
    void Promise.resolve(window.api.saveSetting('ttsVoice', nextVoice)).catch((error: unknown) => {
      console.error(`Could not save text-to-speech voice ${nextVoice}.`, error)
      setVoice(previous.voice)
      setLanguage(previous.language)
    })
  }

  const pickLanguage = (nextLanguage: string): void => {
    const matching = firstRuntimeVoiceForLanguage(voices, nextLanguage)?.id
    if (!matching) return
    setLanguage(nextLanguage)
    pickVoice(matching)
  }

  const testVoice = async (): Promise<void> => {
    const operationId = crypto.randomUUID()
    testOperationRef.current = operationId
    setTestState('generating')
    try {
      const outcome = await window.api.speechCommands.speak({
        text: 'This is the Off Grid AI voice.',
        voice,
        language,
        speed: preferences.speed,
        operationId
      })
      if (testOperationRef.current !== operationId) return
      if (!outcome.ok) {
        testOperationRef.current = null
        setTestState('error')
        return
      }
      setTestState('playing')
    } catch (error: unknown) {
      console.error('Could not play the text-to-speech voice sample.', error)
      if (testOperationRef.current === operationId) testOperationRef.current = null
      setTestState('error')
    }
  }

  const turnDescription = VOICE_TURN_LABELS[preferences.turnMode].description
  const assetProgress = projectProgress(progress)
  return (
    <>
      <SettingsRow
        label="Interface mode"
        hint={
          preferences.voiceMode
            ? 'Responses appear as voice notes.'
            : 'Responses appear as text with optional playback.'
        }
      >
        <PreferenceButtons
          label="Interface mode"
          options={[
            { id: 'chat', label: 'Chat' },
            { id: 'voice', label: 'Voice' }
          ]}
          selected={preferences.voiceMode ? 'voice' : 'chat'}
          onSelect={(value) =>
            persistPreference('voiceMode', value === 'voice', 'composerVoiceMode')
          }
        />
      </SettingsRow>

      {!preferences.voiceMode ? (
        <SettingsRow label="Text-to-speech" hint="Show playback on assistant messages.">
          <PreferenceButtons
            label="Text-to-speech"
            options={[
              { id: 'on', label: 'On' },
              { id: 'off', label: 'Off' }
            ]}
            selected={preferences.ttsEnabled ? 'on' : 'off'}
            onSelect={(value) => persistPreference('ttsEnabled', value === 'on', 'ttsEnabled')}
          />
        </SettingsRow>
      ) : null}

      <SettingsRow label="Voice turns" hint={turnDescription}>
        <PreferenceButtons
          label="Voice turns"
          options={TURN_ORDER.map((id) => ({ id, label: VOICE_TURN_LABELS[id].label }))}
          selected={preferences.turnMode}
          onSelect={(value) => persistPreference('turnMode', value, 'composerVoiceTurnMode')}
        />
      </SettingsRow>

      {preferences.turnMode !== 'tap' ? (
        <SettingsRow
          label={VOICE_DELAY_LABELS.silenceAfterSpeech.label}
          hint={VOICE_DELAY_LABELS.silenceAfterSpeech.description}
        >
          <PreferenceButtons
            label={VOICE_DELAY_LABELS.silenceAfterSpeech.label}
            options={SILENCE_AFTER_SPEECH_CHOICES_MS.map((id) => ({ id, label: secondsLabel(id) }))}
            selected={preferences.silenceAfterSpeechMs}
            onSelect={(value) =>
              persistPreference('silenceAfterSpeechMs', value, 'voiceSilenceAfterSpeechMs')
            }
          />
        </SettingsRow>
      ) : null}

      {preferences.turnMode === 'handsfree' ? (
        <SettingsRow
          label={VOICE_DELAY_LABELS.speakerDrain.label}
          hint={VOICE_DELAY_LABELS.speakerDrain.description}
        >
          <PreferenceButtons
            label={VOICE_DELAY_LABELS.speakerDrain.label}
            options={SPEAKER_DRAIN_CHOICES_MS.map((id) => ({ id, label: secondsLabel(id) }))}
            selected={preferences.speakerDrainMs}
            onSelect={(value) => persistPreference('speakerDrainMs', value, 'voiceSpeakerDrainMs')}
          />
        </SettingsRow>
      ) : null}

      <SettingsRow
        label="Language"
        controlId="tts-language"
        hint="Choose the language for spoken replies. Audio files download once on first use."
      >
        <SettingsSelect
          id="tts-language"
          label="Language selection"
          value={language}
          onValueChange={pickLanguage}
          disabled={assetsState === 'loading' || assetsState === 'downloading'}
          options={runtimeSpeechLanguages(voices.length ? voices : [{ id: voice }]).map((item) => ({
            value: item.code,
            label: item.label
          }))}
        />
      </SettingsRow>

      <VoiceAssetStatus
        state={assetsState}
        voice={voice}
        language={language}
        progress={assetProgress}
        onRetry={loadVoices}
      />

      <SettingsRow
        label="Voice"
        controlId="tts-voice"
        hint="Voices available for the selected language."
      >
        <SettingsSelect
          id="tts-voice"
          label="Voice selection"
          value={voice}
          onValueChange={pickVoice}
          disabled={assetsState !== 'ready'}
          options={filteredVoices.map(({ id, label }) => ({
            value: id,
            label: label ?? kokoroVoiceLabel(id)
          }))}
        />
      </SettingsRow>

      <SettingsSlider
        id="tts-speed"
        label="Playback speed"
        min={0.5}
        max={2}
        step={0.1}
        value={preferences.speed}
        format={speedLabel}
        commit={commitSpeed}
      />

      <button
        type="button"
        onClick={() => void testVoice()}
        disabled={testState === 'generating' || testState === 'playing'}
        className="rounded-md bg-green-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-green-500 disabled:opacity-40"
      >
        {testState === 'generating'
          ? 'Generating...'
          : testState === 'playing'
            ? 'Playing...'
            : 'Test voice'}
      </button>
      {testState === 'error' ? (
        <span className="ml-2 text-[11px] text-red-400">
          Could not play this voice. Check your audio output and retry.
        </span>
      ) : null}
    </>
  )
}
