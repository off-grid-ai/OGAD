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
  /** What toggleConversations would do next: true means it will SHOW the list.
   * One source for the toggle button's label, defined by the same rule the
   * toggle itself applies. */
  conversationsToggleWillShow: boolean
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
  const layoutFrameRef = useRef<number | null>(null)
  const historyFrameRef = useRef<number | null>(null)
  // The latest task size, readable by the layout effect without re-running it
  // on every drag frame (the drag already put the panel at that size).
  const taskSizeRef = useRef(DEFAULT_TASK_SIZE)

  // Chat / task layout: re-applied only when collapse or visibility CHANGES.
  // The stored size is used when re-expanding, never re-applied per drag frame.
  useEffect(() => {
    if (layoutFrameRef.current !== null) cancelAnimationFrame(layoutFrameRef.current)
    layoutFrameRef.current = requestAnimationFrame(() => {
      layoutFrameRef.current = null
      try {
        if (!taskWorkspaceVisible) {
          taskWorkspaceRef.current?.collapse()
          chatBodyRef.current?.resize(100)
        } else if (panes.chatCollapsed) {
          chatBodyRef.current?.resize(0)
          taskWorkspaceRef.current?.resize(100)
        } else {
          chatBodyRef.current?.resize(100 - taskSizeRef.current)
          taskWorkspaceRef.current?.resize(taskSizeRef.current)
        }
      } catch {
        // The next measured frame applies the same authoritative state.
      }
    })
    return () => {
      if (layoutFrameRef.current !== null) cancelAnimationFrame(layoutFrameRef.current)
    }
  }, [panes.chatCollapsed, taskWorkspaceVisible])

  // Conversation list: expand/collapse only when its own visibility changes.
  useEffect(() => {
    if (historyFrameRef.current !== null) cancelAnimationFrame(historyFrameRef.current)
    historyFrameRef.current = requestAnimationFrame(() => {
      historyFrameRef.current = null
      try {
        if (panes.conversationsVisible) historyPanelRef.current?.expand()
        else historyPanelRef.current?.collapse()
      } catch {
        // The next measured frame applies the same authoritative state.
      }
    })
    return () => {
      if (historyFrameRef.current !== null) cancelAnimationFrame(historyFrameRef.current)
    }
  }, [panes.conversationsVisible])

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
    // The panel is already at this size (it reported it) - store it for the next
    // re-expand, never resize back at it per drag frame.
    taskSizeRef.current = size
    setTaskWorkspaceSize((current) => (current === size ? current : size))
  }, [])

  const resizeTaskFromKeyboard = useCallback(
    (key: string): void => {
      if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
      const next = Math.min(
        MAX_TASK_SIZE,
        Math.max(
          MIN_TASK_SIZE,
          taskSizeRef.current + (key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP)
        )
      )
      taskSizeRef.current = next
      setTaskWorkspaceSize(next)
      // Keyboard is the one size change the panel did not make itself - apply it,
      // but only in the side-by-side layout (collapsed layouts pin 0/100).
      if (taskWorkspaceVisible && !panes.chatCollapsed) {
        try {
          chatBodyRef.current?.resize(100 - next)
          taskWorkspaceRef.current?.resize(next)
        } catch {
          // The next measured frame applies the same authoritative state.
        }
      }
    },
    [panes.chatCollapsed, taskWorkspaceVisible]
  )

  return {
    chatBodyRef,
    historyPanelRef,
    taskWorkspaceRef,
    chatCollapsed: panes.chatCollapsed,
    conversationsVisible: panes.conversationsVisible,
    conversationsToggleWillShow: panes.chatCollapsed || !panes.conversationsVisible,
    taskWorkspaceSize,
    toggleChat,
    toggleConversations,
    setChatCollapsed,
    setConversationsVisible,
    reportTaskSize,
    resizeTaskFromKeyboard
  }
}
