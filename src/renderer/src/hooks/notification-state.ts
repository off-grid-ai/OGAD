export interface Notification {
  id: string
  type: 'approval' | 'todo' | 'info'
  title: string
  message: string
  timestamp: Date
  read: boolean
  approvalId?: number
  actionId?: number
  /** Stable identity supplied by the owning domain; equal keys replace instead of duplicate. */
  dedupeKey?: string
  /** Opaque domain payload. Core persists it; the owning feature validates and resolves it. */
  target?: unknown
}

export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'>

export const NOTIFICATION_STORAGE_KEY = 'my-memories-notifications'
const MAX_NOTIFICATIONS = 50

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function parseStoredNotification(value: unknown): Notification | null {
  if (!isRecord(value)) return null
  if (value.type !== 'approval' && value.type !== 'todo' && value.type !== 'info') return null
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.message !== 'string'
  ) {
    return null
  }
  const timestamp = new Date(value.timestamp as string | number | Date)
  if (Number.isNaN(timestamp.getTime())) return null
  const dedupeKey = typeof value.dedupeKey === 'string' ? value.dedupeKey.trim() : ''
  return {
    ...(value as unknown as Notification),
    ...(dedupeKey ? { dedupeKey } : {}),
    timestamp,
    read: value.read === true
  }
}

export function restoreNotifications(value: unknown): Notification[] {
  if (!Array.isArray(value)) return []
  const seenKeys = new Set<string>()
  const restored: Notification[] = []
  for (const valueItem of value) {
    const item = parseStoredNotification(valueItem)
    if (!item) continue
    if (item.type === 'todo') continue
    if (item.dedupeKey && seenKeys.has(item.dedupeKey)) continue
    if (item.dedupeKey) seenKeys.add(item.dedupeKey)
    restored.push(item)
    if (restored.length === MAX_NOTIFICATIONS) break
  }
  return restored
}

export function addNotificationToState(
  notifications: readonly Notification[],
  input: NotificationInput
): Notification[] {
  if (input.type === 'todo') return [...notifications]
  const dedupeKey = input.dedupeKey?.trim() || undefined
  const notification: Notification = {
    ...input,
    ...(dedupeKey ? { dedupeKey } : {}),
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    timestamp: new Date(),
    read: false
  }
  return [
    notification,
    ...notifications.filter((existing) => !dedupeKey || existing.dedupeKey !== dedupeKey)
  ].slice(0, MAX_NOTIFICATIONS)
}
