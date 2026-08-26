import { useEffect, useRef, useState } from 'react'
import type {
  BrowserNavigationState,
  BrowserPointerEvent,
  BrowserSessionsSnapshot,
  ManualBrowserHistoryEntry
} from '../../../../../shared/browser-session'

export interface LiveComputerState {
  taskId?: string
  notice?: string
}

export interface TakeoverRequest {
  taskId: string
  why: string
}

export type NavigationState = Omit<BrowserNavigationState, 'sessionId'> & { sessionId?: string }
export type ManualBrowserHistory = Pick<
  ManualBrowserHistoryEntry,
  'historyId' | 'title' | 'url' | 'updatedAt'
>

const EMPTY_NAVIGATION: NavigationState = {
  url: '',
  title: 'New tab',
  canGoBack: false,
  canGoForward: false,
  isLoading: false
}

export function useTaskFeeds(): {
  browserState: BrowserSessionsSnapshot
  manualHistory: ManualBrowserHistory[]
  agentPointer: BrowserPointerEvent | null
  liveComputerState: LiveComputerState | null
  takeover: TakeoverRequest | null
  setTakeover: React.Dispatch<React.SetStateAction<TakeoverRequest | null>>
  navigation: NavigationState
  setNavigation: React.Dispatch<React.SetStateAction<NavigationState>>
} {
  const [browserState, setBrowserState] = useState<BrowserSessionsSnapshot>({
    activeSessionId: null,
    sessions: []
  })
  const [manualHistory, setManualHistory] = useState<ManualBrowserHistory[]>([])
  const [agentPointer, setAgentPointer] = useState<BrowserPointerEvent | null>(null)
  const [liveComputerState, setLiveComputerState] = useState<LiveComputerState | null>(null)
  const [takeover, setTakeover] = useState<TakeoverRequest | null>(null)
  const [navigation, setNavigation] = useState<NavigationState>(EMPTY_NAVIGATION)
  const receivedSessionEventRef = useRef(false)
  const receivedVisionEventRef = useRef(false)

  useEffect(() => {
    const vision = window.api.vision as Partial<NonNullable<typeof window.api.vision>> | undefined
    void vision?.getCurrent?.().then((current) => {
      if (!receivedVisionEventRef.current) {
        setLiveComputerState((current?.state as LiveComputerState | undefined) ?? null)
      }
    })
    const offState = vision?.onTaskState?.((state) => {
      receivedVisionEventRef.current = true
      setLiveComputerState(state as LiveComputerState)
    })
    return () => offState?.()
  }, [])

  useEffect(() => {
    const browser = window.api.browser as
      | Partial<NonNullable<typeof window.api.browser>>
      | undefined
    const refreshHistory = (): void => {
      void browser?.listManualHistory?.().then(setManualHistory)
    }
    void browser?.getSessions?.().then((initial) => {
      if (!receivedSessionEventRef.current) setBrowserState(initial)
    })
    refreshHistory()
    const offSessions = browser?.onSessionsState?.((event) => {
      receivedSessionEventRef.current = true
      setBrowserState(event as BrowserSessionsSnapshot)
      refreshHistory()
    })
    const offNavigation = browser?.onNavigationState?.((event) => {
      const state = event as NavigationState
      if (state.sessionId) {
        setBrowserState((current) => ({
          ...current,
          sessions: current.sessions.map((session) =>
            session.sessionId === state.sessionId ? { ...session, ...state } : session
          )
        }))
      }
      setNavigation(state)
    })
    const offPointer = browser?.onPointer?.((event) =>
      setAgentPointer(event as BrowserPointerEvent)
    )
    const offTakeover = browser?.onTakeover?.((event) => setTakeover(event as TakeoverRequest))
    return () => {
      offSessions?.()
      offNavigation?.()
      offPointer?.()
      offTakeover?.()
    }
  }, [])

  return {
    browserState,
    manualHistory,
    agentPointer,
    liveComputerState,
    takeover,
    setTakeover,
    navigation,
    setNavigation
  }
}
