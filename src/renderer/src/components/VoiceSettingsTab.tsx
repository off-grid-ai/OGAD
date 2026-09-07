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
  speechFailureMessage,
  type RuntimeSpeechVoice
} from '@offgrid/application'
import { VOICE_TURN_MODES, speechOutcomeMessage } from '@offgrid/application'
import { useSpeechProjection, type SpeechProjection } from '@renderer/hooks/useSpeechProjection'
import type { VoicePreferences } from '@renderer/lib/voice-preferences'
import { SettingsRow } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import { SettingsSlider } from './SettingsSlider'
import type { SettingsWriteOutcome } from './SettingsTextField'
import { LoadingDots } from './ui/loading-dots'
import { failed, ok } from '@offgrid/application'
import { projectProgress } from '@offgrid/ui'
import { useTransferRate } from '@renderer/hooks/useTransferRate'
import { downloadProgressSummary } from '@renderer/lib/download-progress'

const speedLabel = (speed: number): string => `${speed.toFixed(1)}x`
const selectedLanguage = (voice: string): string =>
  runtimeVoiceLanguage({ id: voice })?.code ?? 'en-US'

type AssetsState = 'loading' | 'checking' | 'downloading' | 'ready' | 'error'
type TestState = 'idle' | 'generating' | 'playing' | 'error' | 'unavailable'
interface VoiceAssetProgress {
  percentage: number | null
  downloadedBytes?: number
  totalBytes?: number | null
  bytesPerSecond?: number
}

function previewState(
  projection: SpeechProjection,
  operationId: string | null,
  commandFailed: boolean
): TestState {
  if (projection.status === 'loading') return 'unavailable'
  if (commandFailed || projection.status === 'failed') return 'error'
  if (!operationId) return 'idle'
  const { active, recent } = projection.snapshot.playbackOperations
  const operation =
    active?.operationId === operationId
      ? active
      : recent.find((item) => item.operationId === operationId)
  if (!operation) return 'generating'
  if (operation.status === 'active') {
    return projection.snapshot.playback.status === 'synthesizing' ? 'generating' : 'playing'
  }
  if (!operation.outcome || operation.outcome.kind === 'nothing-to-speak') return 'idle'
  return speechOutcomeMessage(operation.outcome) ? 'error' : 'idle'
}

const speechStateError = (projection: SpeechProjection): string | null => {
  if (projection.status === 'failed') return projection.failure.message
  const failure = projection.snapshot?.models.failure
  return failure ? speechFailureMessage(failure) : null
}

const previewLabel = (state: TestState): string => {
  if (state === 'generating') return 'Generating...'
  if (state === 'playing') return 'Playing...'
  if (state === 'unavailable') return 'Loading...'
  return 'Test voice'
}

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

function VoiceSettingsContent({
  speechProjection
}: {
  speechProjection: Extract<SpeechProjection, { status: 'ready' }>
}): React.JSX.Element {
  const [voices, setVoices] = useState<RuntimeSpeechVoice[]>([])
  const voice = speechProjection.snapshot.models.voice ?? ''
  const language = selectedLanguage(voice)
  const [assetsState, setAssetsState] = useState<AssetsState>('loading')
  const [progress, setProgress] = useState<VoiceAssetProgress>({ percentage: 0 })
  const [testOperationId, setTestOperationId] = useState<string | null>(null)
  const [testCommandFailed, setTestCommandFailed] = useState(false)
  const testState = previewState(speechProjection, testOperationId, testCommandFailed)
  const preferences = speechProjection.snapshot.preferences
  const testOperationRef = useRef(testOperationId)
  const testActiveRef = useRef(false)
  const requestedVoiceRef = useRef('')
  const transferRate = useTransferRate()

  useEffect(() => {
    testOperationRef.current = testOperationId
    testActiveRef.current = testState === 'generating' || testState === 'playing'
  }, [testOperationId, testState])

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
    requestVoices()
    return () => {
      stopProgress()
      if (testOperationRef.current && testActiveRef.current) {
        testOperationRef.current = null
        void window.api.speechCommands.interrupt().catch((error) => {
          console.error('Could not stop the voice sample.', error)
        })
      }
    }
  }, [requestVoices])

  useEffect(() => {
    if (!voice || !voices.some(({ id }) => id === voice)) return
    requestedVoiceRef.current = voice
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
  }, [voice, voices])

  useEffect(() => {
    if (!voices.length || (voice && voices.some(({ id }) => id === voice))) return
    const fallback = firstRuntimeVoiceForLanguage(voices, language) ?? voices[0]
    if (!fallback) return
    void Promise.resolve().then(() => {
      void window.api.speechCommands.selectVoice(fallback.id).then(
        (outcome) => {
          if (!outcome.ok) setAssetsState('error')
        },
        (error: unknown) => {
          console.error(`Could not save fallback text-to-speech voice ${fallback.id}.`, error)
          setAssetsState('error')
        }
      )
    })
  }, [language, voice, voices])

  const commitPreference = useCallback(
    async <K extends keyof VoicePreferences>(
      key: K,
      value: VoicePreferences[K]
    ): Promise<SettingsWriteOutcome> => {
      try {
        const outcome = await window.api.speechCommands.savePreferences({ [key]: value })
        if (!outcome.ok) return failed({ message: speechFailureMessage(outcome.failure) })
        return ok(undefined)
      } catch (error) {
        console.error(`Could not save voice preference ${key}.`, error)
        return failed({ message: 'This preference could not be saved.' })
      }
    },
    []
  )

  const commitSpeed = useCallback(
    (speed: number) => commitPreference('speed', speed),
    [commitPreference]
  )

  const filteredVoices = useMemo(
    () => runtimeVoicesForLanguage(voices, language),
    [language, voices]
  )

  const pickVoice = (nextVoice: string): void => {
    void window.api.speechCommands.selectVoice(nextVoice).then(
      () => undefined,
      (error: unknown) => {
        console.error(`Could not save text-to-speech voice ${nextVoice}.`, error)
      }
    )
  }

  const pickLanguage = (nextLanguage: string): void => {
    const matching = firstRuntimeVoiceForLanguage(voices, nextLanguage)?.id
    if (!matching) return
    pickVoice(matching)
  }

  const testVoice = async (): Promise<void> => {
    const operationId = crypto.randomUUID()
    testOperationRef.current = operationId
    testActiveRef.current = true
    setTestOperationId(operationId)
    setTestCommandFailed(false)
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
        testActiveRef.current = false
        setTestCommandFailed(true)
        return
      }
    } catch (error: unknown) {
      console.error('Could not play the text-to-speech voice sample.', error)
      if (testOperationRef.current === operationId) testOperationRef.current = null
      testActiveRef.current = false
      setTestCommandFailed(true)
    }
  }

  const turnDescription = VOICE_TURN_LABELS[preferences.turnMode].description
  const assetProgress = projectProgress(progress)
  const projectionError = speechStateError(speechProjection)
  return (
    <>
      {projectionError ? (
        <p role="alert" className="mb-4 text-xs text-red-400">
          {projectionError}
        </p>
      ) : null}
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
          onSelect={(value) => void commitPreference('voiceMode', value === 'voice')}
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
            onSelect={(value) => void commitPreference('ttsEnabled', value === 'on')}
          />
        </SettingsRow>
      ) : null}

      <SettingsRow label="Voice turns" hint={turnDescription}>
        <PreferenceButtons
          label="Voice turns"
          options={VOICE_TURN_MODES.map((id) => ({ id, label: VOICE_TURN_LABELS[id].label }))}
          selected={preferences.turnMode}
          onSelect={(value) => void commitPreference('turnMode', value)}
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
            onSelect={(value) => void commitPreference('silenceAfterSpeechMs', value)}
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
            onSelect={(value) => void commitPreference('speakerDrainMs', value)}
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
        disabled={testState === 'generating' || testState === 'playing' || !voice}
        className="rounded-md bg-green-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-green-500 disabled:opacity-40"
      >
        {previewLabel(testState)}
      </button>
      {testState === 'error' ? (
        <span className="ml-2 text-[11px] text-red-400">
          Could not play this voice. Check your audio output and retry.
        </span>
      ) : null}
    </>
  )
}

export function VoiceSettingsTab(): React.JSX.Element {
  const projection = useSpeechProjection()
  if (projection.status === 'loading') {
    return <LoadingDots />
  }
  if (projection.status === 'failed') {
    return (
      <p role="alert" className="text-xs text-red-400">
        {projection.failure.message}
      </p>
    )
  }
  return <VoiceSettingsContent speechProjection={projection} />
}
