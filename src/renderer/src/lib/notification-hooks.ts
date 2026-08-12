import type { NotificationInput } from '../hooks/notification-state'

export const NOTIFICATION_METADATA_HOOK = 'notifications:metadata'
export const NOTIFICATION_RESOLVE_TARGET_HOOK = 'notifications:resolve-target'
export const NOTIFICATION_SUBSCRIBE_EXTERNAL_UNREAD_HOOK = 'notifications:subscribe-external-unread'
export const NOTIFICATION_SUBSCRIBE_EXTERNAL_ITEMS_HOOK = 'notifications:subscribe-external-items'
export const NOTIFICATION_OPEN_TARGET_CHANNEL = 'notification:open-target'

export interface NotificationSourceRecord {
  source: 'approval' | 'action'
  recordId: number
}

export interface NotificationRoutingMetadata {
  dedupeKey: string
  target: unknown
}

export type NotificationExternalUnreadSubscriber = (
  onCountChanged: (count: number) => void
) => () => void

export type NotificationExternalItemSubscriber = (
  onItem: (item: NotificationInput) => void
) => () => void
