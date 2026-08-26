import { useEffect } from 'react'
import type { BrowserSessionsSnapshot } from '../../../../../shared/browser-session'
import type { LiveComputerState, NavigationState } from './useTaskFeeds'
import type { TaskTab } from './task-types'

interface ActiveTaskInput {
  tabs: TaskTab[]
  visibleTabs: TaskTab[]
  activeId: string | null
  browserState: BrowserSessionsSnapshot
  liveComputerState: LiveComputerState | null
  setNavigation: React.Dispatch<React.SetStateAction<NavigationState>>
  setAddress: React.Dispatch<React.SetStateAction<string>>
  setAddressError: React.Dispatch<React.SetStateAction<string>>
}

function findActive(
  tabs: TaskTab[],
  visibleTabs: TaskTab[],
  activeId: string | null
): TaskTab | null {
  return tabs.find((tab) => tab.taskId === activeId) ?? visibleTabs[0] ?? null
}

function journeyPages(
  active: TaskTab | null,
  browserState: BrowserSessionsSnapshot
): BrowserSessionsSnapshot['sessions'] {
  if (active?.kind !== 'web_use' || active.manual) return []
  return browserState.sessions.filter(
    (session) =>
      session.kind === 'task' &&
      (session.taskId === active.taskId ||
        (!session.taskId && session.journeyId === active.journeyId))
  )
}

export function useActiveTask(input: ActiveTaskInput): {
  active: TaskTab | null
  activeIsLive: boolean
  activeComputerIsLocal: boolean
  activeWebIsLocal: boolean
  activeEscNotice?: string
  activeJourneyPages: BrowserSessionsSnapshot['sessions']
} {
  const { setNavigation, setAddress, setAddressError } = input
  const active = findActive(input.tabs, input.visibleTabs, input.activeId)
  const activeIsLive = active
    ? ['running', 'paused', 'waiting', 'reconnecting'].includes(active.status)
    : false
  const activeComputerIsLocal =
    active?.kind === 'computer_use' && input.liveComputerState?.taskId === active.taskId
  const activeWebIsLocal = active?.kind === 'web_use' && Boolean(active.sessionId)
  const activeEscNotice = activeComputerIsLocal ? input.liveComputerState?.notice : undefined
  const activeBrowserSession = active?.sessionId
    ? input.browserState.sessions.find((session) => session.sessionId === active.sessionId)
    : undefined
  const activeJourneyPages = journeyPages(active, input.browserState)

  useEffect(() => {
    if (!active) return
    if (activeBrowserSession) {
      queueMicrotask(() => {
        setNavigation(activeBrowserSession)
        setAddress(activeBrowserSession.url)
        setAddressError('')
      })
      return
    }
    if (active.kind !== 'web_use') return
    const historicNavigation: NavigationState = {
      url: active.lastUrl ?? '',
      title: active.lastTitle ?? 'Saved page',
      canGoBack: false,
      canGoForward: false,
      isLoading: false
    }
    queueMicrotask(() => {
      setNavigation(historicNavigation)
      setAddress(historicNavigation.url)
      setAddressError('')
    })
  }, [active, activeBrowserSession, setAddress, setAddressError, setNavigation])

  return {
    active,
    activeIsLive,
    activeComputerIsLocal,
    activeWebIsLocal,
    activeEscNotice,
    activeJourneyPages
  }
}
