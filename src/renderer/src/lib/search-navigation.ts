import type { SearchHit } from '../types'

export interface SearchNavigationPorts {
  selectEntity(entityId: number): void
  openMeeting(meetingId: number | null): void
  openChat(target: { conversationId?: string; projectId?: string } | null): void
  openReplay(timestamp: number): void
  /** A to-do opens on the Actions screen, focused on it (Pro). Without it a to-do opens nothing. */
  openAction?(actionId: number): void
  /** A synced email or chat opens where it lives (its link), when it has one. */
  openLink?(url: string): void
}

/** Translate the universal-search contract into renderer navigation commands.
 *
 * This is the only place that knows which destination owns each search kind.
 * The app shell supplies state-changing ports without branching on result kinds.
 */
export function navigateSearchHit(
  hit: SearchHit,
  ports: SearchNavigationPorts,
  now = Date.now()
): void {
  // A source saved before the legacy stores were retired may still say 'fact' (its refId is the
  // entity it is about) or 'memory' (nothing shows those any more, so it opens nothing).
  const kind: string = hit.kind
  if (kind === 'entity' || kind === 'fact') {
    ports.selectEntity(hit.refId)
    return
  }
  if (kind === 'memory') return
  if (hit.kind === 'meeting') {
    ports.openMeeting(hit.refId || null)
    return
  }
  if (hit.kind === 'action') {
    if (hit.refId) ports.openAction?.(hit.refId)
    return
  }
  // A chat, or a chat summary: the conversation it belongs to.
  if (hit.kind === 'chat' || hit.kind === 'summary') {
    ports.openChat(hit.url ? { conversationId: hit.url } : null)
    return
  }
  if (hit.kind === 'doc') {
    ports.openChat(hit.url ? { projectId: hit.url } : null)
    return
  }
  if (hit.kind === 'message' && hit.url && ports.openLink) {
    ports.openLink(hit.url)
    return
  }
  ports.openReplay(hit.ts || now)
}
