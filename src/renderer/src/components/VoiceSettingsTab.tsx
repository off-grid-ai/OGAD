import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  KOKORO_VOICE_CATALOG,
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
} from '@offgrid/speech'
import {
  DEFAULT_VOICE_PREFERENCES,
  VOICE_PREFERENCES_CHANGED_EVENT,
  publishVoicePreferences,
  readVoicePreferences,
  type VoicePreferences
} from '@renderer/lib/voice-preferences'
import { parseRemoteVisionModelId } from '../../../shared/remote-vision-server'
import { SettingsRow } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import { BackendPreferencesSection } from './ProcessingControls'
import { SettingsSection } from './SettingsSection'
import { LoadingDots } from './ui/loading-dots'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import ElasticSlider from '@offgrid/operator-ui/operator/bits/elastic-slider'
import { ArrowClockwise, CircleNotch, Play, SpeakerHigh } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { LiveStatus } from '@offgrid/operator-ui/operator/presence'
import { AnimatedNumber } from '@offgrid/operator-ui/operator/motion/animated-number'
import { formatTransferSpeed } from '@offgrid/sync'
import { projectProgress } from '@offgrid/ui'
import { formatStorageBytes } from './setup/storage-format'

type AssetsState = 'loading' | 'checking' | 'downloading' | 'ready' | 'error'
/** A download that reports nothing for this long has stopped; offer Retry instead of waiting. */
const VOICE_DOWNLOAD_STALL_MS = 30_000
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
  // Segmented speaks in string ids; the numeric delay choices map back on the way out.
  return (
    <Segmented
      label={label}
      size="sm"
      value={String(selected)}
      onValueChange={(id) => {
        const option = options.find((candidate) => String(candidate.id) === id)
        if (option) onSelect(option.id)
      }}
      options={options.map((option) => ({ id: String(option.id), label: option.label }))}
    />
  )
}

export function VoiceSettingsTab(): React.JSX.Element {
  const [voices, setVoices] = useState<RuntimeSpeechVoice[]>([])
  const [remoteVoice, setRemoteVoice] = useState(false)
  const [miniMaxSpeech28, setMiniMaxSpeech28] = useState(false)
  const [voice, setVoice] = useState('af_heart')
  const [language, setLanguage] = useState('en-US')
  const [assetsState, setAssetsState] = useState<AssetsState>('loading')
  const [voiceLoadError, setVoiceLoadError] = useState(
    'Could not load voices. Check your connection and retry.'
  )
  const [progress, setProgress] = useState<VoiceAssetProgress>({ percentage: 0 })
  const [testState, setTestState] = useState<TestState>('idle')
  const testVoiceLabel =
    testState === 'generating'
      ? 'Generating...'
      : testState === 'playing'
        ? 'Playing...'
        : 'Test voice'
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [preferences, setPreferences] = useState(DEFAULT_VOICE_PREFERENCES)
  const testAudioRef = useRef<HTMLAudioElement | null>(null)
  const requestedVoiceRef = useRef('af_heart')

  const loadVoices = useCallback((): void => {
    setAssetsState('loading')
    setVoices([])
    setVoiceLoadError('Could not load voices. Check your connection and retry.')
    setProgress({ percentage: 0 })
    const modelApi = window.api as Partial<Pick<typeof window.api, 'getActiveModalities'>>
    void Promise.resolve(modelApi.getActiveModalities?.())
      .then((active) => {
        const remote = active?.speech?.startsWith('remote-vision:') ?? false
        setRemoteVoice(remote)
        setMiniMaxSpeech28(
          remote && /:minimax%2fspeech-2\.8-(?:hd|turbo)$/i.test(active?.speech ?? '')
        )
        // A remote Kokoro model legitimately offers the same speakers as the local runtime.
        const remoteKokoro = /kokoro/i.test(
          parseRemoteVisionModelId(active?.speech ?? '')?.modelId ?? ''
        )
        return window.api
          .ttsVoices()
          .then((runtimeVoices) => ({ remote, remoteKokoro, runtimeVoices }))
      })
      .then(({ remote, remoteKokoro, runtimeVoices }) => {
        if (
          remote &&
          !remoteKokoro &&
          runtimeVoices.length &&
          runtimeVoices.every(({ id }: RuntimeSpeechVoice) =>
            KOKORO_VOICE_CATALOG.some((local) => local.id === id)
          )
        ) {
          setVoiceLoadError('The desktop speech service is out of date. Restart the app and retry.')
          throw new Error('Remote model returned local speakers')
        }
        if (!runtimeVoices.length && !remote) throw new Error('No voices available')
        setVoices(runtimeVoices)
        if (remote) setAssetsState('ready')
      })
      .catch(() => setAssetsState('error'))
  }, [])

  useEffect(() => {
    const stopProgress = window.api.onTtsVoiceProgress(
      ({ voiceId, progress: percentage, ...next }) => {
        if (voiceId && voiceId !== requestedVoiceRef.current) return
        setAssetsState('downloading')
        setProgress({ percentage, ...next })
      }
    )
    loadVoices()
    void window.api
      .getSettings()
      .then((settings) => {
        const savedVoice = typeof settings.ttsVoice === 'string' ? settings.ttsVoice : null
        if (savedVoice) {
          setVoice(savedVoice)
        }
        setPreferences(readVoicePreferences(settings))
      })
      .catch(() => {})
      .finally(() => setSettingsLoaded(true))
    return () => {
      stopProgress()
      testAudioRef.current?.pause()
    }
  }, [loadVoices])

  useEffect(() => {
    if (remoteVoice || !settingsLoaded || !voices.some(({ id }) => id === voice)) return
    requestedVoiceRef.current = voice
    setAssetsState('checking')
    setProgress({ percentage: 0 })
    void window.api
      .prepareTtsVoice(voice)
      .then(() => {
        if (requestedVoiceRef.current === voice) {
          setProgress({ percentage: 100 })
          setAssetsState('ready')
        }
      })
      .catch(() => {
        if (requestedVoiceRef.current === voice) setAssetsState('error')
      })
  }, [remoteVoice, settingsLoaded, voice, voices])

  // Every progress report restarts the clock, so only a download that has gone quiet times out,
  // for example one that sits at 100% with 0 MB of 0 MB.
  useEffect(() => {
    if (assetsState !== 'downloading') return
    const timer = window.setTimeout(() => {
      setVoiceLoadError('The voice download stopped. Retry to download it again.')
      setAssetsState('error')
    }, VOICE_DOWNLOAD_STALL_MS)
    return () => window.clearTimeout(timer)
  }, [assetsState, progress])

  useEffect(() => {
    if (!settingsLoaded || !voices.length || voices.some(({ id }) => id === voice)) return
    if (assetsState !== 'ready' && (remoteVoice || assetsState !== 'loading')) return
    const fallback =
      (remoteVoice
        ? voices.find((candidate) => candidate.language === language)
        : firstRuntimeVoiceForLanguage(voices, language)) ?? voices[0]
    if (!fallback) return
    setVoice(fallback.id)
    setLanguage(
      remoteVoice && !fallback.language
        ? 'en-US'
        : (runtimeVoiceLanguage(fallback)?.code ?? 'en-US')
    )
    void Promise.resolve(window.api.saveSetting('ttsVoice', fallback.id)).catch(() => {})
  }, [assetsState, language, remoteVoice, settingsLoaded, voice, voices])

  useEffect(() => {
    const updatePreferences = (event: Event): void => {
      setPreferences((event as CustomEvent<VoicePreferences>).detail)
    }
    window.addEventListener(VOICE_PREFERENCES_CHANGED_EVENT, updatePreferences)
    return () => window.removeEventListener(VOICE_PREFERENCES_CHANGED_EVENT, updatePreferences)
  }, [])

  const persistPreference = useCallback(
    <K extends keyof VoicePreferences>(key: K, value: VoicePreferences[K], settingKey: string) => {
      const previous = preferences
      const next = { ...preferences, [key]: value }
      setPreferences(next)
      void Promise.resolve(window.api.saveSetting(settingKey, value))
        .then(() => publishVoicePreferences(next))
        .catch(() => setPreferences(previous))
    },
    [preferences]
  )

  const availableLanguages = useMemo(
    () =>
      runtimeSpeechLanguages(
        remoteVoice
          ? voices.filter((candidate) => candidate.language)
          : voices.length
            ? voices
            : [{ id: voice }]
      ),
    [remoteVoice, voice, voices]
  )
  const showLanguage = !remoteVoice || availableLanguages.length > 1
  const filteredVoices = useMemo(
    () =>
      remoteVoice
        ? showLanguage
          ? voices.filter((candidate) => !candidate.language || candidate.language === language)
          : voices
        : runtimeVoicesForLanguage(voices.length ? voices : [{ id: voice }], language),
    [language, remoteVoice, showLanguage, voice, voices]
  )

  useEffect(() => {
    const selected = voices.find(({ id }) => id === voice)
    const selectedLanguage =
      selected && (!remoteVoice || selected.language)
        ? runtimeVoiceLanguage(selected)?.code
        : undefined
    if (selectedLanguage && selectedLanguage !== language) setLanguage(selectedLanguage)
  }, [language, remoteVoice, voice, voices])

  const pickVoice = (nextVoice: string): void => {
    const previous = { voice, language }
    const runtimeVoice = voices.find(({ id }) => id === nextVoice) ?? { id: nextVoice }
    setVoice(nextVoice)
    setLanguage(
      remoteVoice && !runtimeVoice.language
        ? language
        : (runtimeVoiceLanguage(runtimeVoice)?.code ?? language)
    )
    void Promise.resolve(window.api.saveSetting('ttsVoice', nextVoice)).catch(() => {
      setVoice(previous.voice)
      setLanguage(previous.language)
    })
  }

  const pickLanguage = (nextLanguage: string): void => {
    const matching = (
      remoteVoice
        ? voices.find((candidate) => candidate.language === nextLanguage)
        : firstRuntimeVoiceForLanguage(voices, nextLanguage)
    )?.id
    if (!matching) return
    setLanguage(nextLanguage)
    pickVoice(matching)
  }

  const testVoice = async (): Promise<void> => {
    setTestState('generating')
    try {
      const result = await window.api.speak(
        'This is the Off Grid AI voice.',
        voices.length ? voice : undefined
      )
      if (!result.dataUrl) throw new Error('No audio returned')
      const audio = new Audio(result.dataUrl)
      testAudioRef.current = audio
      audio.playbackRate = preferences.speed
      audio.onended = () => setTestState('idle')
      audio.onerror = () => setTestState('error')
      setTestState('playing')
      await audio.play()
    } catch {
      setTestState('error')
    }
  }

  const turnDescription = VOICE_TURN_LABELS[preferences.turnMode].description
  const assetProgress = projectProgress(progress)
  const turnLabel = VOICE_TURN_LABELS[preferences.turnMode].label
  const conversationSummary = preferences.voiceMode
    ? `Voice notes · ${turnLabel} turns`
    : `Chat · playback ${preferences.ttsEnabled ? 'on' : 'off'} · ${turnLabel} turns`
  const selectedVoice = voices.find(({ id }) => id === voice)
  const voiceName =
    remoteVoice && !voices.length
      ? 'Remote model voice'
      : (selectedVoice?.label ?? kokoroVoiceLabel(voice))
  const languageName = availableLanguages.find((item) => item.code === language)?.label
  const speechSummary = [
    voiceName,
    showLanguage ? languageName : undefined,
    `speaks at ${preferences.speed.toFixed(1)}x`
  ]
    .filter(Boolean)
    .join(' · ')
  // Testing a voice acts on the Voice select, so the button sits beside it.
  const testVoiceButton = (
    <IconTip label={testVoiceLabel}>
      <Button
        type="button"
        size="icon-sm"
        aria-label={testVoiceLabel}
        aria-busy={testState === 'generating' || undefined}
        onClick={() => void testVoice()}
        disabled={testState === 'generating' || testState === 'playing'}
        className="bg-green-600 text-white hover:bg-green-500 disabled:opacity-40"
      >
        <GlyphSwap
          glyphKey={testState === 'generating' || testState === 'playing' ? testState : 'idle'}
        >
          {testState === 'generating' ? (
            <CircleNotch className="animate-spin" />
          ) : testState === 'playing' ? (
            <SpeakerHigh />
          ) : (
            <Play weight="fill" />
          )}
        </GlyphSwap>
      </Button>
    </IconTip>
  )
  const testVoiceError =
    testState === 'error' ? (
      <p className="pb-2 text-[11px] text-red-400">
        Could not play this voice. Check your audio output and retry.
      </p>
    ) : null
  return (
    <>
      <SettingsSection
        id="voice.conversation"
        title="Conversation"
        summary={conversationSummary}
        defaultOpen
      >
        <SettingsRow
          inline
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
          <SettingsRow inline label="Text-to-speech" hint="Show playback on assistant messages.">
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

        <SettingsRow inline label="Voice turns" hint={turnDescription}>
          <PreferenceButtons
            label="Voice turns"
            options={TURN_ORDER.map((id) => ({ id, label: VOICE_TURN_LABELS[id].label }))}
            selected={preferences.turnMode}
            onSelect={(value) => persistPreference('turnMode', value, 'composerVoiceTurnMode')}
          />
        </SettingsRow>

        {preferences.turnMode !== 'tap' ? (
          <SettingsRow
            inline
            label={VOICE_DELAY_LABELS.silenceAfterSpeech.label}
            hint={VOICE_DELAY_LABELS.silenceAfterSpeech.description}
          >
            <PreferenceButtons
              label={VOICE_DELAY_LABELS.silenceAfterSpeech.label}
              options={SILENCE_AFTER_SPEECH_CHOICES_MS.map((id) => ({
                id,
                label: secondsLabel(id)
              }))}
              selected={preferences.silenceAfterSpeechMs}
              onSelect={(value) =>
                persistPreference('silenceAfterSpeechMs', value, 'voiceSilenceAfterSpeechMs')
              }
            />
          </SettingsRow>
        ) : null}

        {preferences.turnMode === 'handsfree' ? (
          <SettingsRow
            inline
            label={VOICE_DELAY_LABELS.speakerDrain.label}
            hint={VOICE_DELAY_LABELS.speakerDrain.description}
          >
            <PreferenceButtons
              label={VOICE_DELAY_LABELS.speakerDrain.label}
              options={SPEAKER_DRAIN_CHOICES_MS.map((id) => ({ id, label: secondsLabel(id) }))}
              selected={preferences.speakerDrainMs}
              onSelect={(value) =>
                persistPreference('speakerDrainMs', value, 'voiceSpeakerDrainMs')
              }
            />
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection id="voice.speech" title="Voice" summary={speechSummary} defaultOpen>
        {showLanguage && (
          <SettingsRow
            inline
            label="Language"
            controlId="tts-language"
            hint={
              remoteVoice
                ? 'Choose the language for spoken replies.'
                : 'Choose the language for spoken replies. Audio files download once on first use.'
            }
          >
            <SettingsSelect
              id="tts-language"
              label="Language selection"
              value={language}
              onValueChange={pickLanguage}
              disabled={assetsState === 'loading' || assetsState === 'downloading'}
              options={availableLanguages.map((item) => ({
                value: item.code,
                label: item.label
              }))}
            />
          </SettingsRow>
        )}

        {miniMaxSpeech28 && !showLanguage && (
          <SettingsRow
            inline
            label="Language"
            hint="MiniMax can speak 40 languages. It uses the language of the reply text; OpenRouter lists English-named speakers for this model."
          >
            {/* Nothing to choose: the setting reads as its value, where a control would sit. */}
            <span className="text-xs tabular-nums text-green-500">Automatic</span>
          </SettingsRow>
        )}

        {assetsState === 'loading' || assetsState === 'checking' ? (
          <div
            role="status"
            aria-live="polite"
            className="mb-2 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5 text-xs text-neutral-400"
          >
            <LoadingDots />
            <TextShimmer as="span">
              {assetsState === 'loading' ? 'Loading voices...' : 'Checking voice files...'}
            </TextShimmer>
          </div>
        ) : assetsState === 'downloading' ? (
          <div
            role="status"
            aria-live="polite"
            className="mb-2 flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 px-3.5 py-2.5 text-xs text-neutral-400"
          >
            <LoadingDots />
            Downloading {runtimeVoiceLanguage({ id: voice })?.label ?? language} audio
            {assetProgress.determinate ? (
              <>
                {' - '}
                <AnimatedNumber value={Math.round(assetProgress.percentage ?? 0)} />%
              </>
            ) : (
              '...'
            )}
            {assetProgress.totalBytes
              ? ` · ${formatStorageBytes(assetProgress.currentBytes)} / ${formatStorageBytes(assetProgress.totalBytes)}`
              : ''}
            {assetProgress.bytesPerSecond !== undefined
              ? ` · ${formatTransferSpeed(assetProgress.bytesPerSecond)}`
              : ''}
          </div>
        ) : assetsState === 'error' ? (
          <div
            role="alert"
            className="mb-2 flex items-center justify-between gap-3 text-xs text-red-400"
          >
            <span>{voiceLoadError}</span>
            <IconTip label="Retry">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Retry"
                onClick={loadVoices}
                className="shrink-0 text-red-300 hover:text-red-200"
              >
                <ArrowClockwise />
              </Button>
            </IconTip>
          </div>
        ) : (
          <LiveStatus className="mb-2 text-xs text-neutral-500">
            {remoteVoice && !voices.length
              ? 'Speaker choices are not available for this remote model.'
              : remoteVoice
                ? 'Speaker selected.'
                : `${runtimeVoiceLanguage({ id: voice })?.label ?? language} voice ready.`}
          </LiveStatus>
        )}

        {(!remoteVoice || voices.length > 0) && (
          <SettingsRow
            inline
            label="Voice"
            controlId="tts-voice"
            hint={
              showLanguage
                ? 'Voices available for the selected language.'
                : 'Speakers for the selected model.'
            }
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
            <span className="ml-2 flex shrink-0 items-center">{testVoiceButton}</span>
          </SettingsRow>
        )}

        <SettingsRow label="Playback speed" controlId="tts-speed">
          {/* Drafts while it moves and saves on blur, like the range input it replaced. */}
          <div
            id="tts-speed"
            onBlur={() => persistPreference('speed', preferences.speed, 'ttsSpeed')}
          >
            <ElasticSlider
              aria-label="Playback speed"
              className="w-full pt-4"
              value={preferences.speed}
              onValueChange={(speed: number) =>
                setPreferences((current) => ({ ...current, speed: Number(speed.toFixed(1)) }))
              }
              startingValue={0.5}
              maxValue={2}
              isStepped
              stepSize={0.1}
              formatValue={(speed) => `${speed.toFixed(1)}x`}
            />
          </div>
        </SettingsRow>

        {/* With no speaker to pick, the test button keeps a line of its own. */}
        {remoteVoice && !voices.length ? (
          <div className="flex items-center gap-2 py-2">{testVoiceButton}</div>
        ) : null}
        {testVoiceError}

        <BackendPreferencesSection modalities={['tts']} />
      </SettingsSection>
    </>
  )
}
