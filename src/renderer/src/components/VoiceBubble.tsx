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
 *  - Assistant replies have no file → we synthesize on-device (Kokoro) the first
 *    time Play is pressed, cache the result, and draw a deterministic
 *    transcript-derived envelope (stable before/during playback).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, CircleNotch, CaretDown, Copy, ArrowsClockwise } from '@phosphor-icons/react';

const WAVEFORM_BARS = 48;
const SPEED_STEPS = [0.5, 0.8, 1.0, 1.25, 1.5, 2.0];

// One bubble plays at a time: when any bubble starts, the rest pause.
const playBus = new EventTarget();

/** Pause every voice bubble — call when leaving a chat so playback never carries
 *  across conversations. A sentinel id matches no bubble, so all of them stop. */
export function stopAllVoicePlayback(): void {
  playBus.dispatchEvent(new CustomEvent('play', { detail: '__stop_all__' }));
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Deterministic, speech-like envelope derived from the transcript (port of the
 *  mobile waveformFromText). Same text → same bars, so it's stable mid-playback. */
function waveformFromText(text: string, points: number): number[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || points <= 0) return Array.from({ length: points }, () => 0);
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    const idx = Math.min(clean.length - 1, Math.floor((i / points) * clean.length));
    const ch = clean[idx];
    const code = clean.charCodeAt(idx);
    let base: number;
    if (ch === ' ') base = 0.12;
    else if (/[.,!?;:]/.test(ch)) base = 0.1;
    else if (/[aeiouAEIOU]/.test(ch)) base = 0.85;
    else base = 0.45;
    const ripple = 0.18 * (1 + Math.sin(idx * 1.7 + (code % 7))) * 0.5;
    out.push(Math.min(1, base + ripple));
  }
  return out;
}

function subsample(data: number[], count: number): number[] {
  if (data.length === 0) return Array.from({ length: count }, () => 0);
  const step = data.length / count;
  const result: number[] = [];
  for (let i = 0; i < count; i++) result.push(data[Math.floor(i * step)] ?? 0);
  return result;
}

function normalize(data: number[]): number[] {
  const max = Math.max(...data, 0.001);
  return data.map((v) => v / max);
}

/** Decode a real audio file's envelope once (recordings). */
async function decodeFileWaveform(url: string, points: number): Promise<number[]> {
  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new Ctx();
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const block = Math.floor(ch.length / points) || 1;
    const out: number[] = [];
    for (let i = 0; i < points; i++) {
      let sum = 0;
      for (let j = 0; j < block; j++) sum += Math.abs(ch[i * block + j] ?? 0);
      out.push(sum / block);
    }
    void ctx.close();
    return out;
  } catch {
    return [];
  }
}

interface VoiceBubbleProps {
  messageId: string;
  /** Recorded clip URL for user voice notes; absent for assistant replies. */
  audioUrl?: string;
  durationSeconds?: number;
  transcript: string;
  isUser?: boolean;
  /** Assistant reply still generating — shows pulsing dots, no playback. */
  isLoading?: boolean;
  /** Synthesize text → playable dataUrl on-device (assistant replies). */
  synthesize: (text: string) => Promise<{ dataUrl: string }>;
  /** Play once automatically when ready (a just-finished assistant reply). */
  autoPlay?: boolean;
  onCopy?: (text: string) => void;
  onRetry?: () => void;
}

export const VoiceBubble: React.FC<VoiceBubbleProps> = ({
  messageId,
  audioUrl,
  durationSeconds,
  transcript,
  isUser = false,
  isLoading = false,
  synthesize,
  autoPlay = false,
  onCopy,
  onRetry,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const srcRef = useRef<string | null>(null); // cached synthesized dataUrl
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
  const [currentTime, setCurrentTime] = useState(0);
  const [loadedDuration, setLoadedDuration] = useState(0);
  const [speed, setSpeed] = useState(1.0);
  const [showTranscript, setShowTranscript] = useState(false);

  // Stable waveform: real decoded envelope for a recording, else transcript-derived.
  const [fileWave, setFileWave] = useState<number[]>([]);
  useEffect(() => {
    if (!audioUrl) { setFileWave([]); return; }
    let cancelled = false;
    void decodeFileWaveform(audioUrl, WAVEFORM_BARS).then((w) => { if (!cancelled) setFileWave(w); });
    return () => { cancelled = true; };
  }, [audioUrl]);

  const bars = useMemo(() => {
    const raw = fileWave.length ? fileWave : waveformFromText(transcript, WAVEFORM_BARS);
    return normalize(subsample(raw, WAVEFORM_BARS));
  }, [fileWave, transcript]);

  // Estimate duration before the audio element reports a real value.
  const estDuration = useMemo(() => {
    if (durationSeconds) return durationSeconds;
    const words = transcript.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(1, words / (2.5 * speed));
  }, [durationSeconds, transcript, speed]);
  const totalDuration = loadedDuration || estDuration;
  const progress = totalDuration ? Math.min(1, currentTime / totalDuration) : 0;

  // Pause when another bubble takes over playback.
  useEffect(() => {
    const onOther = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id !== messageId && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
        setStatus('paused');
      }
    };
    playBus.addEventListener('play', onOther);
    return () => playBus.removeEventListener('play', onOther);
  }, [messageId]);

  useEffect(() => () => { audioRef.current?.pause(); audioRef.current = null; }, []);

  const wire = useCallback((audio: HTMLAudioElement) => {
    audio.playbackRate = speed;
    audio.ontimeupdate = () => setCurrentTime(audio.currentTime);
    audio.onloadedmetadata = () => { if (Number.isFinite(audio.duration)) setLoadedDuration(audio.duration); };
    audio.onended = () => { setStatus('idle'); setCurrentTime(0); };
    audio.onerror = () => setStatus('idle');
  }, [speed]);

  const handlePlayPause = useCallback(async () => {
    const audio = audioRef.current;
    if (status === 'playing' && audio) { audio.pause(); setStatus('paused'); return; }
    if (status === 'paused' && audio) {
      playBus.dispatchEvent(new CustomEvent('play', { detail: messageId }));
      await audio.play(); setStatus('playing'); return;
    }
    // idle → resolve a source (cached synth / recording), then play.
    setStatus('loading');
    try {
      let src = audioUrl || srcRef.current;
      if (!src) {
        const { dataUrl } = await synthesize(transcript);
        if (!dataUrl) throw new Error('no audio');
        srcRef.current = dataUrl;
        src = dataUrl;
      }
      const audioEl = new Audio(src);
      audioRef.current = audioEl;
      wire(audioEl);
      playBus.dispatchEvent(new CustomEvent('play', { detail: messageId }));
      await audioEl.play();
      setStatus('playing');
    } catch (e) {
      console.error('[voice] playback failed', e);
      setStatus('idle');
    }
  }, [status, audioUrl, transcript, synthesize, wire, messageId]);

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => {
      const next = SPEED_STEPS[(SPEED_STEPS.indexOf(prev) + 1) % SPEED_STEPS.length] ?? 1.0;
      if (audioRef.current) audioRef.current.playbackRate = next;
      return next;
    });
  }, []);

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(1, fraction)) * audio.duration;
    setCurrentTime(audio.currentTime);
  }, []);

  // Auto-play once a freshly-finished assistant reply is ready.
  const autoPlayedRef = useRef(false);
  useEffect(() => {
    if (autoPlay && !autoPlayedRef.current && !isLoading && status === 'idle') {
      autoPlayedRef.current = true;
      void handlePlayPause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, isLoading]);

  return (
    <div className={`flex w-[88%] max-w-[34rem] flex-col gap-2 rounded-xl border p-3 ${isUser ? 'self-end border-green-500/40 bg-green-500/10' : 'self-start border-neutral-800 bg-neutral-900/50'}`}>
      <div className="flex items-center gap-2.5">
        {/* Play / pause / loading */}
        <button
          type="button"
          onClick={handlePlayPause}
          disabled={isLoading}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/20 text-green-500 transition-colors hover:bg-green-500/30 ${isLoading ? 'cursor-default opacity-40' : 'cursor-pointer'}`}
          title={status === 'playing' ? 'Pause' : 'Play'}
        >
          {status === 'loading'
            ? <CircleNotch size={16} weight="bold" className="animate-spin" />
            : status === 'playing'
              ? <Pause size={16} weight="fill" />
              : <Play size={16} weight="fill" />}
        </button>

        {/* Waveform (click to seek) */}
        <div className="flex h-10 flex-1 items-center gap-[1.5px] overflow-hidden">
          {isLoading && !isUser ? (
            <span className="flex items-center gap-1.5 pl-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-green-500" />
            </span>
          ) : (
            bars.map((shape, i) => {
              const played = progress > 0 && i / bars.length < progress;
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
                      opacity: played ? 0.7 + shape * 0.3 : 0.2 + shape * 0.25,
                    }}
                  />
                </button>
              );
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
            <CaretDown size={11} weight="bold" className={`transition-transform ${showTranscript ? 'rotate-180' : ''}`} />
          </button>
        ) : <span />}
        <div className="flex items-center gap-2.5">
          <span className="min-w-[2rem] text-right text-[11px] text-neutral-500 tabular-nums">
            {isLoading ? '—' : formatDuration(status === 'idle' ? totalDuration : currentTime || totalDuration)}
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
            <button type="button" onClick={() => onCopy(transcript)} className="cursor-pointer text-neutral-600 transition-colors hover:text-green-500" title="Copy transcript">
              <Copy size={13} />
            </button>
          ) : null}
          {!isLoading && onRetry ? (
            <button type="button" onClick={onRetry} className="cursor-pointer text-neutral-600 transition-colors hover:text-green-500" title="Regenerate">
              <ArrowsClockwise size={13} />
            </button>
          ) : null}
        </div>
      </div>

      {showTranscript && transcript ? (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap border-t border-neutral-800 pt-2 text-xs leading-relaxed text-neutral-300">
          {transcript}
        </div>
      ) : null}
    </div>
  );
};
