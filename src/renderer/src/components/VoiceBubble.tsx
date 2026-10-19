/**
 * VoiceBubble — desktop voice-note player for the chat's voice mode.
 *
 * Built to the approved chat-media reference (the TonePlayer in the component library's chat
 * media workshop): a large round play button with a spring glyph swap, a seek slider holding two
 * stacked waveforms (unplayed dimmed, played clipped to the playhead and glowing in the brand
 * green), a glowing playhead and a hover position line, a mono `current / total` readout, then
 * speed, captions, copy and regenerate - all on one row. Below it, a "Follow along" transcript
 * whose phrases light up with the playhead and seek when clicked.
 *
 *  - User voice notes carry a recorded clip (`audioUrl`) → we decode its REAL envelope and play
 *    the file directly.
 *  - Assistant replies have no file → we synthesize on-device the first time Play is pressed,
 *    cache the result, and draw a deterministic transcript-derived envelope (stable before and
 *    during playback).
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import {
  ArrowsClockwise,
  Check,
  CircleNotch,
  Copy,
  Pause,
  Play,
  Subtitles,
  SubtitlesSlash
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Waveform } from '@offgrid/operator-ui/operator/elevenlabs/waveform'
import { spokenText } from '@offgrid/speech'
import {
  Transcription,
  TranscriptionSegment
} from '@offgrid/operator-ui/operator/elements/transcription'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import { claimVoicePlayback, onVoicePlaybackClaim } from '@renderer/lib/voice-playback-bus'
import { PassPlayback, type PlayableClip } from '@renderer/lib/pass-playback'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

/** Envelope resolution: enough points that 2px bars across a chat column do not look blocky. */
const WAVEFORM_POINTS = 96
const WAVEFORM_HEIGHT = 64
const SPEED_STEPS = [0.5, 0.8, 1.0, 1.25, 1.5, 2.0]
/** Arrow keys move the playhead by this share of the clip. */
const SEEK_STEP = 0.05
const ease = [0.16, 1, 0.3, 1] as const
const glyphSpring = { type: 'spring', stiffness: 500, damping: 28 } as const
/** Long phrases are cut so the highlight keeps moving; this many words at most per phrase. */
const MAX_PHRASE_WORDS = 10
/** Lead-ins shorter than this many words join the phrase after them. */
const MIN_PHRASE_WORDS = 3

/** Every control: hover and focus come from Button; this adds the press. */
const pressable =
  'transition-[transform,background-color,color] active:scale-95 motion-reduce:active:scale-100'

/* ── Brand colours for the canvas ──────────────────────────────────────────────────────────────
 * The waveform paints on a <canvas>, which cannot resolve CSS variables: without an explicit
 * `barColor` it reads `--foreground` and falls back to black. So the bars get concrete colours
 * read from the Off Grid tokens on <html>, re-read whenever the theme flips `data-theme`.
 */
const tokenCache = new Map<string, string>()
const tokenListeners = new Set<() => void>()
let themeObserver: MutationObserver | null = null

function subscribeTheme(listener: () => void): () => void {
  tokenListeners.add(listener)
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      tokenCache.clear()
      tokenListeners.forEach((notify) => notify())
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class', 'style']
    })
  }
  return () => {
    tokenListeners.delete(listener)
    if (tokenListeners.size === 0) {
      themeObserver?.disconnect()
      themeObserver = null
    }
  }
}

function readToken(name: string, fallback: string): string {
  const cached = tokenCache.get(name)
  if (cached) return cached
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  tokenCache.set(name, value)
  return value
}

/** A brand token as a concrete colour string the canvas can paint. */
function useBrandColor(name: string, fallback: string): string {
  return useSyncExternalStore(
    subscribeTheme,
    () => readToken(name, fallback),
    () => fallback
  )
}

interface TimedSegment {
  text: string
  startSecond: number
  endSecond: number
}

/** A run of words longer than MAX_PHRASE_WORDS, cut into near-even pieces. */
function splitLongPhrase(phrase: string): string[] {
  const words = phrase.split(/\s+/)
  if (words.length <= MAX_PHRASE_WORDS) return [phrase]
  const pieces = Math.ceil(words.length / MAX_PHRASE_WORDS)
  const size = Math.ceil(words.length / pieces)
  const out: string[] = []
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '))
  return out
}

/** A lead-in shorter than MIN_PHRASE_WORDS ("Yes,", "Generated for:") stays with what follows. */
function joinShortLead(phrases: string[], phrase: string): string[] {
  const previous = phrases.at(-1)
  if (previous !== undefined && previous.split(/\s+/).length < MIN_PHRASE_WORDS) {
    phrases[phrases.length - 1] = `${previous} ${phrase}`
  } else phrases.push(phrase)
  return phrases
}

/**
 * The transcript as phrases laid along the clip, for the Follow-along view.
 *
 * ESTIMATED TIMINGS: neither the recorder nor the speech synthesizer gives us word timings, so
 * these are not aligned to the audio. The text is cut at punctuation and line breaks (short
 * lead-ins join the phrase after them, long runs are cut again), and each phrase takes the share
 * of the real duration that its SPOKEN character count takes of the whole text (emoji are not read
 * aloud, so they take no time). That is close enough for the highlight to follow the voice and
 * for a click on a phrase to land near it, and no closer.
 */
/** Cuts a line after a word ending in punctuation and before a word opening with a dash. */
function cutAtPunctuation(line: string): string[] {
  const out: string[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length > 0) out.push(current.join(' '))
    current = []
  }
  for (const word of line.split(' ')) {
    if (!word) continue
    if (/^[—–]/.test(word)) flush()
    current.push(word)
    if (/[.!?;:,—–]$/.test(word)) flush()
  }
  flush()
  return out
}

function phraseSegments(text: string, duration: number): TimedSegment[] {
  const phrases = text
    .split('\n')
    .flatMap((line) => cutAtPunctuation(line.replace(/\s/g, ' ')))
    .reduce<string[]>((joined, phrase) => joinShortLead(joined, phrase), [])
    .flatMap((phrase) => splitLongPhrase(phrase))
  const spokenLength = (phrase: string): number => spokenText(phrase).length
  const total = phrases.reduce((sum, phrase) => sum + spokenLength(phrase), 0) || 1
  let at = 0
  return phrases.map((phrase) => {
    const startSecond = (at / total) * duration
    at += spokenLength(phrase)
    return { text: phrase, startSecond, endSecond: (at / total) * duration }
  })
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

/** A decoded envelope and length, and the clip they were decoded from. */
interface DecodedWave {
  readonly url: string
  readonly wave: number[]
  readonly duration: number
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

/**
 * Decode a real audio file's envelope and length once (recordings). The length matters because a
 * MediaRecorder webm carries no duration header: its audio element reports Infinity.
 */
async function decodeFileWaveform(
  url: string,
  points: number
): Promise<{ wave: number[]; duration: number }> {
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
    return { wave: out, duration: audio.duration }
  } catch {
    return { wave: [], duration: 0 }
  }
}

/** What the listener reads when a voice note or a reply cannot be played. */
function playbackFailure(error: unknown, recording: boolean): string {
  if (recording) return 'Voice note could not be played. Check your audio output, then try again.'
  return error instanceof Error && error.message.trim()
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : 'Speech could not be generated. Try again.'
}

/** A compact ghost icon action with its tooltip. */
function BubbleAction({
  label,
  onClick,
  disabled,
  className,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={`text-muted-foreground hover:text-foreground ${pressable} ${className ?? ''}`}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** Swaps one glyph for another with the reference's spring (a plain fade under reduced motion). */
function GlyphSwap({
  swapKey,
  children
}: {
  swapKey: string
  children: React.ReactNode
}): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={swapKey}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: -30 }}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 30 }}
        transition={reduceMotion ? { duration: 0.15 } : glyphSpring}
        className="flex"
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}

type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused'

/** The large round filled play/pause button, its glyph swapping on a spring. */
function PlayButton({
  status,
  onClick
}: {
  status: PlaybackStatus
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-lg"
          onClick={onClick}
          aria-label={
            status === 'loading'
              ? 'Preparing voice note'
              : status === 'playing'
                ? 'Pause voice note'
                : 'Play voice note'
          }
          aria-pressed={status === 'playing'}
          aria-busy={status === 'loading' || undefined}
          className={`shrink-0 rounded-full ${pressable}`}
        >
          <GlyphSwap
            swapKey={status === 'loading' ? 'loading' : status === 'playing' ? 'pause' : 'play'}
          >
            {status === 'loading' ? (
              <CircleNotch
                size={18}
                weight="bold"
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : status === 'playing' ? (
              <Pause size={18} weight="fill" aria-hidden="true" />
            ) : (
              <Play size={18} weight="fill" className="translate-x-px" aria-hidden="true" />
            )}
          </GlyphSwap>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {status === 'loading' ? 'Preparing voice' : status === 'playing' ? 'Pause' : 'Play'}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The seek slider: two stacked waveforms (the played one clipped to the playhead and glowing),
 * the playhead, and a hover position line. Drag, click, or use the arrow keys, Home and End.
 */
function SeekWaveform({
  bars,
  progress,
  totalDuration,
  seekTo
}: {
  bars: number[]
  progress: number
  totalDuration: number
  seekTo: (fraction: number) => void
}): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  const scrubbing = useRef(false)
  const [hover, setHover] = useState<number | null>(null)
  // Played bars in the brand green, unplayed in the text colour (dimmed by the layer's opacity),
  // both resolved to concrete colours because the canvas cannot paint a CSS variable.
  const playedColor = useBrandColor('--og-primary', '#34d399')
  const unplayedColor = useBrandColor('--og-text', '#ffffff')
  const fractionAt = (element: HTMLElement, clientX: number): number => {
    const rect = element.getBoundingClientRect()
    return rect.width ? (clientX - rect.left) / rect.width : 0
  }
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Seek voice note"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalDuration)}
      aria-valuenow={Math.round(progress * totalDuration)}
      aria-valuetext={`${formatDuration(progress * totalDuration)} of ${formatDuration(totalDuration)}`}
      className="group relative order-last min-w-0 basis-full cursor-pointer touch-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/60 @sm:order-none @sm:basis-0 @sm:flex-1"
      onKeyDown={(event) => {
        const key = event.key
        if (key === 'ArrowRight') seekTo(progress + SEEK_STEP)
        else if (key === 'ArrowLeft') seekTo(progress - SEEK_STEP)
        else if (key === 'Home') seekTo(0)
        else if (key === 'End') seekTo(1)
        else return
        event.preventDefault()
      }}
      onPointerDown={(event) => {
        scrubbing.current = true
        event.currentTarget.setPointerCapture(event.pointerId)
        seekTo(fractionAt(event.currentTarget, event.clientX))
      }}
      onPointerMove={(event) => {
        const fraction = fractionAt(event.currentTarget, event.clientX)
        setHover(Math.max(0, Math.min(1, fraction)))
        if (scrubbing.current) seekTo(fraction)
      }}
      onPointerUp={() => (scrubbing.current = false)}
      onPointerCancel={() => (scrubbing.current = false)}
      onPointerLeave={() => setHover(null)}
    >
      <Waveform
        data={bars}
        height={WAVEFORM_HEIGHT}
        barWidth={2}
        barGap={2}
        barColor={unplayedColor}
        className="opacity-35 transition-opacity duration-300 group-hover:opacity-45"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}
      >
        <Waveform
          data={bars}
          height={WAVEFORM_HEIGHT}
          barWidth={2}
          barGap={2}
          barColor={playedColor}
          aria-hidden="true"
          className="drop-shadow-[0_0_8px_rgb(var(--og-rgb-primary)/0.55)]"
        />
      </div>
      <div
        className="pointer-events-none absolute inset-y-1 w-px bg-primary shadow-[0_0_12px_rgb(var(--og-rgb-primary)/0.9)]"
        style={{ left: `${progress * 100}%` }}
      />
      <AnimatePresence>
        {hover !== null && (
          <motion.div
            data-slot="voice-hover-line"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="pointer-events-none absolute inset-y-3 w-px bg-foreground/30"
            style={{ left: `${hover * 100}%` }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** The transcript under the player: phrases light up with the playhead and seek when clicked. */
function FollowAlong({
  open,
  segments,
  currentTime,
  onSeek
}: {
  open: boolean
  segments: TimedSegment[]
  currentTime: number
  onSeek: (seconds: number) => void
}): React.JSX.Element {
  const reduceMotion = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="transcript"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6, filter: 'blur(4px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)' }}
          transition={{ duration: reduceMotion ? 0.15 : 0.4, ease }}
          className="mt-3 space-y-2 border-t border-border/50 pt-3"
        >
          <p className="font-mono text-[10px] tracking-[0.22em] text-muted-foreground uppercase">
            Follow along
          </p>
          {/* Phrases follow the playhead; a click seeks there (timings are estimated). */}
          <Transcription
            segments={segments}
            currentTime={currentTime}
            onSeek={onSeek}
            className="gap-x-1.5 text-[14px] leading-relaxed font-light break-words"
          >
            {(segment, index) => (
              <TranscriptionSegment
                key={index}
                index={index}
                segment={segment}
                className="rounded-sm outline-none transition-[color,text-shadow,opacity] duration-500 ease-out focus-visible:ring-2 focus-visible:ring-ring/60 active:opacity-70 motion-reduce:transition-none data-[active=true]:[text-shadow:0_0_14px_rgb(var(--og-rgb-primary)/0.55)]"
              />
            )}
          </Transcription>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/** Speed, captions, copy and regenerate: compact ghost icon buttons, each with a tooltip. */
function VoiceActions({
  speed,
  onCycleSpeed,
  transcriptShown,
  onToggleTranscript,
  copied,
  onCopy,
  retryLabel,
  onRetry
}: {
  speed: number
  onCycleSpeed: () => void
  transcriptShown: boolean
  onToggleTranscript?: () => void
  copied: boolean
  onCopy?: () => void
  retryLabel: string
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={onCycleSpeed}
            aria-label={`Playback speed ${speed}x`}
            className={`w-auto min-w-7 px-1.5 font-mono text-[10px] text-muted-foreground tabular-nums hover:text-foreground ${pressable}`}
          >
            <GlyphSwap swapKey={String(speed)}>{speed}x</GlyphSwap>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Playback speed</TooltipContent>
      </Tooltip>
      {onToggleTranscript ? (
        <BubbleAction
          label={transcriptShown ? 'Hide transcript' : 'Show transcript'}
          onClick={onToggleTranscript}
          className={transcriptShown ? 'text-foreground' : undefined}
        >
          <GlyphSwap swapKey={transcriptShown ? 'hide' : 'show'}>
            {transcriptShown ? (
              <SubtitlesSlash size={15} aria-hidden="true" />
            ) : (
              <Subtitles size={15} aria-hidden="true" />
            )}
          </GlyphSwap>
        </BubbleAction>
      ) : null}
      {onCopy ? (
        <BubbleAction
          label={copied ? 'Copied' : 'Copy transcript'}
          onClick={onCopy}
          className={copied ? 'text-primary hover:text-primary' : undefined}
        >
          <GlyphSwap swapKey={copied ? 'copied' : 'copy'}>
            {copied ? (
              <Check size={15} weight="bold" aria-hidden="true" />
            ) : (
              <Copy size={15} aria-hidden="true" />
            )}
          </GlyphSwap>
          {copied ? (
            <span role="status" aria-live="polite" className="sr-only">
              Copied
            </span>
          ) : null}
        </BubbleAction>
      ) : null}
      {onRetry ? (
        <BubbleAction label={retryLabel} onClick={onRetry}>
          <ArrowsClockwise size={15} aria-hidden="true" />
        </BubbleAction>
      ) : null}
    </div>
  )
}

interface VoiceBubbleProps {
  messageId: string
  /** Recorded clip URL for user voice notes; absent for assistant replies. */
  audioUrl?: string
  durationSeconds?: number
  transcript: string
  isUser?: boolean
  /** Synthesize text → playable dataUrl on-device (assistant replies). */
  synthesize: (
    text: string,
    voice?: string,
    /** A long reply's passes as they are ready, so playback starts before the whole clip. */
    onPass?: (pass: { index: number; count: number; dataUrl: string }) => void
  ) => Promise<{ dataUrl: string }>
  /** Read the selected voice before playing a synthesized reply. */
  readVoice?: () => Promise<string | undefined>
  /** Play once automatically when ready (a just-finished assistant reply). */
  autoPlay?: boolean
  /** The latest assistant voice reply opens its transcript without another click. */
  showTranscriptInitially?: boolean
  /** Persisted playback speed from Voice settings. */
  defaultSpeed?: number
  /** Use the parent message bubble for width, color, border, and padding. */
  embedded?: boolean
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
  synthesize,
  readVoice,
  autoPlay = false,
  showTranscriptInitially = false,
  defaultSpeed = 1,
  embedded = false,
  onPlaybackStateChange,
  copied = false,
  onCopy,
  onRetry
}) => {
  const audioRef = useRef<PlayableClip | null>(null)
  const srcRef = useRef<{ dataUrl: string; voice?: string } | null>(null)
  /** Where the next fresh clip starts, when the listener sought while no clip was playing. */
  const pendingStartRef = useRef(0)
  const [status, setStatus] = useState<PlaybackStatus>('idle')
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

  useEffect(() => {
    if (showTranscriptInitially && transcript) setShowTranscript(true)
  }, [showTranscriptInitially, transcript])

  // Telling the audio element about a new preference IS updating an external system, which is what
  // an effect is for. Resetting the chip is not - see `appliedDefaultSpeed`.
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
   * clip" is derived rather than kept in sync by clearing state in an effect. Between one clip's
   * url changing and the new one finishing decoding, the bubble draws the transcript-derived
   * shape, which is what it already does before any clip has decoded.
   */
  const [decodedWave, setDecodedWave] = useState<DecodedWave | null>(null)
  useEffect(() => {
    if (!audioUrl) return
    let cancelled = false
    void decodeFileWaveform(audioUrl, WAVEFORM_POINTS).then((decoded) => {
      if (!cancelled) setDecodedWave({ url: audioUrl, ...decoded })
    })
    return () => {
      cancelled = true
    }
  }, [audioUrl])
  const fileWave = waveForClip(audioUrl, decodedWave)

  const bars = useMemo(() => {
    const raw = fileWave.length ? fileWave : waveformFromText(transcript, WAVEFORM_POINTS)
    return normalize(subsample(raw, WAVEFORM_POINTS))
  }, [fileWave, transcript])

  // Estimate duration before the audio element reports a real value.
  const decodedDuration = decodedWave && decodedWave.url === audioUrl ? decodedWave.duration : 0
  const estDuration = useMemo(() => {
    if (durationSeconds) return durationSeconds
    if (decodedDuration > 0) return decodedDuration
    const words = transcript.trim().split(/\s+/).filter(Boolean).length
    return Math.max(1, words / (2.5 * speed))
  }, [durationSeconds, decodedDuration, transcript, speed])
  const { totalDuration, progress } = playbackProgress({ loadedDuration, estDuration, currentTime })
  const segments = useMemo(
    () => phraseSegments(transcript, totalDuration),
    [transcript, totalDuration]
  )

  // Pause when another bubble takes over playback.
  useEffect(() => {
    return onVoicePlaybackClaim((id) => {
      if (id !== messageId && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause()
        setStatus('paused')
      }
    })
  }, [messageId])

  useEffect(
    () => () => {
      audioRef.current?.pause()
      audioRef.current = null
    },
    []
  )

  // timeupdate fires a few times a second; follow the playhead every frame while playing so the
  // played waveform and the playhead glide instead of stepping. Each render that moved the
  // playhead asks for one more frame; when the clock stands still (buffering) the chain rests
  // until the next timeupdate moves it again.
  useEffect(() => {
    if (status !== 'playing') return
    const frame = requestAnimationFrame(() => {
      if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
    })
    return () => cancelAnimationFrame(frame)
  }, [status, currentTime])

  const wire = useCallback(
    (audio: PlayableClip) => {
      audio.playbackRate = speed
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setLoadedDuration(audio.duration)
      }
      audio.onended = () => {
        pendingStartRef.current = 0
        setStatus('idle')
        setCurrentTime(0)
      }
      audio.onerror = () => setStatus('idle')
    },
    [speed]
  )

  const handlePlayPause = useCallback(async () => {
    if (isUser && !audioUrl) {
      setPlaybackError('This voice recording is no longer on this device.')
      return
    }
    const audio = audioRef.current
    if (status === 'playing' && audio) {
      audio.pause()
      setStatus('paused')
      return
    }
    setPlaybackError(null)
    setStatus('loading')
    try {
      const voice = audioUrl ? undefined : await readVoice?.().catch(() => undefined)
      if (status === 'paused' && audio && (audioUrl || srcRef.current?.voice === voice)) {
        const pendingStart = pendingStartRef.current
        claimVoicePlayback(messageId)
        await audio.play()
        // Cleared only once playback starts, and only if no newer seek replaced it.
        if (pendingStartRef.current === pendingStart) pendingStartRef.current = 0
        setStatus('playing')
        return
      }
      // A changed voice must not resume or reuse the previous synthesized clip.
      audio?.pause()
      audioRef.current = null
      setLoadedDuration(0)
      const cached = srcRef.current
      const src = audioUrl || (cached && cached.voice === voice ? cached.dataUrl : null)
      // A clip on hand plays as it is. A reply still to be made plays pass by pass as it arrives,
      // so the voice starts after its first sentence instead of after the whole reply.
      const playback = src ? null : new PassPlayback()
      const clip: PlayableClip = playback ?? new Audio(src!)
      audioRef.current = clip
      wire(clip)
      const made = playback
        ? synthesize(transcript, voice, (pass) => playback.addPass(pass.index, pass.dataUrl)).then(
            ({ dataUrl }) => {
              if (!dataUrl) throw new Error('no audio')
              srcRef.current = { dataUrl, voice }
              playback.setFull(dataUrl)
            }
          )
        : null
      // A seek made while the clip was being prepared still counts.
      const startAt = pendingStartRef.current
      setCurrentTime(startAt)
      if (startAt > 0) clip.currentTime = startAt
      claimVoicePlayback(messageId)
      const playing = clip.play()
      // The first audio, or the synthesis failing before any audio exists.
      await (made ? Promise.race([playing, made.then(() => playing)]) : playing)
      if (pendingStartRef.current === startAt) pendingStartRef.current = 0
      setStatus('playing')
      // The rest of the reply can still fail after its first sentence started playing.
      made?.catch((e: unknown) => {
        if (audioRef.current !== clip) return
        clip.pause()
        setStatus('idle')
        setPlaybackError(playbackFailure(e, false))
      })
    } catch (e) {
      console.error('[voice] playback failed', e)
      setStatus('idle')
      setPlaybackError(playbackFailure(e, Boolean(audioUrl)))
    }
  }, [status, isUser, audioUrl, readVoice, transcript, synthesize, wire, messageId])

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => {
      const next = SPEED_STEPS[(SPEED_STEPS.indexOf(prev) + 1) % SPEED_STEPS.length] ?? 1.0
      if (audioRef.current) audioRef.current.playbackRate = next
      return next
    })
  }, [])

  /**
   * Move the playhead to `seconds`. With a clip loaded it moves the clip; before there is one it
   * moves the readout and remembers the spot, so Play starts from where the listener pointed.
   */
  const seekSeconds = useCallback(
    (seconds: number) => {
      const audio = audioRef.current
      const length = audio && Number.isFinite(audio.duration) ? audio.duration : totalDuration
      const next = Math.max(0, Math.min(length, seconds))
      if (audio) audio.currentTime = next
      // An ended clip is replaced on the next Play, so the spot is remembered either way.
      pendingStartRef.current = next
      setCurrentTime(next)
    },
    [totalDuration]
  )
  const seekTo = useCallback(
    (fraction: number) => seekSeconds(Math.max(0, Math.min(1, fraction)) * totalDuration),
    [seekSeconds, totalDuration]
  )

  // Auto-play once a freshly-finished assistant reply is ready.
  const autoPlayedRef = useRef(false)
  useEffect(() => {
    if (autoPlay && !autoPlayedRef.current && status === 'idle') {
      autoPlayedRef.current = true
      void handlePlayPause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay])

  // Before playback starts nothing is on the clock, so the transcript reads as one even text.
  const transcriptTime = status === 'idle' && currentTime === 0 ? totalDuration : currentTime

  const surface = embedded
    ? 'flex w-full flex-col'
    : `flex w-[88%] max-w-[34rem] flex-col rounded-2xl border px-4 py-3 ${
        isUser
          ? 'self-end border-primary/25 bg-primary/[0.06]'
          : 'self-start border-border/60 bg-card'
      }`

  return (
    // Its own provider: voice notes also render outside the app shell's provider.
    <TooltipProvider delayDuration={300}>
      <div className={`@container ${surface}`}>
        {/* One row: play, waveform, time, then the actions. Narrow cards drop the waveform below. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* A second press while the clip is being prepared would start a second synthesis. */}
          <PlayButton
            status={status}
            onClick={() => {
              if (status !== 'loading') void handlePlayPause()
            }}
          />

          <SeekWaveform
            bars={bars}
            progress={progress}
            totalDuration={totalDuration}
            seekTo={seekTo}
          />

          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums @sm:ml-0">
            <span className="text-foreground">{formatDuration(currentTime)}</span>
            <span className="mx-1 text-muted-foreground/50">/</span>
            {formatDuration(totalDuration)}
          </span>
          <VoiceActions
            speed={speed}
            onCycleSpeed={cycleSpeed}
            transcriptShown={showTranscript}
            onToggleTranscript={transcript ? () => setShowTranscript((shown) => !shown) : undefined}
            copied={copied}
            onCopy={onCopy ? () => onCopy(transcript) : undefined}
            retryLabel={isUser ? 'Resend' : 'Regenerate'}
            onRetry={onRetry}
          />
        </div>

        <AutoHeight>
          <FollowAlong
            open={showTranscript && Boolean(transcript)}
            segments={segments}
            currentTime={transcriptTime}
            onSeek={seekSeconds}
          />
          {playbackError ? (
            <div
              role="alert"
              className="mt-3 border-t border-destructive/30 pt-2 text-[11.5px] leading-relaxed text-destructive"
            >
              {playbackError}
            </div>
          ) : null}
        </AutoHeight>
      </div>
    </TooltipProvider>
  )
}
