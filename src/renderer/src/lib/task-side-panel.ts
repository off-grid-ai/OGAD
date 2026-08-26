import { useSyncExternalStore } from 'react'

export type TaskPanelKind = 'web_use' | 'computer_use'
export type LegacyTaskPanelKind = TaskPanelKind | 'web_task' | 'computer_task'

export interface OpenTaskPanelRequest {
  taskId?: string
  kind?: LegacyTaskPanelKind
  detail?: boolean
  immersive?: boolean
}

type Listener = (request: OpenTaskPanelRequest) => void

const listeners = new Set<Listener>()
const workspaceListeners = new Set<() => void>()
let workspaceOpen = false

function setTaskWorkspaceOpen(open: boolean): void {
  if (workspaceOpen === open) return
  workspaceOpen = open
  for (const listener of workspaceListeners) listener()
}

export function openTaskSidePanel(request: OpenTaskPanelRequest = {}): void {
  const normalized: OpenTaskPanelRequest = {
    ...request,
    ...(request.kind
      ? {
          kind:
            request.kind === 'web_task'
              ? 'web_use'
              : request.kind === 'computer_task'
                ? 'computer_use'
                : request.kind
        }
      : {})
  }
  setTaskWorkspaceOpen(true)
  for (const listener of listeners) {
    listener(normalized)
  }
}

export function closeTaskWorkspace(): void {
  setTaskWorkspaceOpen(false)
}

export function showTaskWorkspace(): void {
  setTaskWorkspaceOpen(true)
}

export function useTaskWorkspaceOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      workspaceListeners.add(listener)
      return () => workspaceListeners.delete(listener)
    },
    () => workspaceOpen,
    () => false
  )
}

export function onOpenTaskSidePanel(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
