/**
 * Core contract for Pro sync state that is drawn inside a core chat row.
 *
 * Pro owns the IPC channel and registers the subscriber through the renderer hook registry. Core
 * knows only this device-local projection, so the free preload has no feature-specific Pro method.
 */
export const SYNC_SUBSCRIBE_INCOMING_FILES_HOOK = 'sync:subscribe-incoming-files'

export interface IncomingSharedFile {
  syncId: string
  name: string
  fileSize: number
  mimeType: string
  kind: string
  conversationId?: string
  messageId?: string
}

export type IncomingSharedFilesSubscriber = (
  onFilesChanged: (files: IncomingSharedFile[]) => void
) => () => void
