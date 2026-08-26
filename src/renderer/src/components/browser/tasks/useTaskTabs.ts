import { useMemo } from 'react'
import type { TaskSession } from '@renderer/lib/task-session-store'
import type { BrowserSessionsSnapshot } from '../../../../../shared/browser-session'
import type { ManualBrowserHistory } from './useTaskFeeds'
import type { TaskTab } from './task-types'

export function useTaskTabs(
  persistedTasks: TaskSession[],
  browserState: BrowserSessionsSnapshot,
  manualHistory: ManualBrowserHistory[]
): TaskTab[] {
  return useMemo(() => {
    const taskTabs = persistedTasks.map<TaskTab>((task) => {
      if (task.kind === 'computer_use') return task
      const journeyId = task.journeyId ?? task.taskId
      const sessions = browserState.sessions.filter(
        (session) =>
          session.kind === 'task' &&
          (session.taskId === task.taskId || (!session.taskId && session.journeyId === journeyId))
      )
      const session =
        sessions.find((candidate) => candidate.sessionId === browserState.activeSessionId) ??
        sessions.find((candidate) => !candidate.parentSessionId) ??
        sessions[0]
      return {
        ...task,
        journeyId,
        sessionId: session?.sessionId,
        faviconUrl: session?.faviconUrl
      }
    })
    const liveHistoryIds = new Set(
      browserState.sessions
        .filter((session) => session.kind === 'manual')
        .map((session) => session.historyId)
        .filter((value): value is string => Boolean(value))
    )
    const liveManual = browserState.sessions
      .filter((session) => session.kind === 'manual' && session.historyId)
      .map<TaskTab>((session) => {
        const history = manualHistory.find((item) => item.historyId === session.historyId)
        return {
          taskId: `manual:${session.historyId}`,
          kind: 'web_use',
          title: session.title || 'New tab',
          status: 'running',
          steps: [],
          startedAt: history?.updatedAt ?? 0,
          updatedAt: history?.updatedAt ?? 0,
          lastUrl: session.url,
          lastTitle: session.title,
          sessionId: session.sessionId,
          manual: true,
          manualHistoryId: session.historyId,
          faviconUrl: session.faviconUrl
        }
      })
    const closedManual = manualHistory
      .filter((history) => !liveHistoryIds.has(history.historyId))
      .map<TaskTab>((history) => ({
        taskId: `manual:${history.historyId}`,
        kind: 'web_use',
        title: history.title || 'Browser tab',
        status: 'stopped',
        summary: 'This browser tab is closed. Open it to continue browsing.',
        steps: [],
        startedAt: history.updatedAt,
        finishedAt: history.updatedAt,
        updatedAt: history.updatedAt,
        lastUrl: history.url,
        lastTitle: history.title,
        manual: true,
        manualHistoryId: history.historyId
      }))
    return [...taskTabs, ...liveManual, ...closedManual].sort(
      (a, b) => b.updatedAt - a.updatedAt || b.taskId.localeCompare(a.taskId)
    )
  }, [browserState, manualHistory, persistedTasks])
}
