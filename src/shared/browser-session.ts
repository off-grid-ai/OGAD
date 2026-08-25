export type BrowserSessionKind = 'manual' | 'task'
export type BrowserControl = 'back' | 'forward' | 'reload' | 'stop'

export interface BrowserChromeState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

export interface BrowserTaskPointer {
  taskId: string
  goal: string
  status: 'running' | 'done' | 'failed'
  summary?: string
  steps: string[]
}

export interface BrowserSessionSnapshot extends BrowserChromeState {
  sessionId: string
  historyId?: string
  kind: BrowserSessionKind
  taskId?: string
  status: BrowserTaskPointer['status'] | 'open'
}

export interface BrowserSessionsSnapshot {
  activeSessionId: string | null
  sessions: BrowserSessionSnapshot[]
}

export interface BrowserNavigationState extends BrowserChromeState {
  sessionId: string
}

export interface BrowserPointerEvent {
  sessionId: string
  phase: 'moved' | 'pressed' | 'released'
  x: number
  y: number
}

export interface ManualBrowserHistoryEntry {
  historyId: string
  kind: 'manual'
  status: 'closed'
  title: string
  url: string
  updatedAt: number
}
