import { useEffect, useRef, useState } from 'react'
import {
  onOpenTaskSidePanel,
  showTaskWorkspace,
  type OpenTaskPanelRequest
} from '@renderer/lib/task-side-panel'
import type { BrowserSessionsSnapshot } from '../../../../../shared/browser-session'
import type { TaskTab } from './task-types'

interface TaskSelection {
  activeId: string | null
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>
  hiddenIds: Set<string>
  setHiddenIds: React.Dispatch<React.SetStateAction<Set<string>>>
  detailTaskId: string | null
  immersiveTaskId: string | null
  setDetailTaskId: React.Dispatch<React.SetStateAction<string | null>>
}

const TERMINAL_TASK_STATUSES = new Set<TaskTab['status']>(['done', 'failed', 'stopped'])

function requestedTab(tabs: TaskTab[], request: OpenTaskPanelRequest): TaskTab | undefined {
  if (request.taskId) return tabs.find((tab) => tab.taskId === request.taskId)
  return (
    (request.kind ? [...tabs].reverse().find((tab) => tab.kind === request.kind) : undefined) ??
    tabs[0]
  )
}

export function useTaskSelection(
  tabs: TaskTab[],
  browserState: BrowserSessionsSnapshot,
  lastChangedTaskId: string | null | undefined
): TaskSelection {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const [immersiveTaskId, setImmersiveTaskId] = useState<string | null>(null)
  const tabsRef = useRef(tabs)
  const hiddenIdsRef = useRef(hiddenIds)
  const pendingDetailRequestRef = useRef<OpenTaskPanelRequest | null>(null)
  const previousStatusByTaskRef = useRef(new Map<string, TaskTab['status']>())

  useEffect(() => {
    tabsRef.current = tabs
    const pending = pendingDetailRequestRef.current
    if (!pending) return
    const requested = requestedTab(tabs, pending)
    if (!requested) return
    pendingDetailRequestRef.current = null
    queueMicrotask(() => {
      setHiddenIds((current) => {
        const next = new Set(current)
        next.delete(requested.taskId)
        return next
      })
      setActiveId(requested.taskId)
      setDetailTaskId(requested.taskId)
      showTaskWorkspace()
    })
  }, [tabs])
  useEffect(() => {
    hiddenIdsRef.current = hiddenIds
  }, [hiddenIds])
  useEffect(
    () =>
      onOpenTaskSidePanel((request) => {
        const currentTabs = tabsRef.current
        if (!request.taskId && !request.kind) {
          pendingDetailRequestRef.current = null
          setHiddenIds(new Set())
          setDetailTaskId(null)
          setImmersiveTaskId(null)
          if (currentTabs[0]) setActiveId(currentTabs[0].taskId)
          showTaskWorkspace()
          return
        }
        const requested = requestedTab(currentTabs, request)
        if (requested) {
          pendingDetailRequestRef.current = null
          setHiddenIds((current) => {
            const next = new Set(current)
            next.delete(requested.taskId)
            return next
          })
          setActiveId(requested.taskId)
          setDetailTaskId(request.detail ? requested.taskId : null)
          setImmersiveTaskId(null)
          showTaskWorkspace()
          return
        }
        pendingDetailRequestRef.current = request.detail ? request : null
        if (request.kind === 'web_use') {
          showTaskWorkspace()
          if (request.taskId) void window.api.browser?.reopen(request.taskId)
        }
      }),
    []
  )

  useEffect(() => {
    const selected = browserState.sessions.find(
      (session) => session.sessionId === browserState.activeSessionId
    )
    if (!selected) return
    queueMicrotask(() =>
      setActiveId(
        selected.kind === 'manual' && selected.historyId
          ? `manual:${selected.historyId}`
          : (selected.taskId ?? null)
      )
    )
  }, [browserState])

  useEffect(() => {
    if (!lastChangedTaskId) return
    const changed = tabs.find((tab) => tab.taskId === lastChangedTaskId)
    if (!changed) return
    const previousStatus = previousStatusByTaskRef.current.get(changed.taskId)
    previousStatusByTaskRef.current.set(changed.taskId, changed.status)
    const startsWebAttempt =
      changed.kind === 'web_use' &&
      changed.status === 'running' &&
      (previousStatus === undefined || TERMINAL_TASK_STATUSES.has(previousStatus))
    const firstWebAttentionState =
      changed.kind === 'web_use' && previousStatus === undefined && changed.status !== 'done'

    // One running Web Use attempt gets one automatic detail reveal. Later
    // progress updates must not take focus back after the user closes details.
    if (changed.kind === 'web_use' && !startsWebAttempt && !firstWebAttentionState) return
    if (
      !startsWebAttempt &&
      (changed.status === 'done' || hiddenIdsRef.current.has(lastChangedTaskId))
    )
      return
    queueMicrotask(() => {
      if (startsWebAttempt) {
        setHiddenIds((current) => {
          const next = new Set(current)
          next.delete(changed.taskId)
          return next
        })
        setDetailTaskId(changed.taskId)
        setImmersiveTaskId(changed.taskId)
      }
      setActiveId(changed.taskId)
      showTaskWorkspace()
    })
  }, [lastChangedTaskId, tabs])

  useEffect(() => {
    if (detailTaskId === null) setImmersiveTaskId(null)
  }, [detailTaskId])

  return {
    activeId,
    setActiveId,
    hiddenIds,
    setHiddenIds,
    detailTaskId,
    immersiveTaskId,
    setDetailTaskId
  }
}
