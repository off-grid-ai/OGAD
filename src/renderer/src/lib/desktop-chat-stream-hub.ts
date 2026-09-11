import type {
  DesktopChatSessionBoundary,
  DesktopChatStreamEvent
} from './desktop-chat-session-contract'

interface StreamHub {
  listeners: Set<(event: DesktopChatStreamEvent) => void>
  stop?: () => void
}

const STREAM_HUBS = new WeakMap<object, StreamHub>()

/** One IPC subscription fans out to the shared session and the renderer projection. */
export function subscribeDesktopChatStream(
  boundary: DesktopChatSessionBoundary,
  listener: (event: DesktopChatStreamEvent) => void
): () => void {
  let hub = STREAM_HUBS.get(boundary)
  if (!hub) {
    hub = { listeners: new Set() }
    STREAM_HUBS.set(boundary, hub)
  }
  hub.listeners.add(listener)
  if (!hub.stop) {
    hub.stop = boundary.onRagStream((event) => {
      for (const subscriber of hub!.listeners) subscriber(event)
    })
  }
  return () => {
    hub!.listeners.delete(listener)
    if (hub!.listeners.size === 0) {
      hub!.stop?.()
      STREAM_HUBS.delete(boundary)
    }
  }
}
