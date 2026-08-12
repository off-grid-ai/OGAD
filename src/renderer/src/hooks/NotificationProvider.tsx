import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  addNotificationToState,
  NOTIFICATION_STORAGE_KEY,
  restoreNotifications,
  type Notification,
  type NotificationInput
} from './notification-state'
import { NotificationContext } from './useNotifications'

export function NotificationProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [notifications, setNotifications] = useState<Notification[]>(() => {
    try {
      const stored = localStorage.getItem(NOTIFICATION_STORAGE_KEY)
      if (stored) return restoreNotifications(JSON.parse(stored))
    } catch (error) {
      console.error('Failed to load notifications from storage:', error)
    }
    return []
  })

  useEffect(() => {
    setNotifications((current) => current.filter((notification) => notification.type !== 'todo'))
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(notifications))
    } catch (error) {
      console.error('Failed to save notifications:', error)
    }
  }, [notifications])

  const addNotification = useCallback((notification: NotificationInput) => {
    setNotifications((current) => addNotificationToState(current, notification))
  }, [])

  const markAsRead = useCallback((id: string) => {
    setNotifications((current) =>
      current.map((notification) =>
        notification.id === id ? { ...notification, read: true } : notification
      )
    )
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications((current) => current.map((notification) => ({ ...notification, read: true })))
  }, [])

  const clearNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
  }, [])

  const unreadCount = notifications.filter((notification) => !notification.read).length

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        addNotification,
        markAsRead,
        markAllAsRead,
        clearNotification,
        clearAll
      }}
    >
      {children}
    </NotificationContext.Provider>
  )
}
