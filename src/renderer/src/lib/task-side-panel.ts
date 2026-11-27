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
  // Opening Tasks shows what ended; closing it covers what ended while it was open.
  markTasksSeen()
  for (const listener of workspaceListeners) listener()
}

// ─── When the person last looked at their tasks ──────────────────────────────

const SEEN_KEY = 'offgrid:tasks:seen-at'
const seenListeners = new Set<() => void>()
let seenAt: number | null = null

function readSeenAt(): number {
  if (seenAt !== null) return seenAt
  try {
    seenAt = Number(window.localStorage.getItem(SEEN_KEY)) || 0
  } catch {
    seenAt = 0
  }
  return seenAt
}

/** The person has looked at their tasks now: what ended before this stops asking for attention. */
export function markTasksSeen(at = Date.now()): void {
  seenAt = at
  try {
    window.localStorage.setItem(SEEN_KEY, String(at))
  } catch {
    // Still seen for this session.
  }
  for (const listener of seenListeners) listener()
}

/** When the person last opened Tasks (0 = never). */
export function useTasksSeenAt(): number {
  return useSyncExternalStore(
    (listener) => {
      seenListeners.add(listener)
      return () => seenListeners.delete(listener)
    },
    readSeenAt,
    () => 0
  )
}

/** A request made while no task workspace was on screen, kept for the one that mounts next. */
let pendingRequest: OpenTaskPanelRequest | null = null

/**
 * Open the task workspace on a task. route: also go to the Tasks screen, for a caller outside any
 * workspace (the floating task card): its only listeners live inside a workspace, so the click did
 * nothing on every other screen (25 Nov). The Tasks screen picks the request up as it mounts.
 */
export function openTaskSidePanel(request: OpenTaskPanelRequest = {}, options: { route?: boolean } = {}): void {
  setTaskWorkspaceOpen(true)
  if (options.route) {
    pendingRequest = request
    window.dispatchEvent(new CustomEvent('og:navigate', { detail: 'tasks' }))
  }
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
  if (pendingRequest) {
    const request = pendingRequest
    pendingRequest = null
    queueMicrotask(() => listener(request))
  }
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
