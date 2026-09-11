/**
 * The turn currently being generated: mutable state, held outside the component tree.
 *
 * Every token used to go through the chat root - `setConvMessages(cid, prev => prev.map(...))` -
 * which rebuilt the whole conversation array and re-rendered a component that also owns
 * conversations, projects, the composer, image generation and the settings panels. Hundreds of
 * times per answer. The rows themselves kept their identity; nothing else did.
 *
 * A live turn is state here instead: one mutable draft per stream, published as an immutable
 * projection at most once per animation frame. Only the leaf subscribed to that stream re-renders
 * on a token. Terminal, tool and routing events do NOT wait for the frame - they publish at once,
 * because they change what the user is being told is happening rather than how much text has
 * arrived.
 *
 * The final answer never comes from here: the send path takes authoritative content from the
 * generation result. `finish` exists for what only the stream saw - the tool calls and the live
 * activity accumulated along the way.
 */
import { applyStreamEvent, type StreamEvent } from './stream-reducer'
import type { ChatMessage } from './chat-transcript-types'

export type ActiveTurnTools = NonNullable<ChatMessage['toolCalls']>

/**
 * What a subscribed leaf renders. Identity changes only when a publication happens.
 *
 * Declared in the transcript's own field types, so merging a live turn onto its row is a plain
 * spread rather than the cast the old per-token updater needed.
 */
export interface ActiveTurn {
  readonly content: string
  readonly reasoning: string
  readonly toolCalls: ActiveTurnTools
  readonly activity: ChatMessage['activity']
}

/** The read side. This is all a rendering leaf is given: read one turn, hear about one turn. */
export interface ActiveTurnProjection {
  /** The published projection for one turn, or null when no turn is open for it. */
  snapshot(streamId: string): ActiveTurn | null
  /** Wake one leaf when its own turn publishes. */
  subscribe(streamId: string, listener: () => void): () => void
  /** Called once per publication, for effects that follow the stream (scrolling, not rendering). */
  subscribeAll(listener: () => void): () => void
}

export interface ActiveTurnStore extends ActiveTurnProjection {
  /** Open a turn, optionally seeded from a stream that was already running. */
  begin(streamId: string, seed?: Partial<ActiveTurn>): void
  /** Fold one stream event in. Coalesced unless the event type has to be seen at once. */
  apply(streamId: string, event: StreamEvent): void
  /** Take what only the stream saw and close the turn. Any pending publication is dropped. */
  finish(streamId: string): ActiveTurn | null
  /** Close the turn and discard it: a stop, an error, or a turn whose content was replaced. */
  cancel(streamId: string): void
  /** Drop every turn and any scheduled publication. For the owner's own teardown. */
  dispose(): void
  /** The narrow read side, with a stable identity, to hand to the view. */
  projection(): ActiveTurnProjection
}

const EMPTY_TOOLS: ActiveTurnTools = []

const emptyTurn = (): ActiveTurn => ({
  content: '',
  reasoning: '',
  toolCalls: EMPTY_TOOLS,
  activity: undefined
})

/**
 * Which events cannot wait for the next frame.
 *
 * A token is just more of the same text, so a frame's worth of them can land as one update. A tool
 * starting, a tool finishing, a route change, a fallback, an end of turn: each changes what the
 * user is being TOLD, and holding one of those for up to a frame is how an interface comes to look
 * like it reacted late.
 */
function mustPublishImmediately(event: StreamEvent): boolean {
  return event.type !== 'content' && event.type !== 'reasoning'
}

interface TurnEntry {
  draft: ActiveTurn
  published: ActiveTurn
  dirty: boolean
  readonly listeners: Set<() => void>
}

/**
 * How a publication is deferred to the next paint.
 *
 * Resolved from `globalThis` at call time and falling back to a timer, because this module is
 * imported by the chat session, which is also constructed outside a browser (a Node test run, a
 * headless harness) where there is no animation frame to wait for. A missing global must not be a
 * crash, and a fixed ~60 Hz timer is the same bound by another name.
 */
const FRAME_MS = 16

function defaultScheduleFrame(callback: () => void): number {
  return typeof globalThis.requestAnimationFrame === 'function'
    ? globalThis.requestAnimationFrame(callback)
    : (setTimeout(callback, FRAME_MS) as unknown as number)
}

function defaultCancelFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(handle)
  else clearTimeout(handle as unknown as NodeJS.Timeout)
}

export function createActiveTurnStore(
  scheduleFrame: (callback: () => void) => number = defaultScheduleFrame,
  cancelFrame: (handle: number) => void = defaultCancelFrame
): ActiveTurnStore {
  const turns = new Map<string, TurnEntry>()
  const allListeners = new Set<() => void>()
  let frame: number | null = null

  const publish = (): void => {
    frame = null
    let published = false
    for (const entry of turns.values()) {
      if (!entry.dirty) continue
      entry.dirty = false
      entry.published = entry.draft
      published = true
      for (const listener of entry.listeners) listener()
    }
    if (published) for (const listener of allListeners) listener()
  }

  const publishNow = (): void => {
    if (frame !== null) {
      cancelFrame(frame)
      frame = null
    }
    publish()
  }

  const schedule = (): void => {
    if (frame === null) frame = scheduleFrame(publish)
  }

  const open = (streamId: string, seed?: Partial<ActiveTurn>): TurnEntry => {
    const initial: ActiveTurn = { ...emptyTurn(), ...seed }
    const existing = turns.get(streamId)
    if (existing) {
      existing.draft = initial
      existing.published = initial
      existing.dirty = false
      for (const listener of existing.listeners) listener()
      return existing
    }
    const entry: TurnEntry = {
      draft: initial,
      published: initial,
      dirty: false,
      listeners: new Set()
    }
    turns.set(streamId, entry)
    return entry
  }

  const close = (streamId: string): ActiveTurn | null => {
    const entry = turns.get(streamId)
    if (!entry) return null
    turns.delete(streamId)
    // The entry's pending draft goes with it, and so does its listener set: a cancelled turn
    // publishes nothing further. The one notification tells its leaf to fall back to the row the
    // transcript committed.
    for (const listener of entry.listeners) listener()
    return entry.draft
  }

  const store: ActiveTurnStore = {
    begin(streamId, seed): void {
      open(streamId, seed)
    },
    apply(streamId, event): void {
      const entry = turns.get(streamId)
      if (!entry) return
      // The same pure reducer the transcript used, so a live turn and a reloaded turn cannot
      // drift apart.
      entry.draft = applyStreamEvent(entry.draft, event)
      entry.dirty = true
      if (mustPublishImmediately(event)) publishNow()
      else schedule()
    },
    snapshot(streamId): ActiveTurn | null {
      return turns.get(streamId)?.published ?? null
    },
    subscribe(streamId, listener): () => void {
      // A leaf can mount before the first event arrives, so the entry is opened here rather than
      // leaving the subscription and the projection on two lifecycles.
      const entry = turns.get(streamId) ?? open(streamId)
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
    subscribeAll(listener): () => void {
      allListeners.add(listener)
      return () => {
        allListeners.delete(listener)
      }
    },
    finish(streamId): ActiveTurn | null {
      return close(streamId)
    },
    cancel(streamId): void {
      close(streamId)
    },
    dispose(): void {
      if (frame !== null) {
        cancelFrame(frame)
        frame = null
      }
      for (const streamId of [...turns.keys()]) close(streamId)
      allListeners.clear()
    },
    projection(): ActiveTurnProjection {
      return projection
    }
  }

  /** Stable identity: a context value that changed every render would defeat the whole point. */
  const projection: ActiveTurnProjection = {
    snapshot: (streamId) => store.snapshot(streamId),
    subscribe: (streamId, listener) => store.subscribe(streamId, listener),
    subscribeAll: (listener) => store.subscribeAll(listener)
  }

  return store
}

/** A projection with nothing live in it: every row it serves is a committed row. */
export const NO_ACTIVE_TURNS: ActiveTurnProjection = {
  snapshot: () => null,
  subscribe: () => () => {},
  subscribeAll: () => () => {}
}
