import { useSyncExternalStore } from 'react'

/**
 * In-app replacement for window.confirm / window.alert. On Windows, Chromium's native dialogs
 * leave text inputs unable to take keyboard focus after they close, until the window is
 * refocused. Callers await an answer; ConfirmDialogHost, mounted once per window, renders it.
 */

export interface ConfirmDialogOptions {
  readonly title: string
  readonly description?: string
  readonly confirmLabel?: string
  readonly destructive?: boolean
}

export interface NoticeDialogOptions {
  readonly title: string
  readonly description?: string
}

export interface ConfirmDialogRequest {
  readonly title: string
  readonly description?: string
  readonly confirmLabel: string
  /** Null makes a notice: one button, nothing to decline. */
  readonly cancelLabel: string | null
  readonly destructive: boolean
  readonly resolve: (confirmed: boolean) => void
}

export interface ConfirmDialogState {
  /** Requests waiting to be answered; the first is on screen. */
  readonly queue: readonly ConfirmDialogRequest[]
  /** The request last on screen, kept after it settles so the popup can animate out with its text. */
  readonly shown?: ConfirmDialogRequest
}

const CONFIRM_LABEL = 'Confirm'
const CANCEL_LABEL = 'Cancel'
const NOTICE_LABEL = 'OK'

let state: ConfirmDialogState = { queue: [] }
const listeners = new Set<() => void>()

function setState(next: ConfirmDialogState): void {
  state = next
  for (const listener of listeners) listener()
}

function isSameRequest(
  a: Omit<ConfirmDialogRequest, 'resolve'>,
  b: Omit<ConfirmDialogRequest, 'resolve'>
): boolean {
  return a.title === b.title && a.description === b.description && a.confirmLabel === b.confirmLabel
}

// A native confirm blocked the page, so a double click could never ask twice. Here it could, and
// confirming both would run the action twice, so a request already waiting is answered no.
function enqueue(options: Omit<ConfirmDialogRequest, 'resolve'>): Promise<boolean> {
  if (state.queue.some((queued) => isSameRequest(queued, options))) return Promise.resolve(false)
  return new Promise((resolve) => {
    const queued = { ...options, resolve }
    const queue = [...state.queue, queued]
    setState({ queue, shown: queue[0] })
  })
}

/** Ask before an action. Resolves true only when the person confirms. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return enqueue({
    title: options.title,
    description: options.description,
    confirmLabel: options.confirmLabel ?? CONFIRM_LABEL,
    cancelLabel: CANCEL_LABEL,
    destructive: options.destructive ?? false
  })
}

/** Tell the person something went wrong. Resolves once they dismiss it. */
export async function noticeDialog(options: NoticeDialogOptions): Promise<void> {
  await enqueue({
    title: options.title,
    description: options.description,
    confirmLabel: NOTICE_LABEL,
    cancelLabel: null,
    destructive: false
  })
}

/** Answer the request on screen. A stale request (already answered) is ignored. */
export function settleConfirmDialog(settled: ConfirmDialogRequest, confirmed: boolean): void {
  if (state.queue[0] !== settled) return
  const queue = state.queue.slice(1)
  setState({ queue, shown: queue[0] ?? settled })
  settled.resolve(confirmed)
}

function getState(): ConfirmDialogState {
  return state
}

export function useConfirmDialogState(): ConfirmDialogState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getState,
    getState
  )
}
