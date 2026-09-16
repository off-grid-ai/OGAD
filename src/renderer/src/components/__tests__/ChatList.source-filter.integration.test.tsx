// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatList } from '../ChatList'

interface Session {
  session_id: string
  last_activity: string
  memory_count: number
  entity_count: number
  summary: string | null
}

describe('<ChatList/> source filtering', () => {
  afterEach(() => cleanup())

  it('keeps the selected source when the previous source finishes last', async () => {
    const pending: Array<{
      source: string
      resolve: (sessions: Session[]) => void
    }> = []
    const api = {
      getChatSessions: (source = 'All') =>
        new Promise<Session[]>((resolve) => pending.push({ source, resolve }))
    }
    ;(window as unknown as { api: typeof api }).api = api
    const user = userEvent.setup()

    render(<ChatList onSelectSession={() => {}} />)
    await waitFor(() => expect(pending.some(({ source }) => source === 'All')).toBe(true))

    await user.click(screen.getByRole('button', { name: 'Claude' }))
    await waitFor(() => expect(pending.some(({ source }) => source === 'Claude')).toBe(true))

    await act(async () => {
      pending
        .find(({ source }) => source === 'Claude')!
        .resolve([
          {
            session_id: 'Claude-current-conversation',
            last_activity: '2026-09-15 12:00:00',
            memory_count: 1,
            entity_count: 1,
            summary: null
          }
        ])
    })
    expect(await screen.findByText('Current conversation')).toBeTruthy()

    await act(async () => {
      pending
        .find(({ source }) => source === 'All')!
        .resolve([
          {
            session_id: 'ChatGPT-stale-conversation',
            last_activity: '2026-09-15 11:00:00',
            memory_count: 0,
            entity_count: 0,
            summary: null
          }
        ])
    })
    expect(screen.getByText('Current conversation')).toBeTruthy()
    expect(screen.queryByText('Stale conversation')).toBeNull()
  })
})
