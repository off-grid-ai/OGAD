/**
 * How a rendering leaf reaches the live turn.
 *
 * The chat session owns the buffer; the view is handed only its read side, through this context.
 * The default is a projection with nothing live in it, so a row mounted outside a chat - a test, a
 * preview - is simply a committed row rather than a special case.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import {
  NO_ACTIVE_TURNS,
  type ActiveTurn,
  type ActiveTurnProjection
} from '@renderer/lib/active-turn-store'

export const ActiveTurnContext = createContext<ActiveTurnProjection>(NO_ACTIVE_TURNS)

/**
 * Subscribe one leaf to one live turn.
 *
 * `streamId` is null for every committed row, so a committed row subscribes to nothing and
 * re-renders for nothing. The generating row is woken only when its turn publishes: at most once
 * per animation frame for tokens, immediately for anything terminal.
 */
export function useActiveTurn(streamId: string | null): ActiveTurn | null {
  const turns = useContext(ActiveTurnContext)
  const subscribe = useCallback(
    (listener: () => void): (() => void) =>
      streamId ? turns.subscribe(streamId, listener) : (): void => {},
    [streamId, turns]
  )
  const snapshot = useCallback(
    (): ActiveTurn | null => (streamId ? turns.snapshot(streamId) : null),
    [streamId, turns]
  )
  return useSyncExternalStore(subscribe, snapshot)
}

/** Run an effect on every publication, without turning the stream into a render. */
export function useActiveTurnProjection(): ActiveTurnProjection {
  return useContext(ActiveTurnContext)
}
