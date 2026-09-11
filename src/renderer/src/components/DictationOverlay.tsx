// Dictation overlay renderer (#dictation hash route). Free-tier / open-core feature.
// Runs in the small, non-focusable always-on-top window. Owns the mic capture pipeline:
// getUserMedia → MediaRecorder (webm/opus) → on stop, the whole recording ships to
// main as one blob, plus a live RMS level meter and an elapsed timer.
//
// Why MediaRecorder and NOT a raw-PCM AudioWorklet: the browser writes the correct
// sample rate + timing into the container, so nothing can be mislabeled/stretched
// (the AudioWorklet path shipped a 2x-slow "slow-mo" bug). Main runs ONE ffmpeg
// pass (container → 16 kHz mono) for whisper. The AudioContext here drives ONLY the
// level meter (an AnalyserNode) — it never touches the recorded audio.

import { useEffect, useRef, useState } from 'react'
import { Microphone, Square } from '@phosphor-icons/react'
import { voice } from '@renderer/lib/voiceApi'
import { shortcutLabel } from '@renderer/lib/device'
// Fallback when the settings read returns no accelerator: the one owner of the default chord,
// in Electron's REGISTRATION format, which `shortcutLabel` turns into per-platform copy.
import { DEFAULT_DICTATION_ACCELERATOR } from '@offgrid/core/shared/dictation-defaults'

type Phase = 'recording' | 'transcribing'

export function DictationOverlay(): React.JSX.Element | null {
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<Phase>('recording')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<'hold' | 'toggle' | 'both'>('hold')
  // The accelerator as REGISTERED (Electron's vocabulary). What the hint prints is derived from
  // it per platform, so the copy can never disagree with the key the app actually listens for.
  const [accelerator, setAccelerator] = useState(DEFAULT_DICTATION_ACCELERATOR)

  const ctxRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const captureStartingRef = useRef(false)
  const captureSequenceRef = useRef(0)
  const blobsRef = useRef<Blob[]>([])
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const errorHideRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const errorVisibleRef = useRef(false)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  // True while a live-interim request is in flight — the next timeslice waits for it,
  // so we never queue up overlapping interim passes (self-pacing).
  const interimBusyRef = useRef(false)

  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [interim])

  async function startCapture(): Promise<void> {
    const v = voice()
    // eslint-disable-next-line no-console
    console.log(
      `[dict] startCapture hasApi=${!!v} hasStream=${!!streamRef.current} starting=${captureStartingRef.current}`
    )
    if (!v || streamRef.current || captureStartingRef.current) return
    captureStartingRef.current = true
    const sequence = ++captureSequenceRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Dictation is not a WebRTC call. Browser voice processing can suppress
          // quiet speech and distort prerecorded/native microphone input. Preserve
          // the signal here; main owns loudness normalization before STT.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
      // The queued first-open `begin` event and the getState recovery can arrive
      // together while permission is pending. One session owns one recorder. A
      // stop/suspend also invalidates this sequence so a late permission result
      // cannot resurrect a recording that already ended.
      if (sequence !== captureSequenceRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream

      // Capture with MediaRecorder — the browser owns the encode and writes correct
      // rate/timing into the webm/opus container, so the recording can't be
      // mislabeled or time-stretched. A 1s timeslice emits chunks as we go: on stop
      // we ship the whole blob for the final pass, and between ticks we ship the
      // growing recording-so-far for a live-interim transcript on screen.
      blobsRef.current = []
      interimBusyRef.current = false
      const rec = new MediaRecorder(stream)
      recorderRef.current = rec
      rec.ondataavailable = (e) => {
        if (e.data.size === 0) return
        blobsRef.current.push(e.data)
        // Live interim: transcribe the recording-so-far. Self-paced — skip while a
        // previous interim is still running (never pile up / hammer the machine).
        if (interimBusyRef.current || rec.state !== 'recording') return
        interimBusyRef.current = true
        const type = rec.mimeType || 'audio/webm'
        const soFar = new Blob(blobsRef.current, { type })
        void soFar
          .arrayBuffer()
          .then((buf) => v.sendInterimAudio(buf, type))
          .then((text) => {
            if (text) setInterim(text)
          })
          .catch(() => {
            /* interim is best-effort */
          })
          .finally(() => {
            interimBusyRef.current = false
          })
      }
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm'
        const blob = new Blob(blobsRef.current, { type })
        blobsRef.current = []
        void blob
          .arrayBuffer()
          .then((buf) => v.sendAudio(buf, type))
          .finally(() => teardownStream())
      }
      rec.start(1000) // 1s timeslices → ondataavailable every ~1s

      // Level meter ONLY — an AnalyserNode on the same stream drives the VU bars.
      // Kept entirely separate from the recorder; it never touches recorded audio.
      const ctx = new AudioContext()
      ctxRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Uint8Array(analyser.fftSize)
      const tick = (): void => {
        analyser.getByteTimeDomainData(buf)
        let sum = 0
        for (let i = 0; i < buf.length; i++) {
          const x = (buf[i]! - 128) / 128
          sum += x * x
        }
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6))
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      stopCapture()
      setError(e instanceof Error ? e.message : 'Microphone unavailable')
    } finally {
      if (sequence === captureSequenceRef.current) captureStartingRef.current = false
    }
  }

  /** Stop the mic tracks + meter (called after the blob is shipped, and as a
   *  safety net on teardown). Idempotent. */
  function teardownStream(): void {
    try {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      void ctxRef.current?.close()
    } catch {
      /* ignore */
    }
    rafRef.current = null
    streamRef.current = null
    ctxRef.current = null
  }

  /** Stop everything. If the recorder is still running, stop() fires onstop which
   *  ships the blob and then tears down; otherwise tear down directly. */
  function stopCapture(): void {
    captureSequenceRef.current += 1
    captureStartingRef.current = false
    const rec = recorderRef.current
    recorderRef.current = null
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop()
        return
      } catch {
        /* fall through to teardown */
      }
    }
    teardownStream()
  }

  useEffect(() => {
    const v = voice()
    if (!v) return
    const begin = (): void => {
      if (errorHideRef.current) {
        clearTimeout(errorHideRef.current)
        errorHideRef.current = null
      }
      errorVisibleRef.current = false
      setError(null)
      setInterim('')
      setLevel(0)
      setElapsed(0)
      setPhase('recording')
      setActive(true)
      startRef.current = Date.now()
      if (!timerRef.current)
        timerRef.current = setInterval(
          () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
          250
        )
      void startCapture()
    }
    void v.getState().then((s) => {
      if (s === 'recording') begin()
    })
    void v.getSettings().then((s) => {
      setMode(s.mode)
      setAccelerator(s.accelerator || DEFAULT_DICTATION_ACCELERATOR)
    })
    const offs = [
      v.on('begin', begin),
      v.on('interim', (text) => setInterim(String(text ?? ''))),
      v.on('end', () => {
        setPhase('transcribing')
        // Stop the recorder — its onstop ships the complete blob to main, then
        // tears down the stream. (No PCM to flush; the container holds it all.)
        stopCapture()
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
      }),
      v.on('final', () => {
        setActive(false)
        setInterim('')
      }),
      v.on('state', (s) => {
        if (s === 'idle' && !errorVisibleRef.current) {
          setActive(false)
          stopCapture()
          if (timerRef.current) {
            clearInterval(timerRef.current)
            timerRef.current = null
          }
        }
      }),
      v.on('error', (msg) => {
        errorVisibleRef.current = true
        setError(String(msg ?? 'Dictation error'))
        setActive(true)
        stopCapture()
        if (errorHideRef.current) clearTimeout(errorHideRef.current)
        errorHideRef.current = setTimeout(() => {
          errorVisibleRef.current = false
          setActive(false)
        }, 2600)
      })
    ]
    return () => {
      offs.forEach((off) => off())
      stopCapture()
      if (timerRef.current) clearInterval(timerRef.current)
      if (errorHideRef.current) clearTimeout(errorHideRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!active) return null

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')
  const stop = (): void => {
    void voice()?.toggle()
  }
  const keys = shortcutLabel(accelerator)
  const hint = mode === 'hold' ? `release ${keys} to stop` : `tap ${keys} or ■ to stop`

  return (
    <div className="flex h-screen w-screen items-stretch justify-center bg-transparent p-2 font-mono">
      <div className="flex w-full flex-col gap-1.5 rounded-2xl border border-neutral-800 bg-black/90 px-3 py-2.5 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-2.5">
          {error ? (
            <span className="text-xs text-red-400">{error}</span>
          ) : (
            <>
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                {phase === 'recording' && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${phase === 'recording' ? 'bg-emerald-400' : 'bg-amber-400'}`}
                />
              </span>
              <Microphone className="h-4 w-4 shrink-0 text-emerald-400" weight="fill" />
              <div className="flex h-4 flex-1 items-center gap-[2px]">
                {Array.from({ length: 22 }).map((_, i) => {
                  const on = level * 22 > i
                  return (
                    <span
                      key={i}
                      className={`w-[3px] rounded-sm transition-all duration-75 ${on ? 'bg-emerald-400' : 'bg-neutral-700'}`}
                      style={{ height: `${20 + (on ? Math.min(80, (i + 1) * 4) : 8)}%` }}
                    />
                  )
                })}
              </div>
              <span className="shrink-0 text-xs tabular-nums text-neutral-400">
                {phase === 'transcribing' ? 'transcribing…' : `${mm}:${ss}`}
              </span>
              {phase === 'recording' && (
                <button
                  onClick={stop}
                  title="Stop dictation"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-neutral-700 text-neutral-300 transition-all hover:border-red-600 hover:text-red-400 active:scale-90"
                >
                  <Square className="h-3 w-3" weight="fill" />
                </button>
              )}
            </>
          )}
        </div>
        {!error &&
          (interim ? (
            <div
              ref={transcriptRef}
              className="min-h-0 flex-1 overflow-hidden text-[15px] leading-relaxed text-neutral-100"
              style={{ WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 42%)' }}
            >
              <div className="flex min-h-full flex-col justify-end">{interim}</div>
            </div>
          ) : (
            phase === 'recording' && (
              <div className="flex flex-1 items-end text-[11px] text-neutral-600">{hint}</div>
            )
          ))}
      </div>
    </div>
  )
}
