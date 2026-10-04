import { useEffect, useState, useCallback } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api

export interface MeetingRecorder {
  recording: boolean
  busy: boolean // transcribing after stop
  elapsed: number // seconds, display-only (derived from startedAt)
  warningSecondsLeft: number // >0 while the "switch back or we stop" warning shows
  platform: string | null
  error: string
  start: (platform?: string) => void
  stop: () => void
  keepAlive: () => void
}

interface MeetingState {
  recording: boolean
  busy: boolean
  platform: string | null
  startedAt: number
  warnUntil: number // epoch ms the auto-stop warning expires (0 = no warning)
  error: string
}

const EMPTY: MeetingState = {
  recording: false,
  busy: false,
  platform: null,
  startedAt: 0,
  warnUntil: 0,
  error: ''
}

/**
 * Thin VIEW of the meeting recorder. The lifecycle (detect → record → warn → stop →
 * finalize) lives entirely in the main-process MeetingController; this hook only
 * subscribes to the state it broadcasts and sends commands. It makes NO start/stop
 * decisions and owns no timers that drive recording — so there are no stale closures
 * to leave a recording running (the old useEffect/captured-closure bug class is gone).
 */
export function useMeetingRecorder(): MeetingRecorder {
  const [st, setSt] = useState<MeetingState>(EMPTY)
  const [elapsed, setElapsed] = useState(0)
  const [warningSecondsLeft, setWarningSecondsLeft] = useState(0)

  // Subscribe to the controller's broadcast + seed from current state on mount.
  useEffect(() => {
    let alive = true
    api
      .meetingGetState?.()
      .then((s: MeetingState | undefined) => {
        if (alive && s) setSt(s)
      })
      .catch(() => {})
    const off = api.onMeetingState?.((s: MeetingState) => setSt(s))
    return () => {
      alive = false
      off?.()
    }
  }, [])

  // Display-only ticker derived from startedAt + warnUntil — drives nothing. The
  // controller polls every 10s, so the warning countdown is derived here so it actually
  // ticks down each second instead of showing a frozen "20s".
  useEffect(() => {
    if (!st.recording || !st.startedAt) {
      setElapsed(0)
      setWarningSecondsLeft(0)
      return
    }
    const tick = (): void => {
      const now = Date.now()
      setElapsed(Math.max(0, Math.round((now - st.startedAt) / 1000)))
      setWarningSecondsLeft(
        st.warnUntil > 0 ? Math.max(0, Math.round((st.warnUntil - now) / 1000)) : 0
      )
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [st.recording, st.startedAt, st.warnUntil])

  const start = useCallback((platform?: string): void => {
    void api.meetingStart?.(platform)
  }, [])
  const stop = useCallback((): void => {
    void api.meetingStop?.()
  }, [])
  const keepAlive = useCallback((): void => {
    void api.meetingKeepAlive?.()
  }, [])

  return {
    recording: st.recording,
    busy: st.busy,
    elapsed,
    warningSecondsLeft,
    platform: st.platform,
    error: st.error,
    start,
    stop,
    keepAlive
  }
}
