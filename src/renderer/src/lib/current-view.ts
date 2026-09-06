import { useSyncExternalStore } from 'react'

/**
 * Which screen the user is on.
 *
 * Exists because the view is otherwise unobservable: the URL mirrors it, but it is written with
 * history.replaceState, which fires no event, so window.location.pathname never triggers a
 * re-render. App pushes here; anything that needs to reason about the current screen subscribes.
 *
 * Deliberately just the view. A "go to this task's chat" control also has a conversation in its
 * destination, but the docked workspace filters its tasks to its own conversation
 * (taskSessionsForJourney), so a task from another chat cannot appear while that chat is on
 * screen — the view alone is sufficient BECAUSE of that filter. If the filter goes, this needs the
 * conversation too.
 */

/**
 * The chat screen's view id, exported because other surfaces have to ASK whether we are on it and
 * the id is not guessable: the route is `/chat` but the view is `memory-chat`. A hand-written
 * 'chat' in a comparison silently never matches, which is exactly how the task chat control kept
 * appearing on the chat screen it was meant to hide from.
 */
export const CHAT_VIEW = 'memory-chat'

let currentView = ''
const listeners = new Set<() => void>()

export function setCurrentView(view: string): void {
  if (currentView === view) return
  currentView = view
  for (const listener of listeners) listener()
}

export function getCurrentView(): string {
  return currentView
}

export function useCurrentView(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getCurrentView,
    getCurrentView
  )
}
