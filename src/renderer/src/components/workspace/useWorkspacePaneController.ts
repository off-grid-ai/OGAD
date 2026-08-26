import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { ImperativePanelHandle } from 'react-resizable-panels'

const DEFAULT_TASK_SIZE = 48
const MIN_TASK_SIZE = 32
const MAX_TASK_SIZE = 68
const KEYBOARD_RESIZE_STEP = 5

interface WorkspacePaneState {
  chatCollapsed: boolean
  conversationsVisible: boolean
}

/** One state owner for the Chat, conversation-list, and Task workspace panels.
 * Imperative panel handles only render this state; they never decide it. */
export function useWorkspacePaneController(taskWorkspaceVisible: boolean): {
  chatBodyRef: RefObject<ImperativePanelHandle | null>
  historyPanelRef: RefObject<ImperativePanelHandle | null>
  taskWorkspaceRef: RefObject<ImperativePanelHandle | null>
  chatCollapsed: boolean
  conversationsVisible: boolean
  taskWorkspaceSize: number
  toggleChat: () => void
  toggleConversations: () => void
  setChatCollapsed: (collapsed: boolean) => void
  setConversationsVisible: (visible: boolean) => void
  reportTaskSize: (size: number) => void
  resizeTaskFromKeyboard: (key: string) => void
} {
  const [panes, setPanes] = useState<WorkspacePaneState>({
    chatCollapsed: false,
    conversationsVisible: true
  })
  const [taskWorkspaceSize, setTaskWorkspaceSize] = useState(DEFAULT_TASK_SIZE)
  const chatBodyRef = useRef<ImperativePanelHandle>(null)
  const historyPanelRef = useRef<ImperativePanelHandle>(null)
  const taskWorkspaceRef = useRef<ImperativePanelHandle>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      try {
        if (!taskWorkspaceVisible) {
          taskWorkspaceRef.current?.collapse()
          chatBodyRef.current?.resize(100)
        } else if (panes.chatCollapsed) {
          chatBodyRef.current?.resize(0)
          taskWorkspaceRef.current?.resize(100)
        } else {
          chatBodyRef.current?.resize(100 - taskWorkspaceSize)
          taskWorkspaceRef.current?.resize(taskWorkspaceSize)
        }
        if (panes.conversationsVisible) historyPanelRef.current?.expand()
        else historyPanelRef.current?.collapse()
      } catch {
        // The next measured frame applies the same authoritative state.
      }
    })
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [panes.chatCollapsed, panes.conversationsVisible, taskWorkspaceSize, taskWorkspaceVisible])

  const setChatCollapsed = useCallback((collapsed: boolean): void => {
    setPanes((current) =>
      current.chatCollapsed === collapsed ? current : { ...current, chatCollapsed: collapsed }
    )
  }, [])

  const toggleChat = useCallback((): void => {
    setPanes((current) => ({ ...current, chatCollapsed: !current.chatCollapsed }))
  }, [])

  const toggleConversations = useCallback((): void => {
    setPanes((current) => {
      const conversationsVisible = current.chatCollapsed || !current.conversationsVisible
      return {
        chatCollapsed: conversationsVisible ? false : current.chatCollapsed,
        conversationsVisible
      }
    })
  }, [])

  const setConversationsVisible = useCallback((conversationsVisible: boolean): void => {
    setPanes((current) =>
      current.conversationsVisible === conversationsVisible
        ? current
        : { ...current, conversationsVisible }
    )
  }, [])

  const reportTaskSize = useCallback((size: number): void => {
    if (size < MIN_TASK_SIZE || size > MAX_TASK_SIZE) return
    setTaskWorkspaceSize((current) => (current === size ? current : size))
  }, [])

  const resizeTaskFromKeyboard = useCallback((key: string): void => {
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    setTaskWorkspaceSize((current) =>
      Math.min(
        MAX_TASK_SIZE,
        Math.max(
          MIN_TASK_SIZE,
          current + (key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP)
        )
      )
    )
  }, [])

  return {
    chatBodyRef,
    historyPanelRef,
    taskWorkspaceRef,
    chatCollapsed: panes.chatCollapsed,
    conversationsVisible: panes.conversationsVisible,
    taskWorkspaceSize,
    toggleChat,
    toggleConversations,
    setChatCollapsed,
    setConversationsVisible,
    reportTaskSize,
    resizeTaskFromKeyboard
  }
}
