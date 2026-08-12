// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NOTIFICATION_STORAGE_KEY } from './notification-state'
import { NotificationProvider } from './NotificationProvider'
import { useNotifications } from './useNotifications'

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>()
  get length(): number {
    return this.data.size
  }
  clear(): void {
    this.data.clear()
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value)
  }
}

const originalStorage = globalThis.localStorage

function NotificationHarness(): React.JSX.Element {
  const { notifications, unreadCount, addNotification } = useNotifications()
  const add = (message: string, dedupeKey: string): void => {
    addNotification({
      type: 'approval',
      title: 'Approval needed',
      message,
      dedupeKey,
      target: { namespace: 'synthetic.domain', kind: 'record', recordId: 42 }
    })
  }
  return (
    <div>
      <button onClick={() => add('first payload', 'synthetic.domain:record:42')}>Add first</button>
      <button onClick={() => add('updated payload', 'synthetic.domain:record:42')}>
        Add updated
      </button>
      <button onClick={() => add('second record', 'synthetic.domain:record:43')}>
        Add distinct
      </button>
      <output aria-label="notification count">{notifications.length}</output>
      <output aria-label="unread count">{unreadCount}</output>
      <ul>
        {notifications.map((notification) => (
          <li key={notification.id}>{notification.message}</li>
        ))}
      </ul>
    </div>
  )
}

const renderHarness = (): void => {
  render(
    <NotificationProvider>
      <NotificationHarness />
    </NotificationProvider>
  )
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage()
  })
})

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: originalStorage
  })
})

describe('NotificationProvider target deduplication', () => {
  it('replaces a live duplicate target with its newest payload', async () => {
    const user = userEvent.setup()
    renderHarness()

    await user.click(screen.getByRole('button', { name: 'Add first' }))
    await user.click(screen.getByRole('button', { name: 'Add updated' }))

    expect(screen.getByLabelText('notification count').textContent).toBe('1')
    expect(screen.getByLabelText('unread count').textContent).toBe('1')
    expect(screen.queryByText('first payload')).toBeNull()
    expect(screen.getByText('updated payload')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Add distinct' }))
    expect(screen.getByLabelText('notification count').textContent).toBe('2')
  })

  it('collapses persisted duplicates while keeping the newest target record', () => {
    // 'approval', not 'todo': a todo is deliberately not kept as a notification at all - restore and add
    // both drop it (notification-state.ts), because a to-do lives in the to-do list and mirroring it into
    // the bell would tell the user the same thing twice. Seeding todos made this read as "persisted
    // notifications are lost", when what it proved was that todos are never persisted.
    localStorage.setItem(
      NOTIFICATION_STORAGE_KEY,
      JSON.stringify([
        {
          id: 'new',
          type: 'approval',
          title: 'Approval',
          message: 'newest persisted payload',
          timestamp: '2026-07-17T12:00:00.000Z',
          read: false,
          dedupeKey: 'synthetic.domain:record:42'
        },
        {
          id: 'old',
          type: 'approval',
          title: 'Approval',
          message: 'stale persisted payload',
          timestamp: '2026-07-17T11:00:00.000Z',
          read: true,
          dedupeKey: 'synthetic.domain:record:42'
        }
      ])
    )

    renderHarness()

    expect(screen.getByLabelText('notification count').textContent).toBe('1')
    expect(screen.getByText('newest persisted payload')).toBeTruthy()
    expect(screen.queryByText('stale persisted payload')).toBeNull()
  })
})
