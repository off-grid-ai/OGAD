/**
 * VoiceBubble — desktop voice-note bubble for the chat's voice mode.
 *
 * A WhatsApp-style audio message: play/pause, a 48-bar waveform that tints as
 * the playhead passes, click-to-seek, a duration readout, a speed chip, and a
 * "Show transcript" toggle. Ported from the mobile app's AudioMessageBubble so
 * both products behave identically.
 *
 *  - User voice notes carry a recorded clip (`audioUrl`) → we decode its REAL
 *    envelope and play the file directly.
 *  - Assistant replies have no file → Shared Speech owns synthesis and playback;
 *    this component projects its correlated lifecycle events.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, CaretDown, Copy, ArrowsClockwise, Check } from '@phosphor-icons/react'
import { claimVoicePlayback, onVoicePlaybackClaim } from '@renderer/lib/voice-playback-bus'
import { LoadingDots } from './ui/loading-dots'

const WAVEFORM_BARS = 48
const SPEED_STEPS = [0.5, 0.8, 1.0, 1.25, 1.5, 2.0]
type VoiceStatus = 'idle' | 'loading' | 'playing' | 'paused'

function useSpeechEvents({
  operationRef,
  setStatus,
  setCurrentTime,
  setPlaybackError
}: {
  operationRef: React.MutableRefObject<string | null>
  setStatus: React.Dispatch<React.SetStateAction<VoiceStatus>>
  setCurrentTime: React.Dispatch<React.SetStateAction<number>>
  setPlaybackError: React.Dispatch<React.SetStateAction<string | null>>
}): void {
  useEffect(() => {
    return window.api.speechCommands.onEvent((event) => {
      if (
        event.type !== 'speech_started' &&
        event.type !== 'speech_finished' &&
        event.type !== 'interrupted'
      )
        return
      const operationId = operationRef.current
      if (!operationId || event.operationId !== operationId) return
      if (event.type === 'speech_started') {
        setStatus('playing')
        return
      }
      operationRef.current = null
      setStatus('idle')
      setCurrentTime(0)
      if (
        event.type === 'speech_finished' &&
        event.outcome.kind !== 'spoken' &&
        event.outcome.kind !== 'interrupted' &&
        event.outcome.kind !== 'nothing-to-speak'
      ) {
        setPlaybackError(
          'Speech could not be generated. Check that Text-to-speech is installed in Settings, then try again.'
        )
      }
    })
  }, [operationRef, setCurrentTime, setPlaybackError, setStatus])
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Deterministic, speech-like envelope derived from the transcript (port of the
 *  mobile waveformFromText). Same text → same bars, so it's stable mid-playback. */
function waveformFromText(text: string, points: number): number[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length === 0 || points <= 0) return Array.from({ length: points }, () => 0)
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const idx = Math.min(clean.length - 1, Math.floor((i / points) * clean.length))
    const ch = clean[idx]!
    const code = clean.charCodeAt(idx)
    let base: number
    if (ch === ' ') base = 0.12
    else if (/[.,!?;:]/.test(ch)) base = 0.1
    else if (/[aeiouAEIOU]/.test(ch)) base = 0.85
    else base = 0.45
    const ripple = 0.18 * (1 + Math.sin(idx * 1.7 + (code % 7))) * 0.5
    out.push(Math.min(1, base + ripple))
  }
  return out
}

function subsample(data: number[], count: number): number[] {
  if (data.length === 0) return Array.from({ length: count }, () => 0)
  const step = data.length / count
  const result: number[] = []
  for (let i = 0; i < count; i++) result.push(data[Math.floor(i * step)] ?? 0)
  return result
}

function normalize(data: number[]): number[] {
  const max = Math.max(...data, 0.001)
  return data.map((v) => v / max)
}

/** One empty envelope, so the derived value keeps its identity between renders. */
const NO_DECODED_WAVE: number[] = []

/**
 * How long the clip is and how far through it we are.
 *
 * The real duration once the audio element reports one, the estimate until then, and a fraction
 * that cannot exceed 1 - clamped because `currentTime` can pass an ESTIMATED duration, and a
 * progress bar past its own end is a visible glitch. Pure, and out here so the component does not
 * carry the branches.
 */
function playbackProgress(input: {
  readonly loadedDuration: number
  readonly estDuration: number
  readonly currentTime: number
}): { totalDuration: number; progress: number } {
  const totalDuration = input.loadedDuration || input.estDuration
  const progress = totalDuration ? Math.min(1, input.currentTime / totalDuration) : 0
  return { totalDuration, progress }
}

/** A decoded envelope, and the clip it was decoded from. */
interface DecodedWave {
  readonly url: string
  readonly wave: number[]
}

/**
 * The envelope that belongs to THIS clip, or none.
 *
 * Derived rather than kept in sync, and derived out here so the component's own complexity does not
 * pay for it: a decoded wave is only this clip's wave if it was decoded from this clip's url.
 */
function waveForClip(audioUrl: string | undefined, decoded: DecodedWave | null): number[] {
  if (!audioUrl || decoded?.url !== audioUrl) return NO_DECODED_WAVE
  return decoded.wave
}

/** Decode a real audio file's envelope once (recordings). */
async function decodeFileWaveform(url: string, points: number): Promise<number[]> {
  try {
    const res = await fetch(url)
    const buf = await res.arrayBuffer()
    const Ctx = window.AudioContext
    const ctx = new Ctx()
    const audio = await ctx.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const block = Math.floor(ch.length / points) || 1
    const out: number[] = []
    for (let i = 0; i < points; i++) {
      let sum = 0
      for (let j = 0; j < block; j++) sum += Math.abs(ch[i * block + j] ?? 0)
      out.push(sum / block)
    }
    void ctx.close()
    return out
  } catch {
    return []
  }
}

interface VoiceBubbleProps {
  messageId: string
  /** Recorded clip URL for user voice notes; absent for assistant replies. */
  audioUrl?: string
  durationSeconds?: number
  transcript: string
  isUser?: boolean
  /** Assistant reply still generating — a quiet waveform placeholder, no playback. */
  isLoading?: boolean
  /** @deprecated Generated playback is owned by the Shared Speech facade. */
  synthesize?: (text: string) => Promise<{ dataUrl: string }>
  /** Play once automatically when ready (a just-finished assistant reply). */
  autoPlay?: boolean
  /** The latest assistant voice reply opens its transcript without another click. */
  showTranscriptInitially?: boolean
  /** Persisted playback speed from Voice settings. */
  defaultSpeed?: number
  /** Reports audio preparation and playback so hands-free input cannot record the reply. */
  onPlaybackStateChange?: (active: boolean) => void
  /** The chat's existing copy-feedback state for this message. */
  copied?: boolean
  onCopy?: (text: string) => void
  onRetry?: () => void
}

export const VoiceBubble: React.FC<VoiceBubbleProps> = ({
  messageId,
  audioUrl,
  durationSeconds,
  transcript,
  isUser = false,
  isLoading = false,
  autoPlay = false,
  showTranscriptInitially = false,
  defaultSpeed = 1,
  onPlaybackStateChange,
  copied = false,
  onCopy,
  onRetry
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechOperationRef = useRef<string | null>(null)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [currentTime, setCurrentTime] = useState(0)
  const [loadedDuration, setLoadedDuration] = useState(0)
  const [speed, setSpeed] = useState(defaultSpeed)
  /**
   * The persisted speed preference changed, so the chip goes back to it.
   *
   * React's "adjusting state when a prop changes": compare against the PREVIOUS prop value during
   * render, rather than copying the prop into state from an effect. It fires on exactly the
   * transitions the effect did - once per change of `defaultSpeed`, including a change back to a
   * value the user had once overridden - and it does it before anything renders with the stale
   * value instead of after a second pass.
   */
  const [appliedDefaultSpeed, setAppliedDefaultSpeed] = useState(defaultSpeed)
  if (appliedDefaultSpeed !== defaultSpeed) {
    setAppliedDefaultSpeed(defaultSpeed)
    setSpeed(defaultSpeed)
  }
  const [showTranscript, setShowTranscript] = useState(showTranscriptInitially)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const playbackActive = status === 'loading' || status === 'playing'
  useSpeechEvents({
    operationRef: speechOperationRef,
    setStatus,
    setCurrentTime,
    setPlaybackError
  })

  useEffect(() => {
    if (showTranscriptInitially && transcript && !isLoading) setShowTranscript(true)
  }, [isLoading, showTranscriptInitially, transcript])

  // Telling the audio element about a new preference IS updating an external system, which is what
  // an effect is for. Resetting the chip is not - see `chosenSpeed`.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = defaultSpeed
  }, [defaultSpeed])

  useEffect(() => {
    onPlaybackStateChange?.(playbackActive)
    return () => {
      if (playbackActive) onPlaybackStateChange?.(false)
    }
  }, [onPlaybackStateChange, playbackActive])

  /**
   * Stable waveform: the real decoded envelope for a recording, else transcript-derived.
   *
   * The decoded envelope is stored WITH the clip it came from, so "which wave belongs to this
   * clip" is derived rather than kept in sync by clearing state in an effect. That also closes a
   * real gap: the old effect only cleared on no clip at all, so between one clip's url changing
   * and the new one finishing decoding, the bubble drew the PREVIOUS recording's envelope. It now
   * falls back to the transcript-derived shape for that window, which is what it already does
   * before any clip has decoded.
   */
  const [decodedWave, setDecodedWave] = useState<DecodedWave | null>(null)
  useEffect(() => {
    if (!audioUrl) return
    let cancelled = false
    void decodeFileWaveform(audioUrl, WAVEFORM_BARS).then((wave) => {
      if (!cancelled) setDecodedWave({ url: audioUrl, wave })
    })
    return () => {
      cancelled = true
    }
  }, [audioUrl])
  const fileWave = waveForClip(audioUrl, decodedWave)

  const bars = useMemo(() => {
    const raw = fileWave.length ? fileWave : waveformFromText(transcript, WAVEFORM_BARS)
    return normalize(subsample(raw, WAVEFORM_BARS))
  }, [fileWave, transcript])

  // Estimate duration before the audio element reports a real value.
  const estDuration = useMemo(() => {
    if (durationSeconds) return durationSeconds
    const words = transcript.trim().split(/\s+/).filter(Boolean).length
    return Math.max(1, words / (2.5 * speed))
  }, [durationSeconds, transcript, speed])
  const { totalDuration, progress } = playbackProgress({ loadedDuration, estDuration, currentTime })

  // Pause when another bubble takes over playback.
  useEffect(() => {
    return onVoicePlaybackClaim((id) => {
      if (id !== messageId && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause()
        setStatus('paused')
      }
      if (id !== messageId && speechOperationRef.current) {
        void window.api.speechCommands.interrupt().catch((error) => {
          console.error('[voice] interrupt failed', error)
          setPlaybackError('Speech could not be stopped. Check your audio output, then try again.')
        })
      }
    })
  }, [messageId])

  useEffect(
    () => () => {
      const activeSpeechOperation = speechOperationRef.current
      audioRef.current?.pause()
      audioRef.current = null
      speechOperationRef.current = null
      if (activeSpeechOperation) {
        void window.api.speechCommands.interrupt().catch((error) => {
          console.error('[voice] interrupt failed', error)
        })
      }
    },
    []
  )

  const wire = useCallback(
    (audio: HTMLAudioElement) => {
      audio.playbackRate = speed
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setLoadedDuration(audio.duration)
      }
      audio.onended = () => {
        setStatus('idle')
        setCurrentTime(0)
      }
      audio.onerror = () => setStatus('idle')
    },
    [speed]
  )

  const handlePlayPause = useCallback(async () => {
    const audio = audioRef.current
    if (!audioUrl && speechOperationRef.current) {
      const operationId = speechOperationRef.current
      try {
        await window.api.speechCommands.interrupt()
        if (speechOperationRef.current === operationId) speechOperationRef.current = null
        setStatus('idle')
        setCurrentTime(0)
      } catch (error) {
        console.error('[voice] interrupt failed', error)
        setPlaybackError('Speech could not be stopped. Check your audio output, then try again.')
      }
      return
    }
    if (status === 'playing' && audio) {
      audio.pause()
      setStatus('paused')
      return
    }
    if (status === 'paused' && audio) {
      claimVoicePlayback(messageId)
      await audio.play()
      setStatus('playing')
      return
    }
    // Shared owns generated speech. Record the ID before the command so a fast
    // terminal event cannot arrive before this component can correlate it.
    setPlaybackError(null)
    setStatus('loading')
    if (!audioUrl) {
      const operationId = crypto.randomUUID()
      speechOperationRef.current = operationId
      claimVoicePlayback(messageId)
      try {
        await window.api.speechCommands.feedStream({
          operationId,
          delta: transcript,
          speed
        })
        await window.api.speechCommands.finishStream(operationId)
      } catch (error) {
        console.error('[voice] speech stream failed', error)
        if (speechOperationRef.current !== operationId) return
        speechOperationRef.current = null
        setStatus('idle')
        setPlaybackError(
          'Speech could not be generated. Check that Text-to-speech is installed in Settings, then try again.'
        )
      }
      return
    }
    try {
      const audioEl = new Audio(audioUrl)
      audioRef.current = audioEl
      wire(audioEl)
      claimVoicePlayback(messageId)
      await audioEl.play()
      setStatus('playing')
    } catch (e) {
      console.error('[voice] playback failed', e)
      setStatus('idle')
      setPlaybackError(
        audioUrl
          ? 'Voice note could not be played. Check your audio output, then try again.'
          : 'Speech could not be generated. Check that Text-to-speech is installed in Settings, then try again.'
      )
    }
  }, [status, audioUrl, transcript, speed, wire, messageId])

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => {
      const next = SPEED_STEPS[(SPEED_STEPS.indexOf(prev) + 1) % SPEED_STEPS.length] ?? 1.0
      if (audioRef.current) audioRef.current.playbackRate = next
      return next
    })
  }, [])

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = Math.max(0, Math.min(1, fraction)) * audio.duration
    setCurrentTime(audio.currentTime)
  }, [])

  // Auto-play once a freshly-finished assistant reply is ready.
  const autoPlayedRef = useRef(false)
  useEffect(() => {
    if (autoPlay && !autoPlayedRef.current && !isLoading && status === 'idle') {
      autoPlayedRef.current = true
      void handlePlayPause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, isLoading])

  return (
    <div
      className={`flex w-[88%] max-w-[34rem] flex-col gap-2 rounded-xl border p-3 ${isUser ? 'self-end border-green-500/40 bg-green-500/10' : 'self-start border-neutral-800 bg-neutral-900/50'}`}
    >
      <div className="flex items-center gap-2.5">
        {/* Play / pause / loading */}
        <button
          type="button"
          onClick={handlePlayPause}
          disabled={isLoading}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/20 text-green-500 transition-colors hover:bg-green-500/30 ${isLoading ? 'cursor-default opacity-40' : 'cursor-pointer'}`}
          title={status === 'playing' ? 'Pause' : 'Play'}
        >
          {status === 'loading' ? (
            <LoadingDots size="small" />
          ) : status === 'playing' ? (
            <Pause size={16} weight="fill" />
          ) : (
            <Play size={16} weight="fill" />
          )}
        </button>

        {/* Waveform (click to seek) */}
        <div className="flex h-10 flex-1 items-center gap-[1.5px] overflow-hidden">
          {isLoading && !isUser ? (
            // The turn's thinking header already animates while the reply streams; a
            // second animation here read as two loaders. Hold a quiet waveform placeholder.
            <span
              aria-hidden
              data-testid="voice-waveform-pending"
              className="block h-[6px] w-full rounded-sm bg-green-500/20"
            />
          ) : (
            bars.map((shape, i) => {
              const played = progress > 0 && i / bars.length < progress
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => seekTo(i / bars.length)}
                  className="h-full flex-1 cursor-pointer"
                  style={{ minWidth: 2 }}
                  tabIndex={-1}
                >
                  <span
                    className="block w-full rounded-sm bg-green-500"
                    style={{
                      height: Math.max(6, Math.round(shape * 32)),
                      opacity: played ? 0.7 + shape * 0.3 : 0.2 + shape * 0.25
                    }}
                  />
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        {transcript ? (
          <button
            type="button"
            onClick={() => setShowTranscript((v) => !v)}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-300"
          >
            {showTranscript ? 'Hide transcript' : 'Show transcript'}
            <CaretDown
              size={11}
              weight="bold"
              className={`transition-transform ${showTranscript ? 'rotate-180' : ''}`}
            />
          </button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2.5">
          <span className="min-w-[2rem] text-right text-[11px] text-neutral-500 tabular-nums">
            {isLoading
              ? '—'
              : formatDuration(status === 'idle' ? totalDuration : currentTime || totalDuration)}
          </span>
          <button
            type="button"
            onClick={cycleSpeed}
            className="cursor-pointer rounded-md border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500"
            title="Playback speed"
          >
            {speed}x
          </button>
          {!isLoading && onCopy ? (
            <button
              type="button"
              onClick={() => onCopy(transcript)}
              className={`flex cursor-pointer items-center gap-1 text-[11px] transition-colors ${copied ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'}`}
              title={copied ? 'Copied' : 'Copy transcript'}
              aria-label={copied ? 'Copied' : 'Copy transcript'}
            >
              {copied ? (
                <>
                  <Check size={13} weight="bold" />
                  <span role="status" aria-live="polite">
                    Copied
                  </span>
                </>
              ) : (
                <Copy size={13} />
              )}
            </button>
          ) : null}
          {!isLoading && onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="flex cursor-pointer items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
              title={isUser ? 'Resend' : 'Regenerate'}
              aria-label={isUser ? 'Resend' : 'Regenerate'}
            >
              <ArrowsClockwise size={13} />
              {isUser ? 'Resend' : null}
            </button>
          ) : null}
        </div>
      </div>

      {showTranscript && transcript ? (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-neutral-800 pt-2 text-xs leading-relaxed text-neutral-300">
          {transcript}
        </div>
      ) : null}
      {playbackError ? (
        <div
          role="alert"
          className="border-t border-red-500/30 pt-2 text-[11px] leading-relaxed text-red-300"
        >
          {playbackError}
        </div>
      ) : null}
    </div>
  )
}
