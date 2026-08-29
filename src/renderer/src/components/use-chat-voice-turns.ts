import { useCallback, useEffect, useRef, useState } from 'react'
import { transcriptionRecoveryMessage } from '../../../shared/transcription-recovery'
import {
  SpeechEndpointTimer,
  audioFilename,
  chooseRecorderMime,
  type VoiceTurnMode
} from '@offgrid/speech'

/*
 * These effects are transition inputs to one voice state machine: mode, generation, playback, and
 * unmount must synchronously stop native microphone resources and move the visible phase. The
 * generic rule treats that intentional reducer-style transition as an effect cascade.
 */
/* eslint-disable react-hooks/set-state-in-effect */

export type ChatVoicePhase = 'idle' | 'starting' | 'listening' | 'recording' | 'transcribing'

export interface ChatVoiceClip {
  url: string
  duration: number
}

interface ChatVoiceTurnOptions {
  voiceMode: boolean
  mode: VoiceTurnMode
  silenceAfterSpeechMs: number
  speakerDrainMs: number
  isGenerating: boolean
  isPlaybackActive: boolean
  transcribeAudio: (audio: Uint8Array, extension: string, requestId: string) => Promise<string>
  cancelTranscription?: (requestId: string) => Promise<boolean>
  getTranscriptionLabel?: () => Promise<{ label: string }>
  onTranscript: (text: string, clip: ChatVoiceClip | null) => void
}

interface CaptureResources {
  stream: MediaStream
  recorder: MediaRecorder
  context: AudioContext | null
  meter: ReturnType<typeof setInterval> | null
  endpoint: SpeechEndpointTimer | null
}

interface CompletedCapture {
  sequence: number
  chunks: Blob[]
  mime: string
  duration: number
}

interface ChatVoiceTurns {
  phase: ChatVoicePhase
  suspended: boolean
  microphoneDenied: boolean
  error: string | null
  transcriptionLabel: string
  toggle: () => void
  cancel: () => void
}

const LEVEL_SAMPLE_MS = 50

function recorderMime(): string {
  const supports =
    typeof MediaRecorder.isTypeSupported === 'function'
      ? (mime: string) => MediaRecorder.isTypeSupported(mime)
      : () => false
  return chooseRecorderMime(supports)
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}

function captureIsBlocked(
  phase: ChatVoicePhase,
  current: ChatVoiceTurnOptions,
  userInitiated: boolean
): boolean {
  if (phase !== 'idle') return true
  if (current.isGenerating || current.isPlaybackActive) return true
  return !current.voiceMode && !userInitiated
}

function effectiveCaptureMode(current: ChatVoiceTurnOptions): VoiceTurnMode {
  if (!current.voiceMode) return 'tap'
  return current.mode
}

function initialCapturePhase(mode: VoiceTurnMode): ChatVoicePhase {
  if (mode === 'handsfree') return 'listening'
  return 'recording'
}

function microphoneFailure(cause: unknown): { denied: boolean; message: string } {
  const name =
    typeof cause === 'object' && cause !== null && 'name' in cause ? String(cause.name) : ''
  const denied = name === 'NotAllowedError' || name === 'SecurityError'
  if (denied) {
    return {
      denied,
      message:
        'Microphone access is off. Allow Off Grid AI Desktop in System Settings, then try again.'
    }
  }
  return {
    denied,
    message: 'The microphone could not start. Try again, or switch this voice turn to Manual.'
  }
}

/**
 * One owner for a chat voice turn.
 *
 * The hook owns the browser microphone, recorder, loudness meter, silence endpoint,
 * transcription request, and every teardown path. MemoryChat only sends user intent and receives a
 * completed transcript. Manual, Auto, and Hands-free therefore cannot drift into separate recorder
 * implementations.
 */
export function useChatVoiceTurns(options: ChatVoiceTurnOptions): ChatVoiceTurns {
  const optionsRef = useRef(options)
  useEffect(() => {
    optionsRef.current = options
  }, [options])

  const [phase, setPhase] = useState<ChatVoicePhase>('idle')
  const phaseRef = useRef<ChatVoicePhase>('idle')
  const [suspended, setSuspended] = useState(false)
  const suspendedRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [microphoneDenied, setMicrophoneDenied] = useState(false)
  const [transcriptionLabel, setTranscriptionLabel] = useState('Speech-to-text')
  const [awaitingReply, setAwaitingReply] = useState(false)
  const [rearmReady, setRearmReady] = useState(true)

  const mountedRef = useRef(true)
  const sequenceRef = useRef(0)
  const resourcesRef = useRef<CaptureResources | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef('audio/webm')
  const startedAtRef = useRef(0)
  const discardRef = useRef(false)
  const sawGenerationRef = useRef(false)
  const sawPlaybackRef = useRef(false)
  const previousPlaybackRef = useRef(false)
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptionRequestRef = useRef<string | null>(null)

  const updatePhase = useCallback((next: ChatVoicePhase): void => {
    phaseRef.current = next
    setPhase(next)
  }, [])

  const updateSuspended = useCallback((next: boolean): void => {
    suspendedRef.current = next
    setSuspended(next)
  }, [])

  const clearRearmTimer = useCallback((): void => {
    if (rearmTimerRef.current) clearTimeout(rearmTimerRef.current)
    rearmTimerRef.current = null
  }, [])

  const stopAnalysis = useCallback((resources: CaptureResources): void => {
    resources.endpoint?.cancel()
    if (resources.meter) clearInterval(resources.meter)
    if (resources.context) void resources.context.close().catch(() => {})
    resources.endpoint = null
    resources.meter = null
    resources.context = null
  }, [])

  const stopTracks = useCallback((resources: CaptureResources): void => {
    resources.stream.getTracks().forEach((track) => track.stop())
  }, [])

  const discardCapture = useCallback(
    (notify = true): void => {
      sequenceRef.current += 1
      const transcriptionRequest = transcriptionRequestRef.current
      transcriptionRequestRef.current = null
      if (transcriptionRequest) {
        void optionsRef.current.cancelTranscription?.(transcriptionRequest).catch(() => {})
      }
      const resources = resourcesRef.current
      resourcesRef.current = null
      chunksRef.current = []
      discardRef.current = true
      if (resources) {
        stopAnalysis(resources)
        resources.recorder.onstop = null
        try {
          if (resources.recorder.state !== 'inactive') resources.recorder.stop()
        } catch {
          /* The recorder already stopped. */
        }
        stopTracks(resources)
      }
      phaseRef.current = 'idle'
      if (notify && mountedRef.current) setPhase('idle')
    },
    [stopAnalysis, stopTracks]
  )

  const transcribeRecording = useCallback(
    async ({ sequence, chunks, mime, duration }: CompletedCapture): Promise<void> => {
      const blob = new Blob(chunks, { type: mime })
      if (blob.size === 0) {
        if (sequence === sequenceRef.current) {
          setError("Didn't record any audio. Try again.")
          updateSuspended(optionsRef.current.mode === 'handsfree')
          updatePhase('idle')
        }
        return
      }

      try {
        const extension = audioFilename(mime).split('.').pop() ?? 'webm'
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const requestId = crypto.randomUUID()
        transcriptionRequestRef.current = requestId
        const text = (await optionsRef.current.transcribeAudio(bytes, extension, requestId)).trim()
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        if (!text) {
          setError("Didn't catch that. Tap the microphone and try again.")
          updateSuspended(optionsRef.current.mode === 'handsfree')
          updatePhase('idle')
          return
        }

        setError(null)
        updatePhase('idle')
        if (optionsRef.current.voiceMode) {
          sawGenerationRef.current = false
          sawPlaybackRef.current = false
          setAwaitingReply(true)
        }
        optionsRef.current.onTranscript(
          text,
          optionsRef.current.voiceMode ? { url: URL.createObjectURL(blob), duration } : null
        )
      } catch (cause) {
        console.error('Transcription failed', cause)
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        setError(
          transcriptionRecoveryMessage(cause) ??
            'Transcription failed. Check the speech-to-text model in Settings > Setup & health.'
        )
        updateSuspended(optionsRef.current.mode === 'handsfree')
        updatePhase('idle')
      } finally {
        if (sequence === sequenceRef.current) transcriptionRequestRef.current = null
      }
    },
    [updatePhase, updateSuspended]
  )

  const finishCaptureRef = useRef<(suspendAfter: boolean) => void>(() => {})

  const refreshTranscriptionLabel = useCallback(async (sequence: number): Promise<void> => {
    try {
      const info = await optionsRef.current.getTranscriptionLabel?.()
      if (mountedRef.current && sequence === sequenceRef.current && info?.label) {
        setTranscriptionLabel(info.label)
      }
    } catch {
      // The label is supplementary. Recording can continue with the generic label.
    }
  }, [])

  const startCapture = useCallback(
    async (userInitiated: boolean): Promise<void> => {
      const current = optionsRef.current
      if (captureIsBlocked(phaseRef.current, current, userInitiated)) return

      if (userInitiated) updateSuspended(false)
      setError(null)
      setMicrophoneDenied(false)
      const sequence = ++sequenceRef.current
      updatePhase('starting')
      void refreshTranscriptionLabel(sequence)

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        })
        if (!mountedRef.current || sequence !== sequenceRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        const selectedMime = recorderMime()
        const recorder = selectedMime
          ? new MediaRecorder(stream, { mimeType: selectedMime })
          : new MediaRecorder(stream)
        const actualMime = recorder.mimeType || selectedMime || 'audio/webm'
        const resources: CaptureResources = {
          stream,
          recorder,
          context: null,
          meter: null,
          endpoint: null
        }
        resourcesRef.current = resources
        chunksRef.current = []
        mimeRef.current = actualMime
        startedAtRef.current = Date.now()
        discardRef.current = false

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data)
        }
        recorder.onstop = () => {
          stopAnalysis(resources)
          stopTracks(resources)
          if (resourcesRef.current === resources) resourcesRef.current = null
          if (discardRef.current || sequence !== sequenceRef.current) return
          const chunks = chunksRef.current
          chunksRef.current = []
          void transcribeRecording({
            sequence,
            chunks,
            mime: mimeRef.current,
            duration: Math.max(0, (Date.now() - startedAtRef.current) / 1000)
          })
        }

        const mode = effectiveCaptureMode(current)
        if (mode !== 'tap') {
          const context = new window.AudioContext()
          const source = context.createMediaStreamSource(stream)
          const analyser = context.createAnalyser()
          analyser.fftSize = 2048
          source.connect(analyser)
          const samples = new Float32Array(analyser.fftSize)
          const endpoint = new SpeechEndpointTimer(() => finishCaptureRef.current(false))
          endpoint.begin(Date.now(), {
            handsFree: mode === 'handsfree',
            silenceAfterSpeechMs: current.silenceAfterSpeechMs
          })
          resources.context = context
          resources.endpoint = endpoint
          resources.meter = setInterval(() => {
            analyser.getFloatTimeDomainData(samples)
            const reading = endpoint.observeLevel(rms(samples))
            if (mode === 'handsfree' && reading.speech && phaseRef.current === 'listening')
              updatePhase('recording')
          }, LEVEL_SAMPLE_MS)
        }

        recorder.start(250)
        updatePhase(initialCapturePhase(mode))
      } catch (cause) {
        const resources = resourcesRef.current
        resourcesRef.current = null
        if (resources) {
          stopAnalysis(resources)
          stopTracks(resources)
        }
        if (!mountedRef.current || sequence !== sequenceRef.current) return
        const failure = microphoneFailure(cause)
        setError(failure.message)
        setMicrophoneDenied(failure.denied)
        updateSuspended(current.mode === 'handsfree')
        updatePhase('idle')
      }
    },
    [
      refreshTranscriptionLabel,
      stopAnalysis,
      stopTracks,
      transcribeRecording,
      updatePhase,
      updateSuspended
    ]
  )

  const finishCapture = useCallback(
    (suspendAfter: boolean): void => {
      if (phaseRef.current === 'starting') {
        discardCapture()
        if (suspendAfter) updateSuspended(true)
        return
      }
      if (phaseRef.current === 'transcribing') {
        discardCapture()
        if (suspendAfter) updateSuspended(true)
        return
      }
      const resources = resourcesRef.current
      if (!resources) {
        updatePhase('idle')
        if (suspendAfter) updateSuspended(true)
        return
      }

      const heardSpeech = resources.endpoint?.hasHeardSpeech() ?? phaseRef.current === 'recording'
      if (suspendAfter) updateSuspended(true)
      if (!heardSpeech && optionsRef.current.mode === 'handsfree') {
        discardCapture()
        return
      }

      stopAnalysis(resources)
      discardRef.current = false
      updatePhase('transcribing')
      try {
        if (resources.recorder.state !== 'inactive') resources.recorder.stop()
      } catch {
        setError('The recording could not be finalized. Tap the microphone and try again.')
        discardCapture()
      }
    },
    [discardCapture, stopAnalysis, updatePhase, updateSuspended]
  )

  useEffect(() => {
    finishCaptureRef.current = finishCapture
  }, [finishCapture])

  const toggle = useCallback((): void => {
    if (phaseRef.current === 'idle') {
      void startCapture(true)
      return
    }
    finishCapture(optionsRef.current.mode === 'handsfree')
  }, [finishCapture, startCapture])

  const cancel = useCallback((): void => {
    discardCapture()
    setAwaitingReply(false)
    sawGenerationRef.current = false
    sawPlaybackRef.current = false
    if (optionsRef.current.mode === 'handsfree') updateSuspended(true)
  }, [discardCapture, updateSuspended])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearRearmTimer()
      discardCapture(false)
    }
  }, [clearRearmTimer, discardCapture])

  const modeRef = useRef(options.mode)
  useEffect(() => {
    if (modeRef.current === options.mode) return
    modeRef.current = options.mode
    discardCapture()
    setAwaitingReply(false)
    updateSuspended(false)
    setRearmReady(true)
  }, [discardCapture, options.mode, updateSuspended])

  useEffect(() => {
    if (options.voiceMode) return
    discardCapture()
    setAwaitingReply(false)
    updateSuspended(false)
    setRearmReady(true)
  }, [discardCapture, options.voiceMode, updateSuspended])

  useEffect(() => {
    if (!options.isGenerating && !options.isPlaybackActive) return
    if (
      phaseRef.current === 'starting' ||
      phaseRef.current === 'listening' ||
      phaseRef.current === 'recording'
    )
      discardCapture()
  }, [discardCapture, options.isGenerating, options.isPlaybackActive])

  useEffect(() => {
    if (options.isGenerating) sawGenerationRef.current = true
    if (options.isPlaybackActive) sawPlaybackRef.current = true
    if (
      awaitingReply &&
      !options.isGenerating &&
      !options.isPlaybackActive &&
      sawPlaybackRef.current
    ) {
      setAwaitingReply(false)
      sawGenerationRef.current = false
      sawPlaybackRef.current = false
      setRearmReady(false)
      clearRearmTimer()
      rearmTimerRef.current = setTimeout(() => setRearmReady(true), options.speakerDrainMs)
    }
  }, [
    awaitingReply,
    clearRearmTimer,
    options.isGenerating,
    options.isPlaybackActive,
    options.speakerDrainMs
  ])

  useEffect(() => {
    const wasActive = previousPlaybackRef.current
    previousPlaybackRef.current = options.isPlaybackActive
    if (options.isPlaybackActive) {
      clearRearmTimer()
      setRearmReady(false)
    } else if (wasActive && !awaitingReply) {
      clearRearmTimer()
      rearmTimerRef.current = setTimeout(() => setRearmReady(true), options.speakerDrainMs)
    }
  }, [awaitingReply, clearRearmTimer, options.isPlaybackActive, options.speakerDrainMs])

  useEffect(() => {
    if (
      !options.voiceMode ||
      options.mode !== 'handsfree' ||
      options.isGenerating ||
      options.isPlaybackActive ||
      awaitingReply ||
      suspended ||
      !rearmReady ||
      phase !== 'idle'
    )
      return
    void startCapture(false)
  }, [
    awaitingReply,
    options.isGenerating,
    options.isPlaybackActive,
    options.mode,
    options.voiceMode,
    phase,
    rearmReady,
    startCapture,
    suspended
  ])

  return {
    phase,
    suspended,
    microphoneDenied,
    error,
    transcriptionLabel,
    toggle,
    cancel
  }
}
