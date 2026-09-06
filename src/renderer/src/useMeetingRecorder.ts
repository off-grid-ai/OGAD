import { useEffect, useState, useCallback } from 'react'
import { getRendererIsPro } from './bootstrap/entitlementRegistry'

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

function isMeetingState(value: unknown): value is MeetingState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return (
    typeof state.recording === 'boolean' &&
    typeof state.busy === 'boolean' &&
    (typeof state.platform === 'string' || state.platform === null) &&
    typeof state.startedAt === 'number' &&
    typeof state.warnUntil === 'number' &&
    typeof state.error === 'string'
  )
}

function reportCommandFailure(command: string, error: unknown): void {
  console.error(`Meeting ${command} failed:`, error)
}

/**
 * Thin VIEW of the meeting recorder. The lifecycle (detect → record → warn → stop →
 * finalize) lives entirely in the main-process MeetingController; this hook only
 * subscribes to the state it broadcasts and sends commands. It makes NO start/stop
 * decisions and owns no timers that drive recording — so there are no stale closures
 * to leave a recording running (the old useEffect/captured-closure bug class is gone).
 */
export function useMeetingRecorder(enabled: boolean): MeetingRecorder {
  const [st, setSt] = useState<MeetingState>(EMPTY)
  const [elapsed, setElapsed] = useState(0)
  const [warningSecondsLeft, setWarningSecondsLeft] = useState(0)

  // Subscribe to the controller's broadcast + seed from current state on mount.
  useEffect(() => {
    let alive = true
    if (!enabled) {
      void Promise.resolve().then(() => {
        if (alive) setSt(EMPTY)
      })
      return () => {
        alive = false
      }
    }
    let receivedLiveState = false
    const off = window.api.onMeetingState((state: unknown) => {
      if (!alive || !getRendererIsPro()) return
      if (isMeetingState(state)) {
        receivedLiveState = true
        setSt(state)
      } else console.error('Meeting state update was invalid:', state)
    })
    window.api
      .meetingGetState()
      .then((state: unknown) => {
        if (!alive || !getRendererIsPro()) return
        if (!isMeetingState(state)) {
          reportCommandFailure('state read', new Error('The meeting state response was invalid'))
        } else if (!receivedLiveState) setSt(state)
      })
      .catch((error: unknown) => reportCommandFailure('state read', error))
    return () => {
      alive = false
      off()
    }
  }, [enabled])

  // Display-only ticker derived from startedAt + warnUntil — drives nothing. The
  // controller polls every 10s, so the warning countdown is derived here so it actually
  // ticks down each second instead of showing a frozen "20s".
  useEffect(() => {
    if (!enabled || !st.recording || !st.startedAt) {
      return
    }
    const tick = (): void => {
      const now = Date.now()
      setElapsed(Math.max(0, Math.round((now - st.startedAt) / 1000)))
      setWarningSecondsLeft(
        st.warnUntil > 0 ? Math.max(0, Math.round((st.warnUntil - now) / 1000)) : 0
      )
    }
    const frameId = window.requestAnimationFrame(tick)
    const id = setInterval(tick, 1000)
    return () => {
      window.cancelAnimationFrame(frameId)
      clearInterval(id)
    }
  }, [enabled, st.recording, st.startedAt, st.warnUntil])

  const start = useCallback(
    (platform?: string): void => {
      if (!enabled || !getRendererIsPro()) {
        reportCommandFailure(
          'start',
          new Error('Meeting recording is unavailable without active Pro features')
        )
        return
      }
      void window.api
        .meetingStart(platform)
        .catch((error: unknown) => reportCommandFailure('start', error))
    },
    [enabled]
  )
  const stop = useCallback((): void => {
    if (!enabled || !getRendererIsPro()) {
      reportCommandFailure(
        'stop',
        new Error('Meeting recording is unavailable without active Pro features')
      )
      return
    }
    void window.api.meetingStop().catch((error: unknown) => reportCommandFailure('stop', error))
  }, [enabled])
  const keepAlive = useCallback((): void => {
    if (!enabled || !getRendererIsPro()) {
      reportCommandFailure(
        'keep-alive',
        new Error('Meeting recording is unavailable without active Pro features')
      )
      return
    }
    void window.api
      .meetingKeepAlive()
      .catch((error: unknown) => reportCommandFailure('keep-alive', error))
  }, [enabled])

  const visibleState = enabled ? st : EMPTY
  const visibleElapsed = visibleState.recording && visibleState.startedAt ? elapsed : 0
  const visibleWarningSecondsLeft =
    visibleState.recording && visibleState.startedAt ? warningSecondsLeft : 0

  return {
    recording: visibleState.recording,
    busy: visibleState.busy,
    elapsed: visibleElapsed,
    warningSecondsLeft: visibleWarningSecondsLeft,
    platform: visibleState.platform,
    error: visibleState.error,
    start,
    stop,
    keepAlive
  }
}
