import { useSyncExternalStore } from 'react'

export type TaskPanelKind = 'web_use' | 'computer_use'

export interface OpenTaskPanelRequest {
  taskId?: string
  kind?: TaskPanelKind
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
  setTaskWorkspaceOpen(true)
  for (const listener of listeners) {
    listener(request)
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

const presenceListeners = new Set<() => void>()
let dockedSurfaces = 0

/**
 * Declare that a DOCKED task surface is on screen right now, painting the live page.
 *
 * A separate question from `useTaskWorkspaceOpen`, which records the user's INTENT to have the
 * workspace open and stays true across navigation. The docked surface is route-scoped, so leaving
 * the chat unmounts it while that flag still reads open - which is why the floating card, gated on
 * intent, stayed hidden exactly when it was wanted.
 *
 * Only the surface itself can answer "am I painting", so it registers while mounted and the count
 * is the single source of truth. A count rather than a boolean because two workspaces exist (the
 * chat panel and the Tasks route) and they can hand over in either order.
 */
export function registerDockedTaskSurface(): () => void {
  dockedSurfaces += 1
  for (const listener of presenceListeners) listener()
  return () => {
    dockedSurfaces -= 1
    for (const listener of presenceListeners) listener()
  }
}

export function useDockedTaskSurfaceVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      presenceListeners.add(listener)
      return () => presenceListeners.delete(listener)
    },
    () => dockedSurfaces > 0,
    () => false
  )
}
